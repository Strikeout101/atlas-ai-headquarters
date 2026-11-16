import type { DatabaseSync } from "node:sqlite";

/**
 * The owner's emergency controls.
 *
 * - `running`: normal operation.
 * - `autonomy_paused`: nothing the agents start on their own may run; work the owner started continues.
 * - `stopped`: no agent run of any kind may start, and everything in flight has been paused.
 *
 * The mode lives in its own table (not `settings`, which the app rewrites wholesale on every save) and is
 * mirrored in memory so the low-level run helpers can check it without a database handle.
 */
export const CONTROL_MODES = ["running", "autonomy_paused", "stopped"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export type ControlState = { mode: ControlMode; changed_at: number; reason: string | null };

/** Error text used whenever a run is refused because the owner stopped everything. */
export const RUNS_HALTED_ERROR = "runs_halted_by_owner";

type Db = Pick<DatabaseSync, "exec" | "prepare">;

let currentMode: ControlMode = "running";
const oneShotAborters = new Set<(reason: string) => void>();

export function isControlMode(value: unknown): value is ControlMode {
  return typeof value === "string" && (CONTROL_MODES as readonly string[]).includes(value);
}

export function ensureControlStateSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL DEFAULT 'running' CHECK (mode IN ('running','autonomy_paused','stopped')),
      changed_at INTEGER NOT NULL DEFAULT 0,
      reason TEXT
    )
  `);
  db.exec("INSERT OR IGNORE INTO control_state (id, mode, changed_at) VALUES (1, 'running', 0)");
  try {
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === "origin")) {
      // Who started this work: the owner, or the agents on their own initiative.
      db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner'");
    }
    if (cols.some((c) => c.name === "source_task_id")) {
      const installed = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='tasks_inherit_autonomy_origin'")
        .get();
      db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_inherit_autonomy_origin AFTER INSERT ON tasks
        WHEN NEW.source_task_id IS NOT NULL AND NEW.origin <> 'autonomy'
          AND EXISTS (SELECT 1 FROM tasks WHERE id=NEW.source_task_id AND origin='autonomy')
        BEGIN UPDATE tasks SET origin='autonomy' WHERE id=NEW.id; END`);
      if (!installed)
        db.exec(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tasks WHERE origin='autonomy'
        UNION SELECT t.id FROM tasks t JOIN descendants d ON t.source_task_id=d.id
      ) UPDATE tasks SET origin='autonomy' WHERE id IN (SELECT id FROM descendants) AND origin<>'autonomy'`);
    }
  } catch {
    /* tasks table not created yet in isolated tests */
  }
  currentMode = readControlState(db).mode;
}

export function readControlState(db: Db): ControlState {
  const row = db.prepare("SELECT mode, changed_at, reason FROM control_state WHERE id = 1").get() as
    | { mode?: unknown; changed_at?: unknown; reason?: unknown }
    | undefined;
  return {
    mode: isControlMode(row?.mode) ? row.mode : "running",
    changed_at: Number(row?.changed_at ?? 0) || 0,
    reason: typeof row?.reason === "string" && row.reason ? row.reason : null,
  };
}

export function setControlMode(db: Db, mode: ControlMode, now: number, reason?: string | null): ControlState {
  const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;
  db.prepare("UPDATE control_state SET mode = ?, changed_at = ?, reason = ? WHERE id = 1").run(mode, now, cleanReason);
  currentMode = mode;
  return { mode, changed_at: now, reason: cleanReason };
}

export function getControlMode(): ControlMode {
  return currentMode;
}

/** False once the owner stopped everything: no agent process or model call may start. */
export function areRunsAllowed(): boolean {
  return currentMode !== "stopped";
}

/** False when agents may not start anything on their own initiative. */
export function isAutonomyAllowed(): boolean {
  return currentMode === "running";
}

/**
 * Why a task may not be started automatically right now, or null when it may.
 * Everything is blocked while stopped; work the agents began on their own is blocked while autonomy is paused.
 */
export function automaticStartBlockReason(db: Pick<DatabaseSync, "prepare">, taskId: string): string | null {
  if (!areRunsAllowed()) return "the owner stopped everything";
  if (isAutonomyAllowed()) return null;
  try {
    const row = db.prepare("SELECT origin FROM tasks WHERE id = ?").get(taskId) as { origin?: unknown } | undefined;
    return row?.origin === "autonomy" ? "the owner paused autonomy" : null;
  } catch {
    return null;
  }
}

/** Throws when the owner stopped everything. Last line of defence inside the run helpers. */
export function assertRunsAllowed(): void {
  if (!areRunsAllowed()) throw new Error(RUNS_HALTED_ERROR);
}

/** One-shot model calls register here so "stop everything" can end them. Returns the unregister function. */
export function registerOneShotAbort(abort: (reason: string) => void): () => void {
  oneShotAborters.add(abort);
  return () => {
    oneShotAborters.delete(abort);
  };
}

export function abortAllOneShots(reason: string = RUNS_HALTED_ERROR): number {
  const aborters = [...oneShotAborters];
  oneShotAborters.clear();
  for (const abort of aborters) {
    try {
      abort(reason);
    } catch {
      /* one failing abort must not keep the rest alive */
    }
  }
  return aborters.length;
}

/** Tests only: forget the in-memory mode and any registered one-shots. */
export function resetControlStateForTests(): void {
  currentMode = "running";
  oneShotAborters.clear();
}
