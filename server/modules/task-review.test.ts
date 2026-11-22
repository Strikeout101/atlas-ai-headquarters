import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { resetControlStateForTests, setControlMode, ensureControlStateSchema } from "./control-state.ts";
import { saveHandoff } from "./work-model.ts";
import {
  ensureReviewSchema,
  helperFinished,
  MAX_CHANGE_ROUNDS,
  parseVerdict,
  pickReviewer,
  resolveReviewByOwner,
  reviewPrompt,
  startReview,
  taskReviews,
  type ReviewDeps,
} from "./task-review.ts";

type Row = Record<string, any>;
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
beforeEach(() => resetControlStateForTests());
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  resetControlStateForTests();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureReviewSchema(db);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-review-"));
  dirs.push(folder);
  fs.writeFileSync(path.join(folder, "planner.pdf"), "%PDF fake");
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2),('qa','QA/QC','','','','','#000',3);
    INSERT INTO agents (id,name,role,department_id,cli_provider,created_at) VALUES
      ('design-lead','Iris','team_leader','design','codex',1),('design-senior','Bobby','senior','design','claude',2),
      ('qa-lead','Quinn','team_leader','qa','codex',3),('qa-senior','Rosa','senior','qa','claude',4),
      ('vp','Victor','vp',NULL,'claude',5);
  `);
  db.prepare(
    `INSERT INTO tasks (id,title,description,status,department_id,assigned_agent_id,work_type,work_folder,created_at,updated_at)
     VALUES ('t1','Make the planner','Make a 40-page wedding planner PDF.','review','design','design-lead','product',?,1,1)`,
  ).run(folder);
  saveHandoff(db, "t1", { summary: "Made planner.pdf, 40 pages, A4 and Letter.", files: ["planner.pdf"] });
  const replies: string[] = [];
  const runAgentOneShot = vi.fn<ReviewDeps["runAgentOneShot"]>(async () => ({ text: replies.shift() ?? "" }));
  const startTask = vi.fn<ReviewDeps["startTask"]>(async (taskId) => {
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
    return { ok: true };
  });
  const completeTask = vi.fn((taskId: string) => {
    db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(taskId);
  });
  const logs: string[] = [];
  const notifyOwner = vi.fn();
  const deps: ReviewDeps = {
    db,
    runAgentOneShot,
    startTask,
    completeTask,
    appendTaskLog: (_id, _kind, message) => logs.push(message),
    notifyOwner,
    now: () => 1000,
  };
  const task = () => db.prepare("SELECT * FROM tasks WHERE id='t1'").get() as Row;
  /** The agent finishes the requested changes and the task is back in review. */
  const redo = () => db.prepare("UPDATE tasks SET status='review' WHERE id='t1'").run();
  return { db, deps, replies, runAgentOneShot, startTask, completeTask, notifyOwner, logs, task, redo, folder };
}

const approve = (summary = "Looks right: 40 pages, both sizes.") =>
  JSON.stringify({ verdict: "approve", summary, items: [] });
const changes = (...items: string[]) => JSON.stringify({ verdict: "changes", summary: "Needs fixes.", items });

describe("choosing the reviewer", () => {
  it("picks the work type's department, on the other model, never the worker", () => {
    const h = harness();
    // Product work (Codex) → QA, the Claude member.
    expect(pickReviewer(h.db, h.task())).toMatchObject({
      department: "qa",
      sameModel: false,
      agent: { id: "qa-senior" },
    });
    h.db.exec("UPDATE tasks SET assigned_agent_id='design-senior' WHERE id='t1'");
    expect(pickReviewer(h.db, h.task())?.agent.id).toBe("qa-lead");
    // Design work made by Design is reviewed by QA, not by the same team.
    h.db.exec("UPDATE tasks SET work_type='design', assigned_agent_id='design-lead' WHERE id='t1'");
    expect(pickReviewer(h.db, h.task())).toMatchObject({ department: "qa", agent: { id: "qa-senior" } });
  });

  it("falls back to the same model and says so when nobody on the other model is free", () => {
    const h = harness();
    h.db.exec("UPDATE agents SET status='offline' WHERE cli_provider='claude'");
    const pick = pickReviewer(h.db, h.task())!;
    expect(pick).toMatchObject({ sameModel: true, agent: { id: "qa-lead" } });
    expect(reviewPrompt(h.deps, h.task(), pick, 1)).toContain("same model as the agent who did the work");
    h.db.exec("UPDATE agents SET status='offline'");
    expect(pickReviewer(h.db, h.task())).toBeNull();
  });
});

describe("the verdict", () => {
  it("reads only a structured verdict, the last one in the reply", () => {
    expect(parseVerdict(`I checked the files.\n${approve()}`)).toMatchObject({ verdict: "approve" });
    expect(parseVerdict('```json\n{"verdict":"changes","summary":"x","items":["Add the Letter size"]}\n```')).toEqual({
      verdict: "changes",
      summary: "x",
      items: ["Add the Letter size"],
    });
    expect(parseVerdict('{"verdict":"changes","items":[]}')).toBeNull(); // changes needs something to act on
    expect(parseVerdict("Approved, looks great!")).toBeNull(); // no keyword guessing
    expect(parseVerdict('{"verdict":"maybe","items":[]}')).toBeNull();
  });

  it("gives the reviewer the brief, hand-off, checklist and read-only files", async () => {
    const h = harness();
    h.replies.push(approve());
    await startReview(h.deps, "t1");
    const [agent, prompt, opts] = h.runAgentOneShot.mock.calls[0];
    expect(agent.id).toBe("qa-senior");
    expect(prompt).toContain("Make a 40-page wedding planner PDF.");
    expect(prompt).toContain("Made planner.pdf, 40 pages, A4 and Letter.");
    expect(prompt).toContain("The product files exist, open, and match the brief");
    expect(prompt).toContain("READ ONLY");
    expect(opts).toMatchObject({ readOnly: true, projectPath: h.folder, budgetTaskId: "t1" });
  });
});

describe("the review loop", () => {
  it("approves and completes the task", async () => {
    const h = harness();
    h.replies.push(approve());
    await startReview(h.deps, "t1");
    expect(h.completeTask).toHaveBeenCalledWith("t1", "Make the planner");
    expect(h.task()).toMatchObject({ status: "done", review_state: null });
    expect(taskReviews(h.db, "t1")).toEqual([
      expect.objectContaining({ round: 1, status: "approved", reviewer_agent_id: "qa-senior", same_model: false }),
    ]);
  });

  it("sends changes back to the same agent with the list, then reviews again with the earlier list", async () => {
    const h = harness();
    h.replies.push(changes("Add the Letter size", "Fix the typo on page 3"));
    await startReview(h.deps, "t1");
    expect(h.startTask).toHaveBeenCalledTimes(1);
    expect(h.startTask.mock.calls[0][1].id).toBe("design-lead");
    expect(h.task().description).toContain(
      "REVIEW ROUND 1 (Rosa) asked for changes:\n- Add the Letter size\n- Fix the typo on page 3",
    );
    expect(h.task().review_state).toBe("changes");
    h.redo();
    h.replies.push(approve());
    await startReview(h.deps, "t1");
    expect(h.runAgentOneShot.mock.calls[1][1]).toContain("EARLIER REVIEW ROUNDS asked for (check each was fixed)");
    expect(h.task().status).toBe("done");
  });

  it(`asks the VPs after ${MAX_CHANGE_ROUNDS} rounds of changes; their call is applied`, async () => {
    const h = harness();
    h.replies.push(changes("Add the Letter size"));
    await startReview(h.deps, "t1");
    h.redo();
    h.replies.push(changes("Letter size still missing"), '{"action":"accept","notes":"A4 is fine for launch"}');
    await startReview(h.deps, "t1");
    const vpCall = h.runAgentOneShot.mock.calls[2];
    expect(vpCall[0].id).toBe("vp");
    expect(vpCall[2]).toMatchObject({ noTools: true });
    expect(h.task().status).toBe("done");
    expect(h.logs.join("\n")).toContain("VPs accepted it as is: A4 is fine for launch");
  });

  it("lets the VPs reassign once; the next failure goes to the owner, who decides", async () => {
    const h = harness();
    h.replies.push(changes("Add the Letter size"));
    await startReview(h.deps, "t1");
    h.redo();
    h.replies.push(
      changes("Still missing"),
      '{"action":"reassign","notes":"Bobby knows the template","agent_id":"design-senior"}',
    );
    await startReview(h.deps, "t1");
    expect(h.task()).toMatchObject({ assigned_agent_id: "design-senior", review_state: "changes" });
    expect(h.task().description).toContain("VPs: Bobby knows the template");
    h.redo();
    // Bobby is Claude now, so the reviewer is QA's Codex member.
    h.replies.push(changes("Still missing after the reassign"));
    await startReview(h.deps, "t1");
    expect(h.runAgentOneShot.mock.calls.at(-1)![0].id).toBe("qa-lead");
    expect(h.task()).toMatchObject({ status: "review", review_state: "owner" });
    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    expect(h.notifyOwner.mock.calls[0][0]).toContain("needs your call");
    await startReview(h.deps, "t1"); // nothing happens while it waits for the owner
    expect(h.runAgentOneShot).toHaveBeenCalledTimes(4);
    await expect(resolveReviewByOwner(h.deps, "t1", { action: "maybe" })).rejects.toThrow("invalid_action");
    const done = await resolveReviewByOwner(h.deps, "t1", { action: "accept", notes: "Ship it" });
    expect(done.status).toBe("done");
    await expect(resolveReviewByOwner(h.deps, "t1", { action: "accept" })).rejects.toThrow(
      "review_not_waiting_for_owner",
    );
  });

  it("tries a second reviewer when the first gives no verdict, then escalates", async () => {
    const h = harness();
    h.replies.push("I think it's fine", "no json either", '{"action":"drop","notes":"Not needed any more"}');
    await startReview(h.deps, "t1");
    // The second reviewer is still on the other model (from the worker's own team) before a same-model one.
    expect(h.runAgentOneShot.mock.calls.map((c) => c[0].id)).toEqual(["qa-senior", "design-senior", "vp"]);
    expect(h.task().status).toBe("cancelled");
  });

  it("waits for helper tasks, then reviews when the last one finishes", async () => {
    const h = harness();
    h.db.exec(
      "INSERT INTO tasks (id,title,status,source_task_id,created_at,updated_at) VALUES ('helper','Render the cover','in_progress','t1',2,2)",
    );
    await startReview(h.deps, "t1");
    expect(h.runAgentOneShot).not.toHaveBeenCalled();
    expect(h.task().review_state).toBe("waiting_helpers");
    h.db.exec("UPDATE tasks SET status='done' WHERE id='helper'");
    saveHandoff(h.db, "helper", { summary: "Rendered the cover at 2000x1600 px." });
    h.replies.push(approve());
    await helperFinished(h.deps, "helper");
    expect(h.runAgentOneShot.mock.calls[0][1]).toContain("Rendered the cover at 2000x1600 px.");
    expect(h.task().status).toBe("done");
  });

  it("approves without a review when nobody else exists, and holds while runs are stopped", async () => {
    const h = harness();
    setControlMode(h.db, "stopped", 1);
    await startReview(h.deps, "t1");
    expect(h.task().status).toBe("review");
    resetControlStateForTests();
    h.db.exec("UPDATE agents SET status='offline'");
    await startReview(h.deps, "t1");
    expect(h.task().status).toBe("done");
    expect(h.logs.join("\n")).toContain("approved without a review");
  });
});
