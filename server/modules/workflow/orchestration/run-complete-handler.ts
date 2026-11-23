import fs from "node:fs";
import { cleanRunResult } from "../../task-result.ts";
import path from "node:path";
import { consumeModelUpgradeMarker, createModelUpgradeRequest, getCurrentTaskModelRoute } from "../../model-routing.ts";
import { buildContextRolloverCheckpoint } from "../agents/context-rollover-checkpoint.ts";
import {
  holdContextRollover,
  markContextRolloverComplete,
  recordContextRollover,
} from "../agents/context-rollover-store.ts";
import { summarizeTaskRunFailure } from "../agents/run-failure-summary.ts";
import { recordStepFailure } from "../../work-engine.ts";
import { captureTaskLessons } from "../../task-lessons.ts";
import { ensureHandoffAfterRun } from "../../work-model.ts";

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
    startTaskReview,
    helperTaskFinished,
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
        // The agent's readable output; the raw stream ends with usage, cost and credential data.
        result = cleanRunResult(fs.readFileSync(logPath, "utf8"));
      }
    } catch {
      /* ignore */
    }
    // Code tasks run in a git worktree; every other kind runs in a plain work folder (work restructure).
    const worktreePath =
      (taskWorktrees.get(taskId) as { worktreePath?: string } | undefined)?.worktreePath ??
      ((task as { work_folder?: string | null }).work_folder || undefined);
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
        recordStepFailure(db, taskId, "the worker stopped unexpectedly or its provider became unavailable", t);
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
      recordStepFailure(db, taskId, `the run failed (exit code ${finalExitCode})`, t);
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
      // Subtasks are marked done only by the agent (its own todo events or subtask.done), never by a clean exit.
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
        // The next step and the reviewer read the hand-off, not the log. Write one if the agent skipped task.handoff.
        const handoff = ensureHandoffAfterRun(db as any, taskId, output);
        if (handoff?.generated)
          appendTaskLog(
            taskId,
            "system",
            "Hand-off: the agent skipped task.handoff; ATLAS wrote one from the final output",
          );
        else if (handoff)
          appendTaskLog(taskId, "system", `Hand-off saved by the agent (${handoff.files.length} file(s))`);
      } catch {
        /* lessons and hand-offs never block completion */
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
      // ── SUCCESS: one reviewer on the other model checks it (task-review.ts) ──
      db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(t, taskId);
      appendTaskLog(taskId, "system", "Status → review");
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      if (task) notifyTaskStatus(taskId, task.title, "review", resolveLang(task.description ?? task.title));

      if (task?.source_task_id) {
        // A helper task's result is checked by its parent's reviewer (with its hand-off), so it finishes here.
        reconcileDelegatedSubtasksAfterRun(taskId, 0);
        appendTaskLog(taskId, "system", "Helper task: its parent's reviewer checks this hand-off");
        finishReview(taskId, task.title);
        helperTaskFinished?.(taskId, task.source_task_id);
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

      startTaskReview?.(taskId);
    } else {
      // ── FAILURE: Reset to inbox, team leader reports failure ──
      db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(t, taskId);

      if (task?.source_task_id) {
        reconcileDelegatedSubtasksAfterRun(taskId, finalExitCode);
      }

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);

      // Keep the work: a retry or "Resume" continues from it instead of starting over (work restructure, phase 2).
      // Worktrees are cleaned up when the task is finished or cancelled.
      if (taskWorktrees.get(taskId)) appendTaskLog(taskId, "system", "Worktree kept so the next attempt can continue");

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
