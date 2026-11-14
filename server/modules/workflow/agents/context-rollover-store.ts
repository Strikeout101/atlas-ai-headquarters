import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "exec" | "prepare">;

export type ContextRolloverStatus = "pending_resume" | "resuming" | "running" | "escalated" | "held" | "complete";

export type ContextRolloverState = {
  taskId: string;
  agentId: string;
  model: string;
  status: ContextRolloverStatus;
  checkpointText: string;
  reason: string;
  progressFingerprint: string;
  rolloverCount: number;
  stalledCount: number;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  processPid: number | null;
};

export type RecordContextRolloverInput = {
  taskId: string;
  agentId: string;
  model: string;
  attemptId: string;
  reason: string;
  checkpointText: string;
  progressFingerprint: string;
  now: number;
};

export type RecordContextRolloverResult = {
  status: "pending_resume" | "escalated";
  rolloverCount: number;
  stalledCount: number;
  duplicate: boolean;
};

const MAX_AUTOMATIC_ROLLOVERS = 6;
const MAX_CONSECUTIVE_STALLED_ROLLOVERS = 2;
const MAX_CHECKPOINT_CHARS = 12_000;

export function ensureContextRolloverSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_context_rollovers (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_resume','resuming','running','escalated','held','complete')),
      checkpoint_text TEXT NOT NULL,
      reason TEXT NOT NULL,
      progress_fingerprint TEXT NOT NULL,
      rollover_count INTEGER NOT NULL DEFAULT 0,
      stalled_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      process_pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS task_context_rollover_events (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_context_rollovers_status
      ON task_context_rollovers(status, updated_at);
  `);
  try {
    db.exec("ALTER TABLE task_context_rollovers ADD COLUMN process_pid INTEGER");
  } catch {
    /* Existing schema. */
  }
}

export function getContextRollover(db: Db, taskId: string): ContextRolloverState | null {
  const row = db
    .prepare(
      `
    SELECT task_id AS taskId, agent_id AS agentId, model, status,
      checkpoint_text AS checkpointText, reason, progress_fingerprint AS progressFingerprint,
      rollover_count AS rolloverCount, stalled_count AS stalledCount,
      created_at AS createdAt, updated_at AS updatedAt, claimed_at AS claimedAt, process_pid AS processPid
    FROM task_context_rollovers WHERE task_id = ?
  `,
    )
    .get(taskId) as ContextRolloverState | undefined;
  return row ?? null;
}

export function recordContextRollover(db: Db, input: RecordContextRolloverInput): RecordContextRolloverResult {
  const checkpointText = input.checkpointText.trim().slice(0, MAX_CHECKPOINT_CHARS);
  const fingerprint = input.progressFingerprint.trim();
  if (
    !input.taskId ||
    !input.agentId ||
    !input.model ||
    !input.attemptId ||
    !input.reason ||
    !checkpointText ||
    !fingerprint
  ) {
    throw new Error("invalid_context_rollover_checkpoint");
  }
  if (!Number.isFinite(input.now)) throw new Error("invalid_context_rollover_time");

  db.exec("SAVEPOINT record_context_rollover");
  try {
    const priorEvent = db
      .prepare(
        `
      SELECT 1 FROM task_context_rollover_events WHERE task_id = ? AND attempt_id = ?
    `,
      )
      .get(input.taskId, input.attemptId);
    if (priorEvent) {
      const previous = getContextRollover(db, input.taskId);
      if (!previous) throw new Error("context_rollover_event_without_state");
      db.exec("RELEASE SAVEPOINT record_context_rollover");
      return {
        status: previous.status === "escalated" ? "escalated" : "pending_resume",
        rolloverCount: previous.rolloverCount,
        stalledCount: previous.stalledCount,
        duplicate: true,
      };
    }

    const task = db.prepare("SELECT status, assigned_agent_id AS agentId FROM tasks WHERE id = ?").get(input.taskId) as
      | { status: string; agentId: string | null }
      | undefined;
    if (!task || task.status !== "in_progress" || task.agentId !== input.agentId) {
      throw new Error("context_rollover_task_not_active");
    }

    const previous = getContextRollover(db, input.taskId);
    if (previous && previous.status !== "running" && previous.status !== "complete") {
      throw new Error("context_rollover_not_ready_for_new_attempt");
    }
    const rolloverCount = (previous?.rolloverCount ?? 0) + 1;
    const stalledCount = previous && previous.progressFingerprint === fingerprint ? previous.stalledCount + 1 : 0;
    const status =
      stalledCount >= MAX_CONSECUTIVE_STALLED_ROLLOVERS || rolloverCount > MAX_AUTOMATIC_ROLLOVERS
        ? "escalated"
        : "pending_resume";

    db.prepare(
      `
      INSERT INTO task_context_rollovers
        (task_id, agent_id, model, status, checkpoint_text, reason, progress_fingerprint,
         rollover_count, stalled_count, created_at, updated_at, claimed_at, process_pid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(task_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        model = excluded.model,
        status = excluded.status,
        checkpoint_text = excluded.checkpoint_text,
        reason = excluded.reason,
        progress_fingerprint = excluded.progress_fingerprint,
        rollover_count = excluded.rollover_count,
        stalled_count = excluded.stalled_count,
        updated_at = excluded.updated_at,
        claimed_at = NULL,
        process_pid = NULL
    `,
    ).run(
      input.taskId,
      input.agentId,
      input.model,
      status,
      checkpointText,
      input.reason.trim().slice(0, 200),
      fingerprint,
      rolloverCount,
      stalledCount,
      input.now,
      input.now,
    );
    db.prepare(
      `
      INSERT INTO task_context_rollover_events (task_id, attempt_id, created_at) VALUES (?, ?, ?)
    `,
    ).run(input.taskId, input.attemptId, input.now);
    db.exec("RELEASE SAVEPOINT record_context_rollover");
    return { status, rolloverCount, stalledCount, duplicate: false };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT record_context_rollover");
    db.exec("RELEASE SAVEPOINT record_context_rollover");
    throw error;
  }
}

export function claimContextRolloverResume(db: Db, taskId: string, now: number): boolean {
  const result = db
    .prepare(
      `
    UPDATE task_context_rollovers SET status = 'resuming', claimed_at = ?, updated_at = ?
    WHERE task_id = ? AND status = 'pending_resume'
      AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.id = task_context_rollovers.task_id
          AND t.status = 'pending' AND t.assigned_agent_id = task_context_rollovers.agent_id
      )
  `,
    )
    .run(now, now, taskId);
  return Number(result.changes) === 1;
}

export function markContextRolloverStarted(db: Db, taskId: string, now: number): boolean {
  const result = db
    .prepare(
      `
    UPDATE task_context_rollovers SET status = 'running', updated_at = ?, process_pid = NULL
    WHERE task_id = ? AND status = 'resuming'
  `,
    )
    .run(now, taskId);
  return Number(result.changes) === 1;
}

export function setContextRolloverProcessPid(db: Db, taskId: string, pid: number, now: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = db
    .prepare(
      `
    UPDATE task_context_rollovers SET process_pid = ?, updated_at = ?
    WHERE task_id = ? AND status = 'running'
  `,
    )
    .run(pid, now, taskId);
  return Number(result.changes) === 1;
}

export function markContextRolloverComplete(db: Db, taskId: string, now: number): void {
  db.prepare(
    `
    UPDATE task_context_rollovers SET status = 'complete', updated_at = ?, claimed_at = NULL, process_pid = NULL
    WHERE task_id = ? AND status IN ('running','resuming','pending_resume')
  `,
  ).run(now, taskId);
}

export function holdContextRollover(db: Db, taskId: string, now: number): void {
  db.prepare(
    `
    UPDATE task_context_rollovers SET status = 'held', updated_at = ?, claimed_at = NULL, process_pid = NULL
    WHERE task_id = ? AND status IN ('pending_resume','resuming','running')
  `,
  ).run(now, taskId);
}

export function listPendingContextRollovers(db: Db): ContextRolloverState[] {
  const rows = db
    .prepare(
      `
    SELECT r.task_id AS taskId, r.agent_id AS agentId, r.model, r.status,
      r.checkpoint_text AS checkpointText, r.reason, r.progress_fingerprint AS progressFingerprint,
      r.rollover_count AS rolloverCount, r.stalled_count AS stalledCount,
      r.created_at AS createdAt, r.updated_at AS updatedAt, r.claimed_at AS claimedAt, r.process_pid AS processPid
    FROM task_context_rollovers r JOIN tasks t ON t.id = r.task_id
    WHERE r.status = 'pending_resume' AND t.status = 'pending' AND t.assigned_agent_id = r.agent_id
    ORDER BY r.updated_at ASC
  `,
    )
    .all() as ContextRolloverState[];
  return rows;
}

export function releaseStaleContextRolloverClaims(db: Db, now: number): number {
  const result = db
    .prepare(
      `
    UPDATE task_context_rollovers SET status = 'pending_resume', claimed_at = NULL, process_pid = NULL, updated_at = ?
    WHERE status = 'resuming'
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_context_rollovers.task_id AND t.status = 'pending')
  `,
    )
    .run(now);
  return Number(result.changes);
}

export function requeueOrphanContextRollover(db: Db, taskId: string, now: number): boolean {
  const result = db
    .prepare(
      `
    UPDATE task_context_rollovers SET status = 'pending_resume', claimed_at = NULL, process_pid = NULL, updated_at = ?
    WHERE task_id = ? AND status IN ('resuming','running')
      AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.id = task_context_rollovers.task_id
          AND t.status = 'pending' AND t.assigned_agent_id = task_context_rollovers.agent_id
      )
  `,
    )
    .run(now, taskId);
  return Number(result.changes) === 1;
}

export function approveEscalatedContextRollover(db: Db, taskId: string, now: number): boolean {
  const result = db
    .prepare(
      `
      UPDATE task_context_rollovers
      SET status = 'pending_resume', stalled_count = 0, claimed_at = NULL, process_pid = NULL, updated_at = ?
      WHERE task_id = ? AND status = 'escalated'
        AND EXISTS (
          SELECT 1 FROM tasks t WHERE t.id = task_context_rollovers.task_id
            AND t.status = 'pending' AND t.assigned_agent_id = task_context_rollovers.agent_id
        )
    `,
    )
    .run(now, taskId);
  return Number(result.changes) === 1;
}

export function markContextRolloverManualResume(db: Db, taskId: string, now: number): boolean {
  const result = db
    .prepare(
      `
      UPDATE task_context_rollovers
      SET status = 'running', stalled_count = 0, claimed_at = NULL, process_pid = NULL, updated_at = ?
      WHERE task_id = ? AND status IN ('pending_resume','resuming','held','escalated')
    `,
    )
    .run(now, taskId);
  return Number(result.changes) === 1;
}
