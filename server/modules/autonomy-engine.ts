import type { DatabaseSync } from "node:sqlite";
import { isAutonomyAllowed } from "./control-state.ts";
import { ensureAgentProposalSchema } from "./agent-proposals.ts";
import { ensureAutonomySchema, autonomyConfig } from "./autonomy-store.ts";
import { configuredLocalTaskProvider } from "./model-routing.ts";
import { ensurePlaybookSchema } from "./playbooks.ts";
import { nextCronRun } from "./schedule-time.ts";
import { autonomousProviderBudgetBlockReason } from "./autonomous-provider-budget.ts";

/**
 * Admission checks for autonomous tasks: subscription headroom, provider budgets, the emergency controls and the
 * daily start cap. The work engine (work-engine.ts) decides what to run; every start, including delegated helper
 * tasks, passes through these checks in `startTaskExecutionForAgent`.
 */
type Row = Record<string, any>;
export const AUTONOMY_TIMEZONE = "America/New_York";
export const USAGE_MAX_AGE_MS = 10 * 60_000;

export function ensureAutonomyEngineSchema(db: DatabaseSync): void {
  ensureAutonomySchema(db);
  ensureAgentProposalSchema(db);
  ensurePlaybookSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_engine_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_start_reservations(work_id TEXT PRIMARY KEY,day TEXT NOT NULL,created_at INTEGER NOT NULL);`);
}

/**
 * A goal's research-phase task (a research angle or the synthesis). These have their own, bigger allowance: the
 * daily start cap does not count them, so planning thoroughly never eats the day's build work (plan section 8).
 */
export function isResearchPhaseTask(task: Row | undefined): boolean {
  if (!task?.goal_id || task.initiative_id) return false;
  const step = String(task.playbook_step ?? "");
  return step === "strategy" || step.startsWith("research:");
}

export function autonomyDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTONOMY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function usageHeadroomBlockReason(
  db: DatabaseSync,
  now = Date.now(),
  providers: Iterable<string> = ["codex", "claude"],
): string | null {
  const config = autonomyConfig(db);
  for (const provider of new Set(providers)) {
    // Subscription windows apply to the provider actually being called. A local
    // model must not be blocked by an unrelated, disconnected subscription.
    if (provider !== "codex" && provider !== "claude") continue;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cli_usage_cache'").get())
      return "Subscription usage is not available yet";
    const row = db.prepare("SELECT data_json,updated_at FROM cli_usage_cache WHERE provider=?").get(provider) as
      | Row
      | undefined;
    if (
      !row ||
      !Number.isFinite(row.updated_at) ||
      row.updated_at > now + 60_000 ||
      now - row.updated_at > USAGE_MAX_AGE_MS
    )
      return `${provider} subscription usage needs refreshing`;
    try {
      const entry = JSON.parse(row.data_json);
      if (entry.error || !Array.isArray(entry.windows) || !entry.windows.length)
        return `${provider} subscription usage is unavailable`;
      for (const window of entry.windows) {
        if (!Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 1)
          return `${provider} subscription usage is invalid`;
        if (window.utilization >= config.usage_threshold)
          return `${provider} subscription window reached the autonomy threshold`;
      }
    } catch {
      return `${provider} subscription usage is invalid`;
    }
  }
  return null;
}

/** Headroom and emergency controls for every task in an autonomous delegation tree. */
export function autonomyTaskUsageBlockReason(
  db: DatabaseSync,
  taskId: string,
  now = Date.now(),
  actualExecutionProvider?: string,
): string | null {
  if (!table(db, "autonomy_config")) return null;
  const task = db.prepare("SELECT origin FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (task?.origin !== "autonomy") return null;
  if (!isAutonomyAllowed()) return "Autonomy is paused";
  const route = table(db, "task_model_routes")
    ? (db
        .prepare(
          `SELECT r.provider FROM task_model_routes r JOIN tasks t
        ON t.id=r.task_id AND t.assigned_agent_id=r.agent_id WHERE r.task_id=?`,
        )
        .get(taskId) as Row | undefined)
    : undefined;
  const assigned = db
    .prepare("SELECT a.cli_provider FROM agents a JOIN tasks t ON t.assigned_agent_id=a.id WHERE t.id=?")
    .get(taskId) as Row | undefined;
  const provider = actualExecutionProvider
    ? actualExecutionProvider === "opencode" && route?.provider === "api"
      ? "api"
      : actualExecutionProvider
    : (route?.provider ?? configuredLocalTaskProvider(db, taskId) ?? assigned?.cli_provider);
  if (typeof provider !== "string" || !provider) return "Autonomous worker provider is not configured";
  if (!["codex", "claude", "gemini", "kimi", "opencode", "copilot", "antigravity", "api"].includes(provider))
    return "Autonomous worker provider is not supported";
  return (
    autonomousProviderBudgetBlockReason(db, taskId, now, { provider: actualExecutionProvider }) ||
    usageHeadroomBlockReason(db, now, [provider])
  );
}

/** Reserve every new autonomous task, including delegates, once; continuations reuse their reservation. */
export function admitAutonomyTaskStart(db: DatabaseSync, taskId: string, now = Date.now()): string | null {
  if (!table(db, "autonomy_start_reservations")) return null;
  const usage = autonomyTaskUsageBlockReason(db, taskId, now);
  if (usage) return usage;
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (task?.origin !== "autonomy") return null;
  const source = autonomyTaskStartBlockReason(db, taskId, now);
  if (source) return source;
  if (isResearchPhaseTask(task)) return null;
  const key = `task:${taskId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM autonomy_start_reservations WHERE work_id=?").get(key)) {
      db.exec("COMMIT");
      return null;
    }
    const day = autonomyDay(now),
      config = autonomyConfig(db);
    const count = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations WHERE day=?").get(day) as Row).n,
    );
    if (count >= config.daily_start_cap) {
      db.exec("ROLLBACK");
      return "Daily autonomous task start cap reached";
    }
    db.prepare("INSERT INTO autonomy_start_reservations(work_id,day,created_at) VALUES(?,?,?)").run(key, day, now);
    db.exec("COMMIT");
    return null;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Rechecked after model routing awaits, immediately before dispatching an admitted autonomous task. */
export function autonomyTaskStartBlockReason(db: DatabaseSync, taskId: string, now = Date.now()): string | null {
  const usage = autonomyTaskUsageBlockReason(db, taskId, now);
  if (usage) return usage;
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (task?.origin !== "autonomy") return null;
  if (!isAutonomyAllowed()) return "Autonomy is paused";
  if (task.initiative_id && table(db, "initiatives")) {
    const initiative = db.prepare("SELECT status FROM initiatives WHERE id=?").get(task.initiative_id) as
      | Row
      | undefined;
    if (!initiative || ["proposed", "stopped", "done"].includes(initiative.status))
      return "Initiative is no longer accepting work";
  }
  return null;
}

function table(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** When a schedule runs next: its time-of-day rule, or its interval. A rule that cannot run falls back to the interval. */
export function nextScheduleRun(schedule: Row, now: number): number {
  if (schedule.cron) {
    try {
      return nextCronRun(String(schedule.cron), String(schedule.timezone || AUTONOMY_TIMEZONE), now);
    } catch {
      // fall through to the interval
    }
  }
  return now + Number(schedule.interval_minutes) * 60_000;
}
