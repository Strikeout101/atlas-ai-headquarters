import type { Lang } from "../../../types/lang.ts";

type CreateSessionReviewToolsDeps = Record<string, any>;

export function createSessionReviewTools(deps: CreateSessionReviewToolsDeps) {
  const {
    taskExecutionSessions,
    nowMs,
    randomUUID,
    stopRequestedTasks,
    stopRequestModeByTask,
    clearCliOutputDedup,
    crossDeptNextCallbacks,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    delegatedTaskToSubtask,
    subtaskDelegationCompletionNoticeSent,
    reviewRoundState,
    reviewInFlight,
    appendTaskLog,
    notifyCeo,
    pickL,
    l,
    db,
    finishReview,
    randomDelay,
    startPlannedApprovalMeeting,
  } = deps;

  function ensureTaskExecutionSession(taskId: string, agentId: string, provider: string): any {
    const now = nowMs();
    const existing = taskExecutionSessions.get(taskId);
    if (existing && existing.agentId === agentId && existing.provider === provider) {
      existing.lastTouchedAt = now;
      taskExecutionSessions.set(taskId, existing);
      return existing;
    }

    const nextSession: any = {
      sessionId: randomUUID(),
      taskId,
      agentId,
      provider,
      openedAt: now,
      lastTouchedAt: now,
    };
    taskExecutionSessions.set(taskId, nextSession);
    appendTaskLog(
      taskId,
      "system",
      existing
        ? `Execution session rotated: ${existing.sessionId} -> ${nextSession.sessionId} (agent=${agentId}, provider=${provider})`
        : `Execution session opened: ${nextSession.sessionId} (agent=${agentId}, provider=${provider})`,
    );
    return nextSession;
  }

  function endTaskExecutionSession(taskId: string, reason: string): void {
    const existing = taskExecutionSessions.get(taskId);
    if (!existing) return;
    taskExecutionSessions.delete(taskId);
    appendTaskLog(
      taskId,
      "system",
      `Execution session closed: ${existing.sessionId} (reason=${reason}, duration_ms=${Math.max(0, nowMs() - existing.openedAt)})`,
    );
  }

  function getTaskStatusById(taskId: string): string | null {
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  function isTaskWorkflowInterrupted(taskId: string): boolean {
    const status = getTaskStatusById(taskId);
    if (!status) return true; // deleted
    if (stopRequestedTasks.has(taskId)) return true;
    return status === "cancelled" || status === "pending" || status === "done" || status === "inbox";
  }

  function clearTaskWorkflowState(taskId: string): void {
    clearCliOutputDedup(taskId);
    crossDeptNextCallbacks.delete(taskId);
    subtaskDelegationCallbacks.delete(taskId);
    subtaskDelegationDispatchInFlight.delete(taskId);
    delegatedTaskToSubtask.delete(taskId);
    subtaskDelegationCompletionNoticeSent.delete(taskId);
    reviewInFlight.delete(taskId);
    reviewInFlight.delete(`planned:${taskId}`);
    reviewRoundState.delete(taskId);
    reviewRoundState.delete(`planned:${taskId}`);
    const status = getTaskStatusById(taskId);
    if (status === "done" || status === "cancelled") {
      endTaskExecutionSession(taskId, `workflow_cleared_${status}`);
    }
  }

  return {
    ensureTaskExecutionSession,
    endTaskExecutionSession,
    getTaskStatusById,
    isTaskWorkflowInterrupted,
    clearTaskWorkflowState,
  };
}
