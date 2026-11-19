/**
 * Real-model check of the Etsy playbook start (section E). Uses a fresh disposable database, never the live one.
 * One real VP planning call (Claude by default, or Codex): given a ventures revenue goal and one Etsy idea with evidence, does the planner
 * queue work for it, and does that start the playbook's first step (build) through the normal queue?
 *
 *   pnpm exec tsx scripts/qa/etsy-playbook-planner.ts --run [--provider codex|claude]
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../../server/modules/bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../server/modules/bootstrap/schema/task-schema-migrations.ts";
import { ensureControlStateSchema } from "../../server/modules/control-state.ts";
import { ensureAutonomyEngineSchema, usageHeadroomBlockReason } from "../../server/modules/autonomy-engine.ts";
import { runVpPlanningTick } from "../../server/modules/autonomy-planner.ts";
import { createCredentialTools } from "../../server/modules/workflow/agents/providers/credential-tools.ts";
import { createUsageCliTools } from "../../server/modules/workflow/agents/providers/usage-cli-tools.ts";
import { createProcessTools } from "../../server/modules/workflow/agents/providers/process-tools.ts";
import { createCliTools } from "../../server/modules/workflow/core/cli-tools.ts";
import { createOneShotRunner } from "../../server/modules/workflow/core/one-shot-runner.ts";
import { prettyStreamJson } from "../../server/modules/routes/ops/terminal/pretty-stream-json.ts";
import type { AgentRow, OneShotRunOptions } from "../../server/modules/workflow/core/conversation-types.ts";

if (!process.argv.includes("--run")) throw new Error("Use --run to authorize one real subscription model call.");
const provider = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : "claude";
if (provider !== "claude" && provider !== "codex") throw new Error("--provider must be claude or codex");
const root = path.resolve(import.meta.dirname, "../..");
const runDir = path.join(root, ".tmp", "etsy-playbook-planner", randomUUID());
fs.mkdirSync(runDir, { recursive: true });
const db = new DatabaseSync(path.join(runDir, "planner.sqlite"));
const unexpected = async () => {
  throw new Error("Unexpected non-CLI transport");
};
const evidence: Record<string, unknown> = { runDir, started_at: new Date().toISOString() };
try {
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureControlStateSchema(db);
  ensureAutonomyEngineSchema(db);
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('planning','Planning','','','#777'),('design','Design','','','#777');
    INSERT INTO agents(id,name,role,cli_provider,department_id) VALUES
      ('lead-p','Planning lead','team_leader','claude','planning'), ('lead-d','Design lead','team_leader','claude','design'),
      ('vp','Planning VP','vp','${provider}',NULL);`);
  db.prepare(
    "INSERT INTO projects(id,name,project_path,core_goal,business) VALUES ('shop','Ventures Etsy shop',?,?,'ventures')",
  ).run(runDir, "Sell original printable digital products on Etsy for the Ventures business.");
  const now = Date.now();
  db.prepare(
    "INSERT INTO business_goals(id,business,project_id,metric,target,currency,period_start,period_end,created_at,updated_at) VALUES ('goal','ventures','shop','verified_revenue',100,'USD',?,?,?,?)",
  ).run(now - 1000, now + 30 * 86_400_000, now, now);
  db.prepare(
    `INSERT INTO opportunities(id,business,project_id,goal_id,title,description,demand_score,revenue_score,cost_score,difficulty_score,time_to_launch_score,budget,status,playbook,created_at,updated_at)
     VALUES ('idea','ventures','shop','goal','Printable monthly budget planner (minimalist)',?,72,55,10,20,15,5,'idea','etsy_digital',?,?)`,
  ).run(
    "Evidence: Etsy search for 'budget planner printable' shows many listings with thousands of reviews and bestseller badges at USD 3-8; buyers want clean minimalist one-page PDFs in US Letter and A4. Product: an original one-page monthly budget planner PDF plus an editable version. Cost: our own design time; listing fee USD 0.20.",
    now,
    now,
  );
  const usage = createUsageCliTools(createCredentialTools());
  const reading = provider === "codex" ? await usage.fetchCodexUsage() : await usage.fetchClaudeUsage();
  db.prepare("INSERT OR REPLACE INTO cli_usage_cache(provider,data_json,updated_at) VALUES (?,?,?)").run(
    provider,
    JSON.stringify(reading),
    Date.now(),
  );
  evidence.usage = reading;
  evidence.headroom_block = usageHeadroomBlockReason(db, Date.now(), [provider]);
  if (evidence.headroom_block) throw new Error(`${provider} usage headroom blocks the run: ${evidence.headroom_block}`);
  const cli = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
  const runner = createOneShotRunner({
    logsDir: runDir,
    broadcast: () => {},
    getProviderModelConfig: () => ({
      claude: { model: "sonnet" },
      codex: { model: "gpt-6.1-sol", reasoningLevel: "low" },
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
    evidence.model_call = {
      agent: agent.id,
      elapsed_ms: Date.now() - started,
      error: response.error ?? null,
      text: response.text,
    };
    evidence.prompt_mentions_rules = prompt.includes("STOP RULES");
    return response;
  };
  await runVpPlanningTick({ db, runAgentOneShot, ownerSecurityReady: () => true });
  evidence.opportunity = db.prepare("SELECT status, playbook, playbook_stage FROM opportunities WHERE id='idea'").get();
  evidence.work = db.prepare("SELECT playbook_step, status, opportunity_id FROM autonomy_work").all();
  evidence.proposals = db.prepare("SELECT title, department_id FROM agent_task_proposals").all();
  evidence.ledger = db.prepare("SELECT event, message FROM autonomy_ledger ORDER BY id").all();
  const started = (evidence.work as Array<{ playbook_step: string }>).some((w) => w.playbook_step === "build");
  evidence.result = started ? "playbook_started" : "planner_queued_nothing_for_the_idea";
  console.log(
    JSON.stringify(
      { result: evidence.result, opportunity: evidence.opportunity, proposals: evidence.proposals },
      null,
      2,
    ),
  );
} finally {
  evidence.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  db.close();
}
