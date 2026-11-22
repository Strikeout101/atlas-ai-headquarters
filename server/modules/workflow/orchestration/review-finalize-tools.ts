import { areRunsAllowed } from "../../control-state.ts";

/**
 * Finishing reviewed work (work restructure, phase 4). The review itself is `task-review.ts`: one cross-model
 * reviewer with a structured verdict. `finishReview` runs only once the work is approved: it merges a code task's
 * worktree (the code-push approval still guards GitHub), marks the task done, archives the report and continues any
 * queued delegation. No project gate, no team-lead meeting, no waiting on subtasks or merge rounds.
 */

type CreateReviewFinalizeToolsDeps = Record<string, any>;

export function createReviewFinalizeTools(deps: CreateReviewFinalizeToolsDeps) {
  const {
    db,
    nowMs,
    broadcast,
    appendTaskLog,
    getPreferredLanguage,
    pickL,
    l,
    resolveLang,
    notifyCeo,
    taskWorktrees,
    mergeToDevAndCreatePR,
    mergeWorktree,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    setTaskCreationAuditCompletion,
    endTaskExecutionSession,
    notifyTaskStatus,
    refreshCliUsageData,
    shouldDeferTaskReportUntilPlanningArchive,
    emitTaskReportEvent,
    formatTaskSubtaskProgressSummary,
    reviewRoundState,
    reviewInFlight,
    archivePlanningConsolidatedReport,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    helperTaskFinished,
  } = deps;

  function reconcileDelegatedSubtasksAfterRun(taskId: string, exitCode: number): void {
    const linked = db
      .prepare(
        `
  SELECT id, task_id
  FROM subtasks
  WHERE delegated_task_id = ?
    AND status NOT IN ('done', 'cancelled')
`,
      )
      .all(taskId) as Array<{ id: string; task_id: string }>;
    if (linked.length <= 0) return;

    const touchedParents = new Set<string>();
    for (const sub of linked) {
      if (sub.task_id) touchedParents.add(sub.task_id);
    }

    if (exitCode === 0) {
      const doneAt = nowMs();
      for (const sub of linked) {
        db.prepare("UPDATE subtasks SET status = 'done', completed_at = ?, blocked_reason = NULL WHERE id = ?").run(
          doneAt,
          sub.id,
        );
        broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
      }
      appendTaskLog(taskId, "system", `Delegated subtask sync: marked ${linked.length} linked subtask(s) as done`);

      // The parent's review waits for its helpers; it starts once the last one is finished.
      for (const parentTaskId of touchedParents) helperTaskFinished?.(taskId, parentTaskId);
      return;
    }

    const lang = getPreferredLanguage();
    const blockedReason = pickL(l(["Delegated task failed"]), lang);
    for (const sub of linked) {
      db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ?, completed_at = NULL WHERE id = ?").run(
        blockedReason,
        sub.id,
      );
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id));
    }
    appendTaskLog(taskId, "system", `Delegated subtask sync: marked ${linked.length} linked subtask(s) as blocked`);
  }

  /** Approved work: merge (code), mark done, report. Called by the review once it approves. */
  function finishReview(taskId: string, taskTitle: string, _options?: { trigger?: string }): void {
    // Stays in review; picked up again when the owner lets runs continue.
    if (!areRunsAllowed()) return;
    const lang = resolveLang(taskTitle);
    const currentTask = db
      .prepare("SELECT status, department_id, source_task_id, project_id, project_path FROM tasks WHERE id = ?")
      .get(taskId) as
      | {
          status: string;
          department_id: string | null;
          source_task_id: string | null;
          project_id: string | null;
          project_path: string | null;
        }
      | undefined;
    if (!currentTask || currentTask.status !== "review") return; // Already moved or cancelled

    const finalizeApprovedReview = () => {
      const t = nowMs();
      const latestTask = db.prepare("SELECT status, department_id FROM tasks WHERE id = ?").get(taskId) as
        | { status: string; department_id: string | null }
        | undefined;
      if (!latestTask || latestTask.status !== "review") return;

      // If task has a worktree, merge the branch back before marking done
      const wtInfo = taskWorktrees.get(taskId);
      let mergeNote = "";
      if (wtInfo) {
        // Check if this is a GitHub project → merge to dev + PR flow
        const projectRow = currentTask.project_id
          ? (db.prepare("SELECT github_repo FROM projects WHERE id = ?").get(currentTask.project_id) as
              | { github_repo: string | null }
              | undefined)
          : undefined;
        const githubRepo = projectRow?.github_repo;

        const mergeResult = githubRepo
          ? mergeToDevAndCreatePR(wtInfo.projectPath, taskId, githubRepo, currentTask.project_id ?? null)
          : mergeWorktree(wtInfo.projectPath, taskId);

        if (mergeResult.success) {
          appendTaskLog(taskId, "system", `Git merge completed: ${mergeResult.message}`);
          mergeNote = githubRepo ? pickL(l([" (merged to dev + PR)"]), lang) : pickL(l([" (merged)"]), lang);
        } else {
          appendTaskLog(taskId, "system", `Git merge failed: ${mergeResult.message}`);

          const conflictLeader = findTeamLeader(latestTask.department_id);
          const conflictLeaderName = conflictLeader
            ? getAgentDisplayName(conflictLeader, lang)
            : pickL(l(["Team Lead"]), lang);
          const conflictFiles = mergeResult.conflicts?.length
            ? pickL(l([`\nConflicting files: ${mergeResult.conflicts.join(", ")}`]), lang)
            : "";
          notifyCeo(
            pickL(
              l([
                `${conflictLeaderName}: Merge failed for '${taskTitle}'. Task remains in Review; resolve the failure and approve again.\n${mergeResult.message}${conflictFiles}\nBranch: ${wtInfo.branchName}`,
              ]),
              lang,
            ),
            taskId,
          );

          // Preserve the branch, review state and queued callbacks for a later retry.
          // A successful worker/review is not a successful integration.
          appendTaskLog(taskId, "system", "Review hold: merge failed; worktree preserved for retry");
          reviewInFlight.delete(taskId);
          return;
        }
      }

      if (wtInfo) {
        cleanupWorktree(wtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up after successful merge");
      }

      db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(t, t, taskId);
      setTaskCreationAuditCompletion(taskId, true);

      appendTaskLog(taskId, "system", "Status → done (review approved)");
      endTaskExecutionSession(taskId, "task_done");

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
      notifyTaskStatus(taskId, taskTitle, "done", lang);

      refreshCliUsageData()
        .then((usage: unknown) => broadcast("cli_usage_update", usage))
        .catch(() => {});
      const deferTaskReport = shouldDeferTaskReportUntilPlanningArchive(currentTask);
      if (deferTaskReport) {
        appendTaskLog(taskId, "system", "Task report popup deferred until planning consolidated archive is ready");
      } else {
        emitTaskReportEvent(taskId);
      }

      const leader = findTeamLeader(latestTask.department_id);
      const leaderName = leader ? getAgentDisplayName(leader, lang) : pickL(l(["Team Lead"]), lang);
      const subtaskProgressSummary = formatTaskSubtaskProgressSummary(taskId, lang);
      const progressSuffix = subtaskProgressSummary
        ? `\n${pickL(l(["Remediation/Collaboration completion"]), lang)}\n${subtaskProgressSummary}`
        : "";
      notifyCeo(pickL(l([`${leaderName}: '${taskTitle}' is done.${mergeNote}${progressSuffix}`]), lang), taskId);

      reviewRoundState.delete(taskId);
      reviewInFlight.delete(taskId);

      if (!currentTask.source_task_id) {
        // Generate and archive one consolidated project report via planning leader model.
        void archivePlanningConsolidatedReport(taskId);
      }

      const nextCallback = crossDeptNextCallbacks.get(taskId);
      if (nextCallback) {
        crossDeptNextCallbacks.delete(taskId);
        nextCallback();
      } else {
        // pause/resume or restart can drop in-memory callback chain; reconstruct from DB when possible
        recoverCrossDeptQueueAfterMissingCallback(taskId);
      }

      const subtaskNext = subtaskDelegationCallbacks.get(taskId);
      if (subtaskNext) {
        subtaskDelegationCallbacks.delete(taskId);
        subtaskNext();
      }
    };

    finalizeApprovedReview();
  }

  return {
    reconcileDelegatedSubtasksAfterRun,
    finishReview,
  };
}
