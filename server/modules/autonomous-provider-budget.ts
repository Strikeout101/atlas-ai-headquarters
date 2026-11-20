import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { configuredLocalTaskProvider, modelDirectorConfig } from "./model-routing.ts";

type Db = Pick<DatabaseSync, "prepare">;
type Execution = { provider?: string; apiProviderId?: string | null; invocationId?: string };
type Context = { providerId: string; limit: number };
type Reservation = { task_id: string; provider_id: string };
const PAID_API_BLOCK =
  "Autonomous paid or unclassified API calls are disabled; an owner-configured enforceable provider budget is required";

export class AutonomousProviderBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutonomousProviderBudgetError";
  }
}

function table(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function invocationDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function context(db: Db, taskId: string, execution: Execution): Context | string | null {
  const task = db.prepare("SELECT origin, assigned_agent_id FROM tasks WHERE id=?").get(taskId) as
    | { origin: string; assigned_agent_id: string | null }
    | undefined;
  if (!task) return "The provider invocation's attributed task no longer exists";
  if (task?.origin !== "autonomy") return null;
  if (!table(db, "autonomy_config")) return "Autonomous provider budget configuration is unavailable";
  const assigned = db
    .prepare("SELECT cli_provider,api_provider_id FROM agents WHERE id=?")
    .get(task.assigned_agent_id ?? "") as { cli_provider: string | null; api_provider_id: string | null } | undefined;
  const route = table(db, "task_model_routes")
    ? (db
        .prepare(
          `SELECT r.provider,r.api_provider_id FROM task_model_routes r
    JOIN tasks t ON t.id=r.task_id AND t.assigned_agent_id=r.agent_id WHERE r.task_id=?`,
        )
        .get(taskId) as { provider: string; api_provider_id: string | null } | undefined)
    : undefined;
  const local =
    !route && configuredLocalTaskProvider(db, taskId) === "api" ? modelDirectorConfig(db as any).localRouting : null;
  const provider = execution.provider
    ? execution.provider === "opencode" && route?.provider === "api"
      ? "api"
      : execution.provider
    : (route?.provider ?? (local ? "api" : null) ?? assigned?.cli_provider);
  if (provider !== "api") return null;
  const id = execution.apiProviderId ?? route?.api_provider_id ?? local?.apiProviderId ?? assigned?.api_provider_id;
  if (!id) return PAID_API_BLOCK;
  const api = db.prepare("SELECT type,enabled FROM api_providers WHERE id=?").get(id) as
    | { type: string; enabled: number }
    | undefined;
  if (api?.type !== "ollama" || !api.enabled) return PAID_API_BLOCK;
  const config = db.prepare("SELECT local_provider_daily_run_cap FROM autonomy_config WHERE id=1").get() as
    | { local_provider_daily_run_cap?: number }
    | undefined;
  if (!Number.isSafeInteger(config?.local_provider_daily_run_cap) || Number(config?.local_provider_daily_run_cap) < 0)
    return "Autonomous local provider invocation limit is not configured";
  if (!table(db, "autonomy_provider_invocations")) return "Autonomous provider budget storage is unavailable";
  return { providerId: id, limit: Number(config!.local_provider_daily_run_cap) };
}

/** Preview only; actual launches reserve their invocation atomically immediately before transport. */
export function autonomousProviderBudgetBlockReason(
  db: Db,
  taskId: string,
  now = Date.now(),
  execution: Execution = {},
): string | null {
  const ctx = context(db, taskId, execution);
  if (typeof ctx === "string" || ctx === null) return ctx;
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM autonomy_provider_invocations WHERE provider_id=? AND day=?")
    .get(ctx.providerId, invocationDay(now)) as { n: number };
  return count.n >= ctx.limit
    ? "Daily autonomous local provider invocation cap reached (includes retries and resumes)"
    : null;
}

/** One reservation per actual invocation. Failed launches remain charged; no cost is inferred from tokens. */
export function reserveAutonomyProviderInvocation(
  db: Db,
  taskId: string,
  execution: Execution = {},
  now = Date.now(),
): string | null {
  const ctx = context(db, taskId, execution);
  if (typeof ctx === "string" || ctx === null) return ctx;
  const invocation = execution.invocationId ?? randomUUID();
  const existing = db
    .prepare("SELECT task_id,provider_id FROM autonomy_provider_invocations WHERE invocation_id=?")
    .get(invocation) as Reservation | undefined;
  if (existing)
    return existing.task_id === taskId && existing.provider_id === ctx.providerId
      ? null
      : "Autonomous provider invocation identity changed";
  const day = invocationDay(now);
  // The conditional INSERT is a single write statement, so competing DB connections cannot oversubscribe the cap.
  const result = db
    .prepare(
      `INSERT INTO autonomy_provider_invocations(invocation_id,task_id,provider_id,day,created_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM autonomy_provider_invocations WHERE provider_id=? AND day=?) < ?
    ON CONFLICT(invocation_id) DO NOTHING`,
    )
    .run(invocation, taskId, ctx.providerId, day, now, ctx.providerId, day, ctx.limit);
  if (result.changes) return null;
  const duplicate = db
    .prepare("SELECT task_id,provider_id FROM autonomy_provider_invocations WHERE invocation_id=?")
    .get(invocation) as Reservation | undefined;
  if (duplicate?.task_id === taskId && duplicate.provider_id === ctx.providerId) return null;
  return "Daily autonomous local provider invocation cap reached (includes retries and resumes)";
}
