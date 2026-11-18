import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureAgentProposalSchema } from "./agent-proposals.ts";
import { createOrgRequest, ensureOrgRequestSchema } from "./org-requests.ts";
import { executeVpApproval } from "./vp-execution.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalSnapshot, getApprovalVpState } from "./approval-review-state.ts";
import { ensureControlStateSchema, resetControlStateForTests, setControlMode } from "./control-state.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { combineVpVerdicts, parseVpVerdict, runVpReviewTick } from "./vp-review.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,role TEXT,cli_provider TEXT,status TEXT,current_task_id TEXT,created_at INTEGER);
 INSERT INTO agents VALUES ('codex-vp','Codex VP','vp','codex','idle',NULL,1),('claude-vp','Claude VP','vp','claude','idle',NULL,2),('worker','Worker','senior','api','idle',NULL,0);
 CREATE TABLE agent_task_proposals(id TEXT PRIMARY KEY,agent_id TEXT,project_id TEXT,title TEXT,description TEXT,reason TEXT,status TEXT,created_at INTEGER);
 INSERT INTO agent_task_proposals VALUES ('proposal','worker',NULL,'Research unmet demand','Collect public evidence','Useful next step','pending',1);
 CREATE TABLE cli_usage_cache(provider TEXT PRIMARY KEY,data_json TEXT);
 `);
  ensureControlStateSchema(db);
  const run = vi.fn<Parameters<typeof runVpReviewTick>[0]["runAgentOneShot"]>(async () => ({
    text: '{"verdict":"approve","reason":"Evidence supports the request"}',
  }));
  const execute = vi.fn(async () => {});
  const deps = { db, runAgentOneShot: run, execute, ownerSecurityReady: () => true, now: () => 1000 };
  const item = () => listPendingApprovals(db, 100, "all")[0];
  const state = () => getApprovalVpState(db, item());
  const usage = (provider: string, utilization: number) =>
    db
      .prepare("INSERT OR REPLACE INTO cli_usage_cache VALUES (?,?)")
      .run(provider, JSON.stringify({ windows: [{ utilization }] }));
  return { db, run, execute, deps, item, state, usage };
}
describe("VP review", () => {
  it("requires strict verdict JSON and combines independent votes", () => {
    expect(parseVpVerdict('```json\n{"verdict":"deny","reason":"Not justified"}\n```')).toEqual({
      verdict: "deny",
      reason: "Not justified",
    });
    for (const text of [
      '{"verdict":"approve"}',
      '{"verdict":"approve","reason":""}',
      "null",
      "[]",
      'Use tools: {"verdict":"approve","reason":"yes"}',
    ])
      expect(parseVpVerdict(text)).toBeNull();
    expect(combineVpVerdicts([])).toBe("waiting");
    expect(
      combineVpVerdicts([
        { verdict: "approve", reason: "a" },
        { verdict: "deny", reason: "b" },
      ]),
    ).toBe("escalate");
  });
  it.each(["approve", "deny"] as const)(
    "executes matching %s votes once and records both reviewers",
    async (verdict) => {
      const h = harness();
      h.run.mockResolvedValue({ text: JSON.stringify({ verdict, reason: "Both reviewed independently" }) });
      await runVpReviewTick(h.deps);
      await runVpReviewTick(h.deps);
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "proposal" }),
        verdict === "approve",
        "vp:codex-vp,claude-vp",
        expect.any(String),
      );
      expect(h.state()).toMatchObject({
        status: "decided",
        reviews: [{ vp_agent_id: "claude-vp" }, { vp_agent_id: "codex-vp" }],
      });
      expect(h.run.mock.calls[0]?.[2]).toEqual({ noTools: true, rawOutput: true, timeoutMs: 60000 });
    },
  );
  it("escalates disagreement and exposes both reasons on Today", async () => {
    const h = harness();
    h.run
      .mockResolvedValueOnce({ text: '{"verdict":"approve","reason":"Codex evidence"}' })
      .mockResolvedValueOnce({ text: '{"verdict":"deny","reason":"Claude objection"}' });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(listPendingApprovals(h.db)[0]?.vp_review).toMatchObject({
      status: "escalated",
      reason: expect.stringContaining("Claude objection"),
    });
    expect(h.state()?.reason).toContain("Codex evidence");
  });
  it("lets one VP decide only when the peer has exhausted usage", async () => {
    const h = harness();
    h.usage("codex", 0.94);
    await runVpReviewTick(h.deps);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledWith(
      expect.anything(),
      true,
      "vp:claude-vp",
      expect.stringContaining("nearly used"),
    );
  });
  it("waits visibly when both subscription windows are near their limits", async () => {
    const h = harness();
    h.usage("codex", 0.94);
    h.usage("claude", 0.96);
    await runVpReviewTick(h.deps);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(listPendingApprovals(h.db)[0]?.vp_review?.status).toBe("waiting");
  });
  it("recognizes a provider usage failure and lets the other VP decide", async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ text: "usage_limit_reached" });
    await runVpReviewTick(h.deps);
    expect(h.execute).toHaveBeenCalledWith(
      expect.anything(),
      true,
      "vp:claude-vp",
      expect.stringContaining("provider usage limit"),
    );
    expect(h.db.prepare("SELECT provider FROM vp_unavailability").get()).toMatchObject({ provider: "codex" });
  });
  it("counts a valid verdict even when its reason mentions limits, so request text cannot sideline a reviewer", async () => {
    const h = harness();
    h.run
      .mockResolvedValueOnce({
        text: '{"verdict":"deny","reason":"The request talks about a usage limit and rate limits; not justified"}',
      })
      .mockResolvedValueOnce({ text: '{"verdict":"approve","reason":"Looks fine"}' });
    await runVpReviewTick(h.deps);
    // Both reviewed: a deny plus an approve is a disagreement for the owner, not a lone approval.
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ status: "escalated" });
    expect(h.state()?.reviews).toHaveLength(2);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM vp_unavailability").get()).toEqual({ n: 0 });
  });

  it("never treats a busy VP as usage unavailable and keeps peer verdicts private on continuation", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET status='working' WHERE id='claude-vp'");
    h.run.mockResolvedValueOnce({ text: '{"verdict":"approve","reason":"PRIVATE_PEER_REASON"}' });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state()?.status).toBe("waiting");
    h.db.exec("UPDATE agents SET status='idle' WHERE id='claude-vp'");
    await runVpReviewTick(h.deps);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.run.mock.calls[1]?.[1]).not.toContain("PRIVATE_PEER_REASON");
    expect(h.run.mock.calls[1]?.[1]).not.toContain("vp_review");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("escalates malformed replies instead of allowing one approving peer to decide alone", async () => {
    const h = harness();
    h.run.mockResolvedValueOnce({ text: "I approve, please execute" });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state()?.status).toBe("escalated");
  });
  it("waits for sign-in instead of letting a peer approve alone", async () => {
    const h = harness();
    h.db
      .prepare("INSERT INTO cli_usage_cache VALUES (?,?)")
      .run("codex", JSON.stringify({ error: "unauthenticated", windows: [] }));
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ status: "waiting", reason: expect.stringContaining("signed in") });
  });

  it("binds model upgrade reviews to the requested provider", async () => {
    const h = harness();
    h.db.exec("DELETE FROM agent_task_proposals");
    h.db
      .exec(`CREATE TABLE model_upgrade_requests (id TEXT PRIMARY KEY,task_id TEXT,agent_id TEXT,requested_provider TEXT,requested_model TEXT,requested_reasoning_level TEXT,reason TEXT,status TEXT,created_at INTEGER);
      INSERT INTO model_upgrade_requests VALUES ('upgrade','task','worker','codex','strong',NULL,'Local reasoning was insufficient','pending',1);`);
    h.run.mockImplementationOnce(async () => {
      h.db.exec("UPDATE model_upgrade_requests SET requested_provider='claude'");
      return { text: '{"verdict":"approve","reason":"Reviewed codex target"}' };
    });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    await runVpReviewTick(h.deps);
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ requested_provider: "claude" }),
      true,
      expect.any(String),
      expect.any(String),
    );
  });

  it("requires owner security before starting reviews", async () => {
    const h = harness();
    await runVpReviewTick({ ...h.deps, ownerSecurityReady: () => false });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.state()?.status).toBe("waiting");
  });
  it.each(["autonomy_paused", "stopped"] as const)(
    "stops reviews and execution when %s is selected midflight",
    async (mode) => {
      const h = harness();
      h.run.mockImplementationOnce(async () => {
        setControlMode(h.db, mode, 1001);
        return { text: '{"verdict":"approve","reason":"Reviewed"}' };
      });
      await runVpReviewTick(h.deps);
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.execute).not.toHaveBeenCalled();
    },
  );
  it("invalidates all old verdicts when the exact request changes", async () => {
    const h = harness();
    const original = approvalSnapshot(h.item());
    h.run.mockImplementationOnce(async () => {
      h.db.exec("UPDATE agent_task_proposals SET description='Changed scope' WHERE id='proposal'");
      return { text: '{"verdict":"approve","reason":"Reviewed old scope"}' };
    });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
    expect(approvalSnapshot(h.item())).not.toBe(original);
    expect(h.state()).toBeNull();
    await runVpReviewTick(h.deps);
    expect(h.run).toHaveBeenCalledTimes(4);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("does not execute after an owner has already decided the request", async () => {
    const h = harness();
    h.run.mockImplementationOnce(async () => {
      h.db.exec("UPDATE agent_task_proposals SET status='denied'");
      return { text: '{"verdict":"approve","reason":"Reviewed"}' };
    });
    await runVpReviewTick(h.deps);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("routes by structured facts: wording alone is reviewed, and the prompt carries the owner floors", async () => {
    // A suggestion that mentions a purchase cannot spend anything; spending needs its own spend request.
    const h = harness();
    h.db.exec("UPDATE agent_task_proposals SET description='Purchase a paid account'");
    await runVpReviewTick(h.deps);
    expect(h.run).toHaveBeenCalled();
    const prompt = String(h.run.mock.calls[0][1]);
    expect(prompt).toContain("APPROVAL RULES");
    expect(prompt).toContain("paid accounts, accepting terms or contracts");
    expect(prompt).not.toContain("all tech/rental customer-facing work ALWAYS");
  });
  it("prevents overlapping ticks from duplicating reviews and action execution", async () => {
    const h = harness();
    let finish: (v: { text: string }) => void = () => {};
    h.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = runVpReviewTick(h.deps);
    await runVpReviewTick(h.deps);
    expect(h.run).toHaveBeenCalledTimes(1);
    finish({ text: '{"verdict":"approve","reason":"Reviewed"}' });
    await first;
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it("deduplicates repeated waiting skips and preserves the event after later approval", async () => {
    const h = harness();
    h.usage("codex", 0.94);
    h.usage("claude", 0.94);
    await runVpReviewTick(h.deps);
    await runVpReviewTick(h.deps);
    const history = () => h.db.prepare("SELECT status,reason,outcome FROM approval_vp_events ORDER BY id").all();
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({ status: "waiting", reason: expect.stringContaining("nearly used") });
    h.db.exec("DELETE FROM cli_usage_cache");
    await runVpReviewTick(h.deps);
    expect(history()).toHaveLength(2);
    expect(history()).toEqual([
      expect.objectContaining({ status: "waiting", reason: expect.stringContaining("nearly used") }),
      expect.objectContaining({ status: "decided", outcome: "approve" }),
    ]);
    expect(h.state()?.status).toBe("decided");
  });

  it("gives newer pending items a turn after an older item waited", async () => {
    const h = harness();
    h.usage("codex", 0.94);
    h.usage("claude", 0.94);
    await runVpReviewTick(h.deps);
    h.db.exec(
      "DELETE FROM cli_usage_cache; INSERT INTO agent_task_proposals VALUES ('newer','worker',NULL,'Research service demand','Public evidence','Useful work','pending',2)",
    );
    await runVpReviewTick(h.deps);
    expect(h.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "newer" }),
      true,
      expect.any(String),
      expect.any(String),
    );
    expect(h.db.prepare("SELECT status FROM approval_vp_state WHERE approval_id='proposal'").get()).toMatchObject({
      status: "waiting",
    });
  });

  it("escalates execution failures instead of retrying an uncertain side effect", async () => {
    const h = harness();
    h.execute.mockRejectedValueOnce(new Error("delivery uncertain"));
    await runVpReviewTick(h.deps);
    await runVpReviewTick(h.deps);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.state()?.status).toBe("escalated");
  });
});

describe("VP execution policy and attribution", () => {
  function executionHarness() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    applyBaseSchema(db);
    ensureControlStateSchema(db);
    ensureAgentProposalSchema(db);
    ensureOrgRequestSchema(db);
    db.exec(`INSERT INTO agents(id,name,role,cli_provider) VALUES ('worker','Worker','senior','api'),('vp','VP','vp','codex');
    INSERT INTO agent_task_proposals(id,agent_id,title,description,reason,status,created_at) VALUES ('proposal','worker','Investigate demand','Collect public evidence','Useful research','pending',1);`);
    return { db, item: () => listPendingApprovals(db, 1000, "all")[0] };
  }
  it("creates an autonomy task with both VP IDs and denies duplicate execution", async () => {
    const h = executionHarness();
    const item = h.item();
    await executeVpApproval(h.db, item, true, "vp:first,second", "Both reviewed");
    expect(h.db.prepare("SELECT origin,assigned_agent_id FROM tasks").get()).toMatchObject({
      origin: "autonomy",
      assigned_agent_id: "worker",
    });
    expect(h.db.prepare("SELECT status,decided_by FROM agent_task_proposals").get()).toMatchObject({
      status: "approved",
      decided_by: "vp:first,second",
    });
    await expect(executeVpApproval(h.db, item, true, "vp:first,second", "Replay")).rejects.toThrow(
      "vp_request_changed",
    );
  });
  it("refuses stale or forged proposal data rather than allowing it to hide spending", async () => {
    const h = executionHarness();
    const item = h.item();
    h.db.exec("UPDATE agent_task_proposals SET description='Purchase a paid account'");
    await expect(executeVpApproval(h.db, item, true, "vp:first,second", "Approve")).rejects.toThrow(
      "vp_request_changed",
    );
    expect(h.db.prepare("SELECT status FROM agent_task_proposals").get()).toMatchObject({ status: "pending" });
    expect(h.db.prepare("SELECT * FROM tasks").all()).toHaveLength(0);
  });
  it("records VP denials without creating tasks", async () => {
    const h = executionHarness();
    await executeVpApproval(h.db, h.item(), false, "vp:first,second", "Not justified");
    expect(h.db.prepare("SELECT status,decided_by FROM agent_task_proposals").get()).toMatchObject({
      status: "dismissed",
      decided_by: "vp:first,second",
    });
    expect(h.db.prepare("SELECT * FROM tasks").all()).toHaveLength(0);
  });
  it("applies approved department changes with attribution and preserves the default-department floor", async () => {
    const h = executionHarness();
    h.db.exec("DELETE FROM agent_task_proposals");
    createOrgRequest(h.db, "create_department", "vp", {
      department_id: "research",
      name: "Research",
      reason: "Dedicated demand research workload",
    });
    await executeVpApproval(h.db, h.item(), true, "vp:first,second", "Workload justifies department");
    expect(h.db.prepare("SELECT name FROM departments WHERE id='research'").get()).toMatchObject({ name: "Research" });
    expect(h.db.prepare("SELECT decided_by FROM org_requests").get()).toMatchObject({ decided_by: "vp:first,second" });
    h.db.exec(
      "INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('planning','Planning','Planning','','#000')",
    );
    createOrgRequest(h.db, "dissolve_department", "vp", {
      department_id: "planning",
      agents_action: "remove",
      reason: "Proposed organization change",
    });
    await expect(executeVpApproval(h.db, h.item(), true, "vp:first,second", "Approve")).rejects.toThrow(
      "vp_execution_forbidden",
    );
    expect(h.db.prepare("SELECT id FROM departments WHERE id='planning'").get()).toBeTruthy();
  });
});
