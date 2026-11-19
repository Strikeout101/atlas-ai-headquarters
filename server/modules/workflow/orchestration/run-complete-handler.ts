import fs from "node:fs";
import path from "node:path";
import { consumeModelUpgradeMarker, createModelUpgradeRequest, getCurrentTaskModelRoute } from "../../model-routing.ts";
import { buildContextRolloverCheckpoint } from "../agents/context-rollover-checkpoint.ts";
import {
  holdContextRollover,
  markContextRolloverComplete,
  recordContextRollover,
} from "../agents/context-rollover-store.ts";
import { summarizeTaskRunFailure } from "../agents/run-failure-summary.ts";
import { recordAutonomyTaskFailure } from "../../autonomy-engine.ts";
import { captureTaskLessons } from "../../task-lessons.ts";

type CreateRunCompleteHandlerDeps = Record<string, any>;

export function createRunCompleteHandler(deps: CreateRunCompleteHandlerDeps) {
  const {
    activeProcesses,
    stopProgressTimer,
    db,
    stopRequestedTasks,
    stopRequestModeByTask,
    appendTaskLog,
    clearTaskWorkflowState,
    codexThreadToSubtask,
    nowMs,
    logsDir,
    broadcast,
    processSubtaskDelegations,
    taskWorktrees,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    pickL,
    l,
    notifyCeo,
    sendAgentMessage,
    resolveLang,
    formatTaskSubtaskProgressSummary,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    finishReview,
    reconcileDelegatedSubtasksAfterRun,
    completeTaskWithoutReview,
    isReportDesignCheckpointTask,
    extractReportDesignParentTaskId,
    resumeReportAfterDesignCheckpoint,
    isPresentationReportTask,
    readReportFlowValue,
    startReportDesignCheckpoint,
    upsertReportFlowValue,
    isReportRequestTask,
    notifyTaskStatus,
    prettyStreamJson,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
    scheduleContextRolloverResume,
  } = deps;

  function handleTaskRunComplete(
    taskId: string,
    exitCode: number,
    failureKind?: "provider_unavailable" | "worker_interrupted" | "context_exhausted" | "context_near_limit",
  ): void {
    activeProcesses.delete(taskId);
    stopProgressTimer(taskId);

    // Get latest task snapshot early for stop/delete race handling.
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          assigned_agent_id: string | null;
          department_id: string | null;
          title: string;
          description: string | null;
          status: string;
          task_type: string | null;
          project_id: string | null;
          project_path: string | null;
          started_at: number | null;
          source_task_id: string | null;
        }
      | undefined;
    const stopRequested = stopRequestedTasks.has(taskId);
    const stopMode = stopRequestModeByTask.get(taskId);
    stopRequestedTasks.delete(taskId);
    stopRequestModeByTask.delete(taskId);

    // If task was stopped/deleted or no longer in-progress, ignore late close events.
    if (!task || stopRequested || task.status !== "in_progress") {
      if (task) {
        appendTaskLog(
          taskId,
          "system",
          `RUN completion ignored (status=${task.status}, exit=${exitCode}, stop_requested=${stopRequested ? "yes" : "no"}, stop_mode=${stopMode ?? "none"})`,
        );
      }
      const keepWorkflowForResume = stopRequested && stopMode === "pause";
      if (!keepWorkflowForResume) {
        clearTaskWorkflowState(taskId);
      }
      return;
    }

    // Clean up Codex thread→subtask mappings for this task's subtasks
    for (const [tid, itemId] of codexThreadToSubtask) {
      const row = db.prepare("SELECT id FROM subtasks WHERE cli_tool_use_id = ? AND task_id = ?").get(itemId, taskId);
      if (row) codexThreadToSubtask.delete(tid);
    }

    const logPath = path.join(logsDir, `${taskId}.log`);
    const t = nowMs();
    const finalExitCode = exitCode;
    let result: string | null = null;
    try {
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, "utf8");
        result = raw.slice(-2000);
      }
    } catch {
      /* ignore */
    }
    const worktreePath = (taskWorktrees.get(taskId) as { worktreePath?: string } | undefined)?.worktreePath;
    const markerRequest = consumeModelUpgradeMarker(db, taskId, worktreePath);
    let gatewayRequest: Record<string, unknown> | undefined;
    if (task.started_at) {
      try {
        gatewayRequest = db
          .prepare(
            "SELECT * FROM model_upgrade_requests WHERE task_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(taskId, task.started_at) as Record<string, unknown> | undefined;
      } catch {
        // Older isolated test databases do not load the optional routing schema.
      }
    }
    const upgradeRequest = markerRequest ?? gatewayRequest;
    if (upgradeRequest) {
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ?").run(result, t, taskId);
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
      }
      appendTaskLog(taskId, "system", `Model upgrade requested (${upgradeRequest.id}); worktree preserved for resume.`);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyCeo(`Model upgrade requested for '${task.title}'. The task is pending with its work preserved.`, taskId);
      return;
    }
    let sshApproval: { id: string; status: string } | undefined;
    if (task.started_at) {
      try {
        sshApproval = db
          .prepare(
            `SELECT id,status FROM homelab_ssh_approvals
          WHERE task_id = ? AND created_at >= ?
            AND (status = 'pending' OR (status = 'approved' AND COALESCE(decided_by, '') <> 'auto_read_only'))
          ORDER BY created_at DESC LIMIT 1`,
          )
          .get(taskId, task.started_at) as typeof sshApproval;
      } catch {
        // The SSH manager is optional in isolated test databases.
      }
    }
    if (sshApproval) {
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ?").run(result, t, taskId);
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
      }
      appendTaskLog(
        taskId,
        "system",
        `SSH command approval ${sshApproval.id} is ${sshApproval.status}; task preserved for resume.`,
      );
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyCeo(
        `SSH command approval needed for '${task.title}'. Review it on Today or in Homelab, then resume the task.`,
        taskId,
      );
      return;
    }
    let emailApproval: { id: string; status: string } | undefined;
    if (task.started_at) {
      try {
        emailApproval = db
          .prepare(
            `SELECT id,status FROM business_email_approvals
          WHERE task_id = ? AND status IN ('pending','sending','failed','unknown')
          ORDER BY created_at DESC LIMIT 1`,
          )
          .get(taskId) as typeof emailApproval;
      } catch {
        // Email tools are optional in isolated test databases.
      }
    }
    if (emailApproval) {
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ?").run(result, t, taskId);
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
      }
      appendTaskLog(
        taskId,
        "system",
        `Email approval/delivery ${emailApproval.id} is ${emailApproval.status}; task preserved for resume.`,
      );
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyCeo(
        `Email approval/delivery requires attention for '${task.title}'. Review Today or email history; work is preserved.`,
        taskId,
      );
      return;
    }
    if (failureKind === "context_exhausted" || failureKind === "context_near_limit") {
      let checkpointError: string | null = null;
      try {
        if (!worktreePath || !task.assigned_agent_id) throw new Error("worktree_or_agent_missing");
        const checkpoint = buildContextRolloverCheckpoint({
          db,
          taskId,
          title: task.title,
          description: task.description,
          worktreePath,
          logPath,
          reason: failureKind,
        });
        const agent = db.prepare("SELECT api_model FROM agents WHERE id = ?").get(task.assigned_agent_id) as
          | { api_model: string | null }
          | undefined;
        const route = getCurrentTaskModelRoute(db, taskId);
        const model = route?.provider === "api" ? route.model : agent?.api_model || "unknown";
        const rollover = recordContextRollover(db, {
          taskId,
          agentId: task.assigned_agent_id,
          model,
          attemptId: String(task.started_at ?? t),
          reason: failureKind,
          checkpointText: checkpoint.checkpointText,
          progressFingerprint: checkpoint.progressFingerprint,
          now: t,
        });
        db.prepare(
          "UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'",
        ).run(result, t, taskId);
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        appendTaskLog(
          taskId,
          "system",
          `CONTEXT rollover ${rollover.rolloverCount}: ${failureKind}; stalled=${rollover.stalledCount}; ${rollover.status}`,
        );
        broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
        if (rollover.status === "pending_resume") {
          if (!rollover.duplicate) scheduleContextRolloverResume(taskId);
        } else {
          const report = `Local agent reached its context limit during '${task.title}' after ${rollover.rolloverCount} rollovers (${rollover.stalledCount} stalled). Worktree and checkpoint are preserved. Review model upgrade or split the task.`;
          const leader = findTeamLeader(task.department_id);
          if (leader && leader.status !== "offline" && leader.id !== task.assigned_agent_id) {
            sendAgentMessage(leader, report, "report", "all", null, taskId);
          }
          notifyCeo(report, taskId);
          try {
            const request = createModelUpgradeRequest(db, taskId, report);
            appendTaskLog(taskId, "system", `Context rollover upgrade ${request.id} awaits VP review.`);
          } catch (error) {
            appendTaskLog(taskId, "system", `Context rollover requires director review: ${String(error)}`);
          }
        }
        return;
      } catch (error) {
        checkpointError = String(error);
      }
      try {
        holdContextRollover(db, taskId, t);
      } catch {
        /* Preserve pending task if checkpoint storage failed. */
      }
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ?").run(result, t, taskId);
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
      }
      appendTaskLog(taskId, "error", `Context rollover paused; checkpoint or restart setup failed: ${checkpointError}`);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyCeo(`Context rollover paused for '${task.title}'. Worktree preserved; review is needed.`, taskId);
      return;
    }
    if (failureKind && exitCode !== 0) {
      if (failureKind === "provider_unavailable" || failureKind === "worker_interrupted")
        recordAutonomyTaskFailure(
          db,
          taskId,
          "Autonomous worker stopped unexpectedly or its provider became unavailable",
          t,
        );
      try {
        holdContextRollover(db, taskId, t);
      } catch {
        /* Optional schema in isolated tests. */
      }
      const reason =
        failureKind === "provider_unavailable" ? "Provider connection lost" : "Local coding worker stopped";
      const handoff = `HANDOFF: ${reason} while ${task.assigned_agent_id ?? "unassigned agent"} worked on '${task.title}'. Task remains assigned and pending. Preserve the worktree and resume from the previous output after the worker is ready.`;
      db.prepare("UPDATE tasks SET status = 'pending', result = ?, updated_at = ? WHERE id = ?").run(result, t, taskId);
      appendTaskLog(taskId, "system", handoff);
      if (task.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = ?, current_task_id = NULL WHERE id = ?").run(
          failureKind === "provider_unavailable" ? "offline" : "idle",
          task.assigned_agent_id,
        );
        broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id));
      }
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      notifyTaskStatus(taskId, task.title, "pending", resolveLang(task.description ?? task.title));
      const leader = findTeamLeader(task.department_id);
      if (leader && leader.status !== "offline" && leader.id !== task.assigned_agent_id) {
        sendAgentMessage(leader, handoff, "report", "all", null, taskId);
      }
      notifyCeo(`${reason} during '${task.title}'. The task is pending with its work preserved.`, taskId);
      return;
    }
    const logKind = finalExitCode === 0 ? "completed" : "failed";
    appendTaskLog(taskId, "system", `RUN ${logKind} (exit code: ${finalExitCode})`);
    if (finalExitCode !== 0) {
      recordAutonomyTaskFailure(db, taskId, `Autonomous run failed (exit code ${finalExitCode})`, t);
      try {
        const logFile = path.join(logsDir, `${taskId}.log`);
        if (fs.existsSync(logFile)) {
          const summary = summarizeTaskRunFailure(fs.readFileSync(logFile, "utf8"));
          if (summary) appendTaskLog(taskId, "error", `Run failed: ${summary}`);
        }
      } catch {
        // A missing or rotating terminal log must not block task completion handling.
      }
    }

    if (result) {
      db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(result, taskId);
    }

    // Auto-complete own-department subtasks on CLI success; foreign ones get delegated
    if (finalExitCode === 0) {
      try {
        markContextRolloverComplete(db, taskId, t);
      } catch {
        /* Optional schema in isolated tests. */
      }
      const pendingSubtasks = db
        .prepare(
          "SELECT id, target_department_id FROM subtasks WHERE task_id = ? AND status NOT IN ('done', 'cancelled')",
        )
        .all(taskId) as Array<{ id: string; target_department_id: string | null }>;
      if (pendingSubtasks.length > 0) {
        const now = nowMs();
        for (const sub of pendingSubtasks) {
          // Only auto-complete subtasks without a foreign department target
          if (!sub.target_department_id) {
            db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, sub.id);
            const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
            broadcast("subtask_update", updated);
          }
        }
      }
      // Trigger delegation for foreign-department subtasks
      processSubtaskDelegations(taskId);

      // Did the agent leave lessons? Saves LESSON:/FACT: lines from the output when it did not call memory.add.
      try {
        const runLog = path.join(logsDir, `${taskId}.log`);
        const output = fs.existsSync(runLog) ? prettyStreamJson(fs.readFileSync(runLog, "utf8").slice(-200_000)) : "";
        const lessons = captureTaskLessons(db as any, { taskId, agentId: task?.assigned_agent_id ?? null, output });
        const note =
          lessons.outcome === "agent_added"
            ? `Lessons: ${lessons.saved} saved by the agent`
            : lessons.outcome === "captured"
              ? `Lessons: ${lessons.saved} saved from the final output (unreviewed)`
              : lessons.outcome === "none_declared"
                ? "Lessons: the agent reported none"
                : "Lessons: none left by the agent";
        appendTaskLog(taskId, "system", note);
      } catch {
        /* lessons never block completion */
      }
    }

    // Update agent status back to idle
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);

      if (finalExitCode === 0) {
        db.prepare(
          "UPDATE agents SET stats_tasks_done = stats_tasks_done + 1, stats_xp = stats_xp + 10 WHERE id = ?",
        ).run(task.assigned_agent_id);
      }

      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as
        | Record<string, unknown>
        | undefined;
      broadcast("agent_status", agent);
    }

    if (finalExitCode === 0 && task) {
      if (isReportDesignCheckpointTask(task)) {
        const parentTaskId = extractReportDesignParentTaskId(task);
        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report design checkpoint completed; review meeting skipped)",
        );
        if (parentTaskId) {
          resumeReportAfterDesignCheckpoint(parentTaskId, taskId);
        }
        return;
      }

      if (isPresentationReportTask(task)) {
        const designReview = (readReportFlowValue(task.description, "design_review") ?? "pending").toLowerCase();
        if (designReview !== "done") {
          const started = startReportDesignCheckpoint({
            id: taskId,
            title: task.title,
            description: task.description,
            project_id: task.project_id,
            project_path: task.project_path,
            assigned_agent_id: task.assigned_agent_id,
          });
          if (started) return;
          const fallbackDesc = upsertReportFlowValue(
            upsertReportFlowValue(task.description, "design_review", "skipped"),
            "final_regen",
            "ready",
          );
          db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(
            fallbackDesc,
            nowMs(),
            taskId,
          );
        }

        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report workflow: final PPT regenerated; second design confirmation skipped)",
        );
        return;
      }

      if (isReportRequestTask(task)) {
        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report workflow: review meeting skipped for documentation/report task)",
        );
        return;
      }
    }

    if (finalExitCode === 0) {
      // ── SUCCESS: Move to 'review' for team leader check ──
      db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(t, taskId);

      appendTaskLog(taskId, "system", "Status → review (team leader review pending)");

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
      if (task) notifyTaskStatus(taskId, task.title, "review", resolveLang(task.description ?? task.title));

      // Collaboration child tasks should wait in review until parent consolidation meeting.
      // Queue continuation is still triggered so sequential delegation does not stall.
      if (task?.source_task_id) {
        reconcileDelegatedSubtasksAfterRun(taskId, 0);
        const sourceLang = resolveLang(task.description ?? task.title);
        appendTaskLog(
          taskId,
          "system",
          "Status → review (delegated collaboration task waiting for parent consolidation)",
        );
        notifyCeo(
          pickL(
            l([
              `'${task.title}' collaboration child task is now waiting in Review. It will be consolidated in the parent task's single review/merge meeting.`,
            ]),
            sourceLang,
          ),
          taskId,
        );

        const nextDelay = 800 + Math.random() * 600;
        const nextCallback = crossDeptNextCallbacks.get(taskId);
        if (nextCallback) {
          crossDeptNextCallbacks.delete(taskId);
          setTimeout(nextCallback, nextDelay);
        } else {
          recoverCrossDeptQueueAfterMissingCallback(taskId);
        }
        const subtaskNext = subtaskDelegationCallbacks.get(taskId);
        if (subtaskNext) {
          subtaskDelegationCallbacks.delete(taskId);
          setTimeout(subtaskNext, nextDelay);
        }
        return;
      }

      // Notify: task entering review
      if (task) {
        const lang = resolveLang(task.description ?? task.title);
        const leader = findTeamLeader(task.department_id);
        const leaderName = leader ? getAgentDisplayName(leader, lang) : pickL(l(["Team Lead"]), lang);
        notifyCeo(pickL(l([`${leaderName} is reviewing the result for '${task.title}'.`]), lang), taskId);
      }

      // Schedule team leader review message (2-3s delay)
      setTimeout(() => {
        if (!task) return;
        const leader = findTeamLeader(task.department_id);
        if (!leader) {
          // No team leader — auto-approve
          finishReview(taskId, task.title);
          return;
        }

        // Read the task result and pretty-parse it for the report
        let reportBody = "";
        try {
          const logFile = path.join(logsDir, `${taskId}.log`);
          if (fs.existsSync(logFile)) {
            const raw = fs.readFileSync(logFile, "utf8");
            const pretty = prettyStreamJson(raw);
            // Take the last ~500 chars of the pretty output as summary
            reportBody = pretty.length > 500 ? "..." + pretty.slice(-500) : pretty;
          }
        } catch {
          /* ignore */
        }

        // If worktree exists, include diff summary in the report
        const wtInfo = taskWorktrees.get(taskId);
        let diffSummary = "";
        if (wtInfo) {
          diffSummary = getWorktreeDiffSummary(wtInfo.projectPath, taskId);
          if (hasVisibleDiffSummary(diffSummary)) {
            appendTaskLog(taskId, "system", `Worktree diff summary:\n${diffSummary}`);
          }
        }

        // Team leader sends completion report with actual result content + diff
        const reportLang = resolveLang(task.description ?? task.title);
        let reportContent = reportBody
          ? pickL(l([`CEO, reporting completion for '${task.title}'.\n\n📋 Result:\n${reportBody}`]), reportLang)
          : pickL(
              l([`CEO, reporting completion for '${task.title}'. The work has been finished successfully.`]),
              reportLang,
            );

        const subtaskProgressLabel = pickL(l(["📌 Remediation/Collaboration Progress"]), reportLang);
        const subtaskProgress = formatTaskSubtaskProgressSummary(taskId, reportLang);
        if (subtaskProgress) {
          reportContent += `\n\n${subtaskProgressLabel}\n${subtaskProgress}`;
        }

        if (hasVisibleDiffSummary(diffSummary)) {
          reportContent += pickL(l([`\n\n📝 Changes (branch: ${wtInfo?.branchName}):\n${diffSummary}`]), reportLang);
        }

        sendAgentMessage(leader, reportContent, "report", "all", null, taskId);

        // After another 2-3s: team leader approves → move to done
        setTimeout(() => {
          finishReview(taskId, task.title);
        }, 2500);
      }, 2500);
    } else {
      // ── FAILURE: Reset to inbox, team leader reports failure ──
      db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(t, taskId);

      if (task?.source_task_id) {
        reconcileDelegatedSubtasksAfterRun(taskId, finalExitCode);
      }

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);

      // Clean up worktree on failure — failed work shouldn't persist
      const failWtInfo = taskWorktrees.get(taskId);
      if (failWtInfo) {
        cleanupWorktree(failWtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up (task failed)");
      }

      if (task) {
        const leader = findTeamLeader(task.department_id);
        if (leader) {
          setTimeout(() => {
            // Read error output for failure report
            let errorBody = "";
            try {
              const logFile = path.join(logsDir, `${taskId}.log`);
              if (fs.existsSync(logFile)) {
                const raw = fs.readFileSync(logFile, "utf8");
                const pretty = prettyStreamJson(raw);
                errorBody = pretty.length > 300 ? "..." + pretty.slice(-300) : pretty;
              }
            } catch {
              /* ignore */
            }

            const failLang = resolveLang(task.description ?? task.title);
            const failContent = errorBody
              ? pickL(
                  l([
                    `CEO, '${task.title}' failed with an issue (exit code: ${finalExitCode}).\n\n❌ Error:\n${errorBody}\n\nPlease reassign the agent or revise the task, then try again.`,
                  ]),
                  failLang,
                )
              : pickL(
                  l([
                    `CEO, '${task.title}' failed with an issue (exit code: ${finalExitCode}). Please reassign the agent or revise the task, then try again.`,
                  ]),
                  failLang,
                );

            sendAgentMessage(leader, failContent, "report", "all", null, taskId);
          }, 1500);
        }
        const failLang = resolveLang(task.description ?? task.title);
        notifyCeo(pickL(l([`Task '${task.title}' failed (exit code: ${finalExitCode}).`]), failLang), taskId);
      }

      // Even on failure, trigger next cross-dept cooperation so the queue doesn't stall
      const nextCallback = crossDeptNextCallbacks.get(taskId);
      if (nextCallback) {
        crossDeptNextCallbacks.delete(taskId);
        setTimeout(nextCallback, 3000);
      }

      // Even on failure, trigger next subtask delegation so the queue doesn't stall
      const subtaskNext = subtaskDelegationCallbacks.get(taskId);
      if (subtaskNext) {
        subtaskDelegationCallbacks.delete(taskId);
        setTimeout(subtaskNext, 3000);
      }
    }
  }

  return {
    handleTaskRunComplete,
  };
}
