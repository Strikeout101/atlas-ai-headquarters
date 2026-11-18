import { readYoloModeEnabled } from "../../routes/ops/messages/decision-inbox/yolo-mode.ts";
import { areRunsAllowed } from "../../control-state.ts";

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
    getProjectReviewGateSnapshot,
    projectReviewGateNotifiedAt,
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
    startReviewConsensusMeeting,
    processSubtaskDelegations,
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

      for (const parentTaskId of touchedParents) {
        const parent = db.prepare("SELECT id, title, status FROM tasks WHERE id = ?").get(parentTaskId) as
          | {
              id: string;
              title: string;
              status: string;
            }
          | undefined;
        if (!parent) continue;
        const remaining = db
          .prepare("SELECT COUNT(*) AS cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
          .get(parentTaskId) as { cnt: number } | undefined;
        if ((remaining?.cnt ?? 0) === 0 && parent.status === "review") {
          appendTaskLog(
            parentTaskId,
            "system",
            "All delegated subtasks completed after resume; retrying review completion",
          );
          const yolo = readYoloModeEnabled(db);
          setTimeout(
            () =>
              finishReview(parentTaskId, parent.title, {
                bypassProjectDecisionGate: yolo,
                trigger: "delegated_subtask_completion",
              }),
            1200,
          );
        }
      }
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

  // Move a reviewed task to 'done'
  function finishReview(
    taskId: string,
    taskTitle: string,
    options?: { bypassProjectDecisionGate?: boolean; trigger?: string },
  ): void {
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

    if (!options?.bypassProjectDecisionGate && !currentTask.source_task_id && currentTask.project_id) {
      const gateSnapshot = getProjectReviewGateSnapshot(currentTask.project_id);
      appendTaskLog(
        taskId,
        "system",
        `Review gate: waiting for project-level decision (${gateSnapshot.activeReview}/${gateSnapshot.activeTotal} active tasks in review)`,
      );
      if (gateSnapshot.ready) {
        const now = nowMs();
        const lastNotified = projectReviewGateNotifiedAt.get(currentTask.project_id) ?? 0;
        if (now - lastNotified > 30_000) {
          projectReviewGateNotifiedAt.set(currentTask.project_id, now);
          const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(currentTask.project_id) as
            | { name: string | null }
            | undefined;
          const projectName = (project?.name || currentTask.project_id).trim();
          notifyCeo(
            pickL(
              l([
                `[CEO OFFICE] Project '${projectName}' now has all ${gateSnapshot.activeTotal} active tasks in Review. Approve from Decision Inbox to start team-lead review meetings.`,
              ]),
              lang,
            ),
            taskId,
          );
        }
      } else {
        projectReviewGateNotifiedAt.delete(currentTask.project_id);
      }
      return;
    }
    if (options?.bypassProjectDecisionGate && currentTask.project_id) {
      projectReviewGateNotifiedAt.delete(currentTask.project_id);
      appendTaskLog(taskId, "system", `Review gate bypassed (trigger=${options.trigger ?? "manual"})`);
    }

    const healed = db
      .prepare(
        `
  UPDATE subtasks
  SET status = 'done',
      completed_at = COALESCE(completed_at, ?),
      blocked_reason = NULL
  WHERE task_id = ?
    AND status = 'blocked'
    AND delegated_task_id IS NOT NULL
    AND delegated_task_id != ''
    AND EXISTS (
      SELECT 1
      FROM tasks dt
      WHERE dt.id = subtasks.delegated_task_id
        AND dt.status IN ('review', 'done')
    )
`,
      )
      .run(nowMs(), taskId) as { changes?: number } | undefined;
    if ((healed?.changes ?? 0) > 0) {
      appendTaskLog(
        taskId,
        "system",
        `Review gate auto-heal: recovered ${healed?.changes ?? 0} blocked delegated subtask(s) after successful resume`,
      );
    }

    const remainingSubtaskCount = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')")
        .get(taskId) as { cnt: number }
    ).cnt;
    if (remainingSubtaskCount > 0) {
      notifyCeo(
        pickL(
          l([`'${taskTitle}' is waiting in Review because ${remainingSubtaskCount} subtasks are still unfinished.`]),
          lang,
        ),
        taskId,
      );
      appendTaskLog(taskId, "system", `Review hold: waiting for ${remainingSubtaskCount} unfinished subtasks`);
      return;
    }

    // Parent task must wait until all collaboration children reached review(done) checkpoint.
    if (!currentTask.source_task_id) {
      const childProgress = db
        .prepare(
          `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review_cnt,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_cnt
    FROM tasks
    WHERE source_task_id = ?
  `,
        )
        .get(taskId) as { total: number; review_cnt: number | null; done_cnt: number | null } | undefined;
      const childTotal = childProgress?.total ?? 0;
      const childReview = childProgress?.review_cnt ?? 0;
      const childDone = childProgress?.done_cnt ?? 0;
      const childReady = childReview + childDone;
      if (childTotal > 0 && childReady < childTotal) {
        const waiting = childTotal - childReady;
        notifyCeo(
          pickL(
            l([
              `'${taskTitle}' is waiting for ${waiting} collaboration child task(s) to reach review before the single team-lead meeting starts.`,
            ]),
            lang,
          ),
          taskId,
        );
        appendTaskLog(
          taskId,
          "system",
          `Review hold: waiting for collaboration children to reach review (${childReady}/${childTotal})`,
        );
        return;
      }
    }

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

      // A parent cannot report completion while a collaboration child's integration failed.
      if (!currentTask.source_task_id) {
        const children = db
          .prepare("SELECT id, title FROM tasks WHERE source_task_id = ? AND status = 'review' ORDER BY created_at ASC")
          .all(taskId) as Array<{ id: string; title: string }>;
        for (const child of children) {
          finishReview(child.id, child.title);
          const updatedChild = db.prepare("SELECT status FROM tasks WHERE id = ?").get(child.id) as
            | { status: string }
            | undefined;
          if (updatedChild?.status !== "done") {
            appendTaskLog(
              taskId,
              "system",
              `Review hold: collaboration child ${child.id} has not completed integration`,
            );
            reviewInFlight.delete(taskId);
            return;
          }
        }
      }
      if (wtInfo) {
        cleanupWorktree(wtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up after successful merge");
      }

      db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?").run(t, t, taskId);
      setTaskCreationAuditCompletion(taskId, true);

      appendTaskLog(taskId, "system", "Status → done (all leaders approved)");
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
      notifyCeo(
        pickL(l([`${leaderName}: Final approval completed for '${taskTitle}'.${mergeNote}${progressSuffix}`]), lang),
        taskId,
      );

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

    if (currentTask.source_task_id) {
      appendTaskLog(taskId, "system", "Review consensus skipped for delegated collaboration task");
      finalizeApprovedReview();
      return;
    }

    startReviewConsensusMeeting(taskId, taskTitle, currentTask.department_id, finalizeApprovedReview);
  }

  return {
    reconcileDelegatedSubtasksAfterRun,
    finishReview,
  };
}
