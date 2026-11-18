import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "prepare">;
type Row = Record<string, unknown>;

export function ensureAgentPerformanceSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_worker_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled')),
    rework INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    exit_code INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_worker_runs_task ON agent_worker_runs(task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_agent_worker_runs_model ON agent_worker_runs(agent_id, provider, model);`);
}

export type AgentPerformanceSummary = {
  agent_id: string;
  provider: string;
  model: string;
  runs: number;
  successes: number;
  failures: number;
  cancelled: number;
  success_rate: number | null;
  rework_runs: number;
  cost_usd: number | null;
  cost_reported_runs: number;
  input_tokens: number | null;
  output_tokens: number | null;
};

/** Worker exit outcomes, not proof of a successful merge or verified business revenue. */
export function getAgentPerformanceSummary(
  db: Db,
  filter: { agentId?: string; provider?: string; model?: string } = {},
): AgentPerformanceSummary[] {
  const where: string[] = [];
  const values: string[] = [];
  for (const [column, value] of [
    ["agent_id", filter.agentId],
    ["provider", filter.provider],
    ["model", filter.model],
  ]) {
    if (value) {
      where.push(`${column} = ?`);
      values.push(value);
    }
  }
  try {
    return db
      .prepare(
        `SELECT agent_id, provider, model,
      COUNT(*) AS runs,
      SUM(status = 'succeeded') AS successes,
      SUM(status = 'failed') AS failures,
      SUM(status = 'cancelled') AS cancelled,
      CAST(SUM(status = 'succeeded') AS REAL) / NULLIF(SUM(status IN ('succeeded','failed')), 0) AS success_rate,
      SUM(rework) AS rework_runs,
      SUM(cost_usd) AS cost_usd,
      COUNT(cost_usd) AS cost_reported_runs,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens
      FROM agent_worker_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY agent_id, provider, model ORDER BY runs DESC, agent_id, provider, model LIMIT 200`,
      )
      .all(...values) as AgentPerformanceSummary[];
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table: agent_worker_runs")) return [];
    throw error;
  }
}

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Parse only structured provider usage. Never infer a dollar cost from tokens or subscription pricing. */
export function createWorkerUsageCollector() {
  let buffer = "";
  let input: number | null = null;
  let output: number | null = null;
  let cost: number | null = null;
  const steps = new Set<string>();
  const add = (previous: number | null, value: number | null) => (value === null ? previous : (previous ?? 0) + value);
  function line(raw: string) {
    let event: Row | null;
    try {
      event = object(JSON.parse(raw));
    } catch {
      return;
    }
    if (!event) return;
    const part = object(event.part) ?? object(object(event.properties)?.part);
    const type = String(part?.type ?? event.type ?? "");
    if (["step_finish", "step-finish"].includes(type)) {
      const source = part ?? event;
      const id = typeof source.id === "string" ? source.id : null;
      if (id && steps.has(id)) return;
      if (id) steps.add(id);
      const tokens = object(source.tokens) ?? object(source.usage);
      input = add(input, count(tokens?.input ?? tokens?.input_tokens));
      output = add(output, count(tokens?.output ?? tokens?.output_tokens));
      cost = add(cost, count(source.cost));
    } else if (event.type === "result") {
      // Claude's final result is cumulative for this invocation.
      const usage = object(event.usage);
      input = count(usage?.input_tokens);
      output = count(usage?.output_tokens);
      cost = count(event.total_cost_usd);
    } else if (event.type === "turn.completed") {
      const usage = object(event.usage);
      input = add(input, count(usage?.input_tokens));
      output = add(output, count(usage?.output_tokens));
    }
  }
  return {
    ingest(chunk: Buffer | string) {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const item of lines) if (item.length <= 512_000) line(item);
      if (buffer.length > 512_000) buffer = "";
    },
    finish() {
      if (buffer) line(buffer);
      buffer = "";
      return { input_tokens: input, output_tokens: output, cost_usd: cost };
    },
  };
}

/** Schema-free test harnesses can omit tracking; production initializes the table at startup. */
export function createRunPerformanceTracker(
  db: Db,
  taskId: string,
  execution: { provider: string; model?: string | null; agentId?: string | null; useTaskRoute?: boolean },
) {
  const usage = createWorkerUsageCollector();
  const id = randomUUID();
  let tracked = false;
  let finished = false;
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_worker_runs'").get();
    if (table) {
      const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | { assigned_agent_id: string | null }
        | undefined;
      let route: { provider: string; model: string } | undefined;
      try {
        if (execution.useTaskRoute !== false)
          route = db
            .prepare(
              `SELECT r.provider, r.model FROM task_model_routes r
          JOIN tasks t ON t.id = r.task_id AND t.assigned_agent_id = r.agent_id WHERE r.task_id = ?`,
            )
            .get(taskId) as typeof route;
      } catch {
        // Model routes are optional for workers using provider defaults.
      }
      const agentId = execution.agentId ?? task?.assigned_agent_id;
      if (agentId) {
        const prior = db.prepare("SELECT COUNT(*) AS count FROM agent_worker_runs WHERE task_id = ?").get(taskId) as {
          count: number;
        };
        db.prepare(
          `INSERT INTO agent_worker_runs
          (id, task_id, agent_id, provider, model, status, rework, started_at)
          VALUES (?,?,?,?,?,'running',?,?)`,
        ).run(
          id,
          taskId,
          agentId,
          route?.provider ?? execution.provider,
          route?.model ?? execution.model ?? "unknown",
          prior.count > 0 ? 1 : 0,
          Date.now(),
        );
        tracked = true;
      }
    }
  } catch (error) {
    console.warn(
      "[ATLAS] Worker performance tracking could not start:",
      error instanceof Error ? error.message : "database unavailable",
    );
  }
  return {
    ingest: usage.ingest,
    finish(exitCode: number, cancelled = false) {
      if (finished) return;
      finished = true;
      const totals = usage.finish();
      if (!tracked) return;
      try {
        db.prepare(
          `UPDATE agent_worker_runs SET status=?, finished_at=?, exit_code=?, input_tokens=?, output_tokens=?, cost_usd=?
          WHERE id=? AND status='running'`,
        ).run(
          cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
          Date.now(),
          exitCode,
          totals.input_tokens,
          totals.output_tokens,
          totals.cost_usd,
          id,
        );
      } catch (error) {
        console.warn(
          "[ATLAS] Worker performance tracking could not finish:",
          error instanceof Error ? error.message : "database unavailable",
        );
      }
    },
  };
}
