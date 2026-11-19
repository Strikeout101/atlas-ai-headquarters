import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunPerformanceTracker,
  createWorkerUsageCollector,
  ensureAgentPerformanceSchema,
  getAgentPerformanceSummary,
} from "./agent-performance.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_agent_id TEXT);
    CREATE TABLE task_model_routes (task_id TEXT, agent_id TEXT, provider TEXT, model TEXT);
    INSERT INTO tasks VALUES ('task','worker');
    INSERT INTO task_model_routes VALUES ('task','worker','api','qwen');`);
  ensureAgentPerformanceSchema(db);
  return db;
}

describe("worker performance", () => {
  it("records Antigravity's terminal usage envelope", () => {
    const usage = createWorkerUsageCollector();
    usage.ingest('{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":42,"output_tokens":9}}}\n');
    expect(usage.finish()).toEqual({ input_tokens: 42, output_tokens: 9, cost_usd: null });
  });
  it("snapshots actual routed provider/model and counts success, failures and retries once", () => {
    const db = setup();
    const first = createRunPerformanceTracker(db, "task", { provider: "opencode", model: "wrapper/qwen" });
    first.ingest('{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":24}}\n');
    first.finish(1);
    first.finish(0);
    const second = createRunPerformanceTracker(db, "task", { provider: "opencode" });
    second.finish(0);
    const summary = getAgentPerformanceSummary(db);
    expect(summary).toEqual([
      {
        agent_id: "worker",
        provider: "api",
        model: "qwen",
        runs: 2,
        successes: 1,
        failures: 1,
        cancelled: 0,
        success_rate: 0.5,
        rework_runs: 1,
        cost_usd: null,
        cost_reported_runs: 0,
        input_tokens: 120,
        output_tokens: 24,
      },
    ]);
    expect(getAgentPerformanceSummary(db, { agentId: "someone-else" })).toEqual([]);
    expect(getAgentPerformanceSummary(db, { provider: "codex" })).toEqual([]);
    expect(getAgentPerformanceSummary(db, { model: "qwen" })).toHaveLength(1);
    ensureAgentPerformanceSchema(db);
    expect(getAgentPerformanceSummary(db)).toEqual(summary);
  });

  it("excludes cancelled/running work from success denominator and distinguishes unknown from zero cost", () => {
    const db = setup();
    createRunPerformanceTracker(db, "task", { provider: "api" }).finish(1, true);
    expect(getAgentPerformanceSummary(db)[0]).toMatchObject({ cancelled: 1, success_rate: null, cost_usd: null });
    const second = createRunPerformanceTracker(db, "task", { provider: "api" });
    second.ingest('{"type":"result","usage":{"input_tokens":0,"output_tokens":0},"total_cost_usd":0}');
    second.finish(0);
    createRunPerformanceTracker(db, "task", { provider: "api" });
    expect(getAgentPerformanceSummary(db)[0]).toMatchObject({
      runs: 3,
      successes: 1,
      cancelled: 1,
      success_rate: 1,
      cost_usd: 0,
      cost_reported_runs: 1,
    });
  });

  it("retains attribution when assignment and route change between attempts", () => {
    const db = setup();
    const run = createRunPerformanceTracker(db, "task", { provider: "api" });
    db.exec(
      "UPDATE tasks SET assigned_agent_id='other'; UPDATE task_model_routes SET agent_id='other', provider='codex', model='gpt'",
    );
    run.finish(0);
    createRunPerformanceTracker(db, "task", { provider: "codex" }).finish(1);
    expect(getAgentPerformanceSummary(db, { agentId: "worker" })[0]).toMatchObject({
      provider: "api",
      model: "qwen",
      successes: 1,
    });
    expect(getAgentPerformanceSummary(db, { agentId: "other" })[0]).toMatchObject({
      provider: "codex",
      model: "gpt",
      failures: 1,
      rework_runs: 1,
    });
  });

  it("allows schema-free harnesses without fabricating metrics", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const tracker = createRunPerformanceTracker(db, "absent", { provider: "codex" });
    tracker.finish(0);
    expect(getAgentPerformanceSummary(db)).toEqual([]);
  });

  it("honors an HTTP account's actual model rather than a task route", () => {
    const db = setup();
    createRunPerformanceTracker(db, "task", {
      provider: "copilot",
      model: "account-override",
      useTaskRoute: false,
    }).finish(0);
    expect(getAgentPerformanceSummary(db)[0]).toMatchObject({ provider: "copilot", model: "account-override" });
  });
});

describe("structured worker usage", () => {
  it("collects split Claude result events once without charging streamed text", () => {
    const usage = createWorkerUsageCollector();
    usage.ingest('{"type":"assistant","message":{"usage":{"input_tokens":10}}}\n{"type":"res');
    usage.ingest('ult","usage":{"input_tokens":100,"output_tokens":50},"total_cost_usd":0.017}\n');
    expect(usage.finish()).toEqual({ input_tokens: 100, output_tokens: 50, cost_usd: 0.017 });
  });

  it("sums OpenCode steps, deduplicates ids and ignores invalid amounts", () => {
    const usage = createWorkerUsageCollector();
    const step = JSON.stringify({
      type: "step_finish",
      part: { id: "one", type: "step-finish", tokens: { input: 15, output: 4 }, cost: 0.1 },
    });
    usage.ingest(`${step}\n${step}\n`);
    usage.ingest('{"type":"step_finish","part":{"id":"two","tokens":{"input":20,"output":5},"cost":0.2}}\n');
    usage.ingest('{"type":"step_finish","part":{"id":"bad","tokens":{"input":-1,"output":"999"},"cost":-5}}');
    const totals = usage.finish();
    expect(totals.input_tokens).toBe(35);
    expect(totals.output_tokens).toBe(9);
    expect(totals.cost_usd).toBeCloseTo(0.3);
  });

  it("sums Codex turns and leaves unreported monetary cost unknown", () => {
    const usage = createWorkerUsageCollector();
    usage.ingest('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}\n');
    usage.ingest('{"type":"turn.completed","usage":{"input_tokens":150,"output_tokens":20}}\n');
    expect(usage.finish()).toEqual({ input_tokens: 250, output_tokens: 30, cost_usd: null });
  });
});
