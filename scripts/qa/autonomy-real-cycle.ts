/** Explicit, subscription-backed smoke run. Never opens or mutates the live ATLAS DB. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../../server/modules/bootstrap/schema/base-schema.ts";
import { ensureControlStateSchema } from "../../server/modules/control-state.ts";
import {
  ensureAutonomyEngineSchema,
  runAutonomyEngineTick,
  usageHeadroomBlockReason,
} from "../../server/modules/autonomy-engine.ts";
import { runVpPlanningTick } from "../../server/modules/autonomy-planner.ts";
import { runVpReviewTick } from "../../server/modules/vp-review.ts";
import { executeVpApproval } from "../../server/modules/vp-execution.ts";
import { autonomyOverview } from "../../server/modules/autonomy-store.ts";
import { createCredentialTools } from "../../server/modules/workflow/agents/providers/credential-tools.ts";
import { createUsageCliTools } from "../../server/modules/workflow/agents/providers/usage-cli-tools.ts";
import { createProcessTools } from "../../server/modules/workflow/agents/providers/process-tools.ts";
import { createCliTools } from "../../server/modules/workflow/core/cli-tools.ts";
import { createOneShotRunner } from "../../server/modules/workflow/core/one-shot-runner.ts";
import { prettyStreamJson } from "../../server/modules/routes/ops/terminal/pretty-stream-json.ts";
import { createReviewFinalizeTools } from "../../server/modules/workflow/orchestration/review-finalize-tools.ts";
import type { AgentRow, OneShotRunOptions } from "../../server/modules/workflow/core/conversation-types.ts";

if (!process.argv.includes("--run")) throw new Error("Use --run to authorize real subscription model calls.");
const root = path.resolve(import.meta.dirname, "../..");
const runDir = path.join(root, ".tmp", "autonomy-real-cycle", randomUUID());
fs.mkdirSync(runDir, { recursive: true });
const db = new DatabaseSync(path.join(runDir, "cycle.sqlite"));
const evidence: Record<string, unknown> = { runDir, started_at: new Date().toISOString(), model_calls: [] };
const calls = evidence.model_calls as Array<Record<string, unknown>>;
const noOp = () => {};
const unexpected = async () => {
  throw new Error("Unexpected non-CLI transport");
};
try {
  applyBaseSchema(db);
  db.exec(
    "ALTER TABLE tasks ADD COLUMN source_task_id TEXT; ALTER TABLE projects ADD COLUMN github_repo TEXT; ALTER TABLE projects ADD COLUMN business TEXT; ALTER TABLE subtasks ADD COLUMN delegated_task_id TEXT",
  );
  ensureControlStateSchema(db);
  ensureAutonomyEngineSchema(db);
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('verification','Internal verification','','','#777');
    INSERT INTO agents(id,name,role,cli_provider,department_id) VALUES
      ('leader','Verification worker','team_leader','claude','verification'),
      ('codex-vp','Codex VP','vp','codex',NULL), ('claude-vp','Claude VP','vp','claude',NULL);`);
  db.prepare(
    "INSERT INTO projects(id,name,project_path,core_goal,business) VALUES ('cycle','Isolated ventures internal smoke test',?,?,'ventures')",
  ).run(
    runDir,
    "Complete exactly one ventures internal verification task: compute 17 * 23 and return ONLY JSON with the numeric product field. This is a bounded ventures operations diagnostic using synthetic data. No tools, files, network, publishing, account changes or purchases. Suggest exactly one action for department verification to perform this calculation; no opportunities are needed. The harness records the response as the result.",
  );
  const now = Date.now();
  db.prepare(
    "INSERT INTO business_goals(id,business,project_id,metric,target,period_start,period_end,created_at,updated_at) VALUES ('goal','ventures','cycle','completed_tasks',1,?,?,?,?)",
  ).run(now - 1000, now + 3600000, now, now);
  const usage = createUsageCliTools(createCredentialTools());
  const readings = { codex: await usage.fetchCodexUsage(), claude: await usage.fetchClaudeUsage() };
  evidence.usage = readings;
  for (const [provider, entry] of Object.entries(readings))
    db.prepare("INSERT OR REPLACE INTO cli_usage_cache(provider,data_json,updated_at) VALUES (?,?,?)").run(
      provider,
      JSON.stringify(entry),
      Date.now(),
    );
  assert.equal(usageHeadroomBlockReason(db), null, "Real subscription usage must pass the unchanged headroom gate");
  const cli = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
  const runner = createOneShotRunner({
    logsDir: runDir,
    broadcast: noOp,
    getProviderModelConfig: () => ({
      codex: { model: "gpt-6.1-sol", reasoningLevel: "low" },
      claude: { model: "sonnet" },
    }),
    executeApiProviderAgent: unexpected,
    executeCopilotAgent: unexpected,
    executeAntigravityAgent: unexpected,
    killPidTree: createProcessTools({ db, nowMs: Date.now }).killPidTree,
    prettyStreamJson,
    getPreferredLanguage: () => "en",
    normalizeConversationReply: (raw: string) => prettyStreamJson(raw),
    ...cli,
  });
  const runAgentOneShot = async (agent: AgentRow, prompt: string, options: OneShotRunOptions) => {
    const started = Date.now();
    const response = await runner.runAgentOneShot(agent, prompt, { ...options, projectPath: runDir });
    calls.push({ agent: agent.id, provider: agent.cli_provider, elapsed_ms: Date.now() - started, response });
    console.log(JSON.stringify({ stage: "model_response", agent: agent.id, error: response.error ?? null }));
    return response;
  };
  await runVpPlanningTick({ db, runAgentOneShot, ownerSecurityReady: () => true });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM agent_task_proposals").get() as { n: number }).n,
    1,
    "Planner must produce one actual proposal",
  );
  evidence.proposal = db.prepare("SELECT * FROM agent_task_proposals").get();
  await runVpReviewTick({
    db,
    runAgentOneShot,
    ownerSecurityReady: () => true,
    execute: (item, approve, by, reason) => executeVpApproval(db, item, approve, by, reason),
  });
  const reviews = db.prepare("SELECT vp_agent_id,verdict,reason FROM approval_reviews").all();
  evidence.reviews = reviews;
  assert.equal(reviews.length, 2, "Both real VPs must review");
  assert.ok(
    reviews.every((r) => r.verdict === "approve"),
    "Both independent VPs must approve",
  );
  let workerCompleted = false;
  const engineDeps = {
    db,
    ownerSecurityReady: () => true,
    startTask: async (taskId: string, agent: Record<string, unknown>) => {
      const task = db.prepare("SELECT title,description FROM tasks WHERE id=?").get(taskId) as {
        title: string;
        description: string;
      };
      db.prepare("UPDATE tasks SET status='in_progress',started_at=? WHERE id=?").run(Date.now(), taskId);
      const reply = await runAgentOneShot(
        agent as AgentRow,
        `Perform the approved internal task. Do not use tools.\n${task.title}\n${task.description}\nReturn ONLY JSON with the numeric product field.`,
        { noTools: true, rawOutput: true, timeoutMs: 60000 },
      );
      assert.equal(reply.error, undefined);
      assert.equal(JSON.parse(reply.text).product, 391);
      fs.writeFileSync(path.join(runDir, "worker-result.json"), reply.text);
      db.prepare("UPDATE tasks SET status='review',result=?,updated_at=? WHERE id=?").run(
        reply.text,
        Date.now(),
        taskId,
      );
      // This diagnostic's completion oracle is exact arithmetic, not a simulated worker/model.
      const finalizer = createReviewFinalizeTools({
        db,
        nowMs: Date.now,
        broadcast: noOp,
        appendTaskLog: noOp,
        resolveLang: () => "en",
        l: (_ko: string[], en: string[]) => en,
        pickL: (pool: string[]) => pool[0],
        projectReviewGateNotifiedAt: new Map(),
        notifyCeo: noOp,
        taskWorktrees: new Map(),
        findTeamLeader: () => null,
        setTaskCreationAuditCompletion: noOp,
        endTaskExecutionSession: noOp,
        notifyTaskStatus: noOp,
        refreshCliUsageData: async () => ({}),
        shouldDeferTaskReportUntilPlanningArchive: () => false,
        emitTaskReportEvent: noOp,
        formatTaskSubtaskProgressSummary: () => "",
        reviewRoundState: new Map(),
        reviewInFlight: new Set(),
        archivePlanningConsolidatedReport: noOp,
        crossDeptNextCallbacks: new Map(),
        recoverCrossDeptQueueAfterMissingCallback: noOp,
        subtaskDelegationCallbacks: new Map(),
        startReviewConsensusMeeting: (_id: string, _title: string, _department: string, done: () => void) => done(),
      });
      finalizer.finishReview(taskId, task.title, {
        bypassProjectDecisionGate: true,
        trigger: "isolated_exact_result_verification",
      });
      assert.equal(
        (db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as { status: string }).status,
        "done",
      );
      workerCompleted = true;
    },
  };
  await runAutonomyEngineTick(engineDeps);
  assert.ok(workerCompleted, "Real worker was admitted and completed");
  await runAutonomyEngineTick(engineDeps);
  evidence.overview = autonomyOverview(db);
  assert.equal((db.prepare("SELECT status FROM autonomy_work").get() as { status: string }).status, "done");
  assert.equal((autonomyOverview(db).goals[0] as { progress: number }).progress, 1);
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  db.close();
  console.log(
    JSON.stringify({ pass: evidence.pass, failure: evidence.failure, evidence: path.join(runDir, "evidence.json") }),
  );
}
