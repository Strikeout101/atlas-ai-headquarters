/** Routes one disposable documentation task to the configured local host and runs its real tool worker. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../../server/modules/bootstrap/schema/base-schema.ts";
import { ensureControlStateSchema } from "../../server/modules/control-state.ts";
import { ensureModelRoutingSchema, routeTaskModel } from "../../server/modules/model-routing.ts";
import { createApiProviderTools } from "../../server/modules/workflow/agents/providers/api-provider-tools.ts";
import { createCliTools } from "../../server/modules/workflow/core/cli-tools.ts";
import { createProcessTools } from "../../server/modules/workflow/agents/providers/process-tools.ts";
import { createCliRuntimeTools } from "../../server/modules/workflow/agents/cli-runtime.ts";

if (!process.argv.includes("--run")) throw new Error("Use --run to authorize a real local model task.");
const root = path.resolve(import.meta.dirname, "../..");
const runDir = path.join(root, ".tmp", "ollama-real-worker", randomUUID());
fs.mkdirSync(runDir, { recursive: true });
execFileSync("git", ["init", "--quiet", runDir], { stdio: "pipe" });
// A diagnostic must not contend with or modify the owner's OpenCode session history.
process.env.OPENCODE_DB = path.join(runDir, "opencode.sqlite");
const db = new DatabaseSync(path.join(runDir, "cycle.sqlite"));
const live = new DatabaseSync(path.join(root, "claw-empire.sqlite"), { readOnly: true });
const evidence: Record<string, unknown> = { started_at: new Date().toISOString(), runDir };
let child: ChildProcess | undefined;
try {
  const provider = live
    .prepare("SELECT * FROM api_providers WHERE type='ollama' AND enabled=1 ORDER BY created_at LIMIT 1")
    .get() as Record<string, any> | undefined;
  assert.ok(provider, "No configured enabled Ollama host");
  const cached = JSON.parse(provider.models_cache || "[]") as string[];
  assert.ok(cached.length, "Configured local host has no cached models");
  evidence.provider_name = provider.name;
  evidence.model = cached[0];
  const health = await fetch(`${String(provider.base_url).replace(/\/$/, "")}/models`, {
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(health.status, 200);
  applyBaseSchema(db);
  ensureControlStateSchema(db);
  ensureModelRoutingSchema(db);
  const columns = Object.keys(provider);
  db.prepare(`INSERT INTO api_providers(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(
    ...columns.map((key) => provider[key]),
  );
  db.exec(
    "INSERT INTO agents(id,name,role,cli_provider) VALUES ('worker','Local verification worker','senior','codex'); INSERT INTO tasks(id,title,description,assigned_agent_id,task_type,status) VALUES ('local-task','Write local proof','Write proof.txt containing LOCAL_WORKER_OK','worker','documentation','in_progress')",
  );
  db.prepare("INSERT INTO settings(key,value) VALUES ('localModelRouting',?)").run(
    JSON.stringify({
      enabled: true,
      apiProviderId: provider.id,
      model: cached[0],
      taskTypes: ["documentation"],
      contextWindowTokens: 4096,
    }),
  );
  const route = await routeTaskModel(db, "local-task", async () => {
    throw new Error("Local route must not call a subscription director");
  });
  assert.equal(route?.provider, "api");
  assert.equal(route?.api_provider_id, provider.id);
  evidence.route = { provider: route.provider, model: route.model, reason: route.reason };
  fs.writeFileSync(
    path.join(runDir, "AGENTS.md"),
    "This is an isolated verification workspace. Only create proof.txt here. Do not read or modify anything outside this directory. Do not run git commit, git push, web requests or install packages.\n",
  );
  const cli = createCliTools({ nowMs: Date.now, cliOutputDedupWindowMs: 0 });
  const { killPidTree } = createProcessTools({ db, nowMs: Date.now });
  const activeProcesses = new Map<string, ChildProcess>();
  const logPath = path.join(runDir, "worker.log");
  const runtime = createCliRuntimeTools({
    db,
    logsDir: runDir,
    ...cli,
    broadcast: () => {},
    killPidTree,
    TASK_RUN_IDLE_TIMEOUT_MS: 120000,
    TASK_RUN_HARD_TIMEOUT_MS: 175000,
    appendTaskLog: () => {},
    createSubtaskFromCli: () => {},
    completeSubtaskFromCli: () => {},
    activeProcesses,
  });
  const completion = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (child?.pid) killPidTree(child.pid);
      reject(new Error("Local worker timed out after 180s"));
    }, 180000);
    const finish = (code: number) => {
      clearTimeout(timeout);
      resolve(code);
    };
    const tools = createApiProviderTools({
      db,
      logsDir: runDir,
      activeProcesses,
      broadcast: () => {},
      normalizeStreamChunk: cli.normalizeStreamChunk,
      handleTaskRunComplete: (_id, code) => finish(code),
      killPidTree,
      spawnCliAgent: (_id, providerName, prompt, cwd, targetLog, model, reasoning, extraEnv, observe) => {
        child = runtime.spawnCliAgent(_id, providerName, prompt, cwd, targetLog, model, reasoning, extraEnv, observe);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        return child;
      },
      createSafeLogStreamOps: () => {
        throw new Error("Unexpected API stream transport");
      },
      parseSSEStream: async () => {
        throw new Error("Unexpected API stream transport");
      },
      parseGeminiSSEStream: async () => {
        throw new Error("Unexpected Google transport");
      },
    });
    tools.launchApiProviderAgent(
      "local-task",
      null,
      null,
      "Use the shell tool to create proof.txt in the current directory containing exactly LOCAL_WORKER_OK followed by a newline. Then reply done. Do not read other directories or use network. Do not commit or push.",
      runDir,
      logPath,
      new AbortController(),
      9001,
      finish,
    );
  });
  evidence.exit_code = await completion;
  assert.equal(evidence.exit_code, 0);
  assert.equal(fs.readFileSync(path.join(runDir, "proof.txt"), "utf8").trim(), "LOCAL_WORKER_OK");
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  evidence.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  db.close();
  live.close();
  console.log(
    JSON.stringify({ pass: evidence.pass, failure: evidence.failure, evidence: path.join(runDir, "evidence.json") }),
  );
}
