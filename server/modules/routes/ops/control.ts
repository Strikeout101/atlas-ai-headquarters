import type { ChildProcess } from "node:child_process";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  abortAllOneShots,
  ensureControlStateSchema,
  isControlMode,
  readControlState,
  setControlMode,
  type ControlMode,
} from "../../control-state.ts";
import { holdContextRollover } from "../../workflow/agents/context-rollover-store.ts";

export type ControlRouteDeps = {
  nowMs: () => number;
  broadcast: (type: string, payload: unknown) => void;
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  interruptPidTree: (pid: number) => void;
  stopProgressTimer: (taskId: string) => void;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  /** Called after leaving `stopped`, to pick up work that was waiting on a gate (reviews). */
  onRunsAllowedAgain?: () => void;
};

type PauseScope = "all" | "autonomy";

/**
 * Pauses running tasks the same way the per-task Pause button does: the process gets a graceful interrupt,
 * the task goes to `pending`, and its session and worktree are kept so it can be resumed later.
 */
export function pauseRunningTasks(db: DatabaseSync, deps: ControlRouteDeps, scope: PauseScope, why: string): number {
  const rows = db
    .prepare(
      `SELECT id, assigned_agent_id FROM tasks
       WHERE status = 'in_progress' ${scope === "autonomy" ? "AND origin = 'autonomy'" : ""}`,
    )
    .all() as Array<{ id: string; assigned_agent_id: string | null }>;
  const taskIds = new Map(rows.map((row) => [row.id, row.assigned_agent_id]));
  if (scope === "all") {
    // A process can outlive its task row state (e.g. mid hand-over); stop those too.
    for (const taskId of deps.activeProcesses.keys()) if (!taskIds.has(taskId)) taskIds.set(taskId, null);
  }

  for (const [taskId, agentId] of taskIds) {
    try {
      holdContextRollover(db as any, taskId, deps.nowMs());
    } catch {
      /* optional schema in isolated tests */
    }
    deps.stopProgressTimer(taskId);

    const child = deps.activeProcesses.get(taskId);
    if (child?.pid) {
      deps.stopRequestedTasks.add(taskId);
      deps.stopRequestModeByTask.set(taskId, "pause");
      try {
        if (child.pid < 0) child.kill();
        else deps.interruptPidTree(child.pid);
      } catch (err) {
        deps.appendTaskLog(taskId, "error", `Emergency pause could not signal pid ${child.pid}: ${String(err)}`);
      }
    }
    deps.appendTaskLog(taskId, "system", `Paused by the owner's emergency control (${why}). Session kept.`);

    const changed = db
      .prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'in_progress'")
      .run(deps.nowMs(), taskId).changes;
    if (changed) deps.broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (agentId) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ? AND current_task_id = ?").run(
        agentId,
        taskId,
      );
      deps.broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId));
    }
  }
  return taskIds.size;
}

export function applyControlMode(
  db: DatabaseSync,
  deps: ControlRouteDeps,
  mode: ControlMode,
  reason?: string | null,
): { state: ReturnType<typeof readControlState>; paused_tasks: number; aborted_calls: number } {
  const previous = readControlState(db).mode;
  // Close the gates first, so nothing new starts while running work is being paused.
  const state = setControlMode(db, mode, deps.nowMs(), reason);
  let pausedTasks = 0;
  let abortedCalls = 0;
  if (mode === "stopped") {
    pausedTasks = pauseRunningTasks(db, deps, "all", "stop everything");
    abortedCalls = abortAllOneShots();
  } else if (mode === "autonomy_paused") {
    pausedTasks = pauseRunningTasks(db, deps, "autonomy", "autonomy paused");
  }
  if (previous === "stopped" && mode !== "stopped") deps.onRunsAllowedAgain?.();
  deps.broadcast("control_state", state);
  return { state, paused_tasks: pausedTasks, aborted_calls: abortedCalls };
}

/** Owner-only emergency controls. Agents can neither read a reason to argue with nor change the mode. */
export function registerControlRoutes(app: Express, db: DatabaseSync, deps: ControlRouteDeps): void {
  ensureControlStateSchema(db);
  const base = "/api/control";
  app.use(base, (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (req.method !== "GET" && shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
      return res.status(403).json({ error: "csrf_token_required" });
    }
    next();
  });
  app.get(base, (_req, res) => res.json({ ok: true, state: readControlState(db) }));
  app.post(base, (req, res) => {
    const mode = req.body?.mode;
    if (!isControlMode(mode)) return res.status(400).json({ error: "invalid_mode" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    return res.json({ ok: true, ...applyControlMode(db, deps, mode, reason) });
  });
}
