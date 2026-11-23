import path from "node:path";
import { buildCompactKnowledgeBlock } from "../../agent-knowledge.ts";
import { taskToolsScriptPath } from "../core/task-tools-line.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { getDepartmentPrompt } from "../department-lookup.ts";
import {
  routeTaskModel,
  getCurrentTaskModelRoute,
  ensureRunnableAgent,
  RUNNABLE_PROVIDERS,
} from "../../model-routing.ts";
import { ensureTaskWorkModel, isWorkType, resolveWorkFolder, workTypeInstructions } from "../../work-model.ts";
import { getContextRollover, markContextRolloverStarted } from "../agents/context-rollover-store.ts";
import {
  buildCompactContextRolloverPrompt,
  tryBuildCompactInitialTaskPrompt,
} from "../agents/context-rollover-prompt.ts";
import { automaticStartBlockReason } from "../../control-state.ts";
import { autonomyTaskStartBlockReason, admitAutonomyTaskStart } from "../../autonomy-engine.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../core/interrupt-injection-tools.ts";

type CreateExecutionStartTaskToolsDeps = {
  nowMs: RuntimeContext["nowMs"];
  db: RuntimeContext["db"];
  logsDir: RuntimeContext["logsDir"];
  appendTaskLog: RuntimeContext["appendTaskLog"];
  broadcast: RuntimeContext["broadcast"];
  ensureTaskExecutionSession: RuntimeContext["ensureTaskExecutionSession"];
  resolveLang: RuntimeContext["resolveLang"];
  notifyTaskStatus: (...args: any[]) => any;
  resolveProjectPath: RuntimeContext["resolveProjectPath"];
  createWorktree: RuntimeContext["createWorktree"];
  getDeptRoleConstraint: RuntimeContext["getDeptRoleConstraint"];
  getRecentConversationContext: RuntimeContext["getRecentConversationContext"];
  getTaskContinuationContext: RuntimeContext["getTaskContinuationContext"];
  getRecentChanges: RuntimeContext["getRecentChanges"];
  ensureClaudeMd: RuntimeContext["ensureClaudeMd"];
  pickL: RuntimeContext["pickL"];
  l: RuntimeContext["l"];
  buildAvailableSkillsPromptBlock: RuntimeContext["buildAvailableSkillsPromptBlock"];
  buildTaskExecutionPrompt: RuntimeContext["buildTaskExecutionPrompt"];
  hasExplicitWarningFixRequest: RuntimeContext["hasExplicitWarningFixRequest"];
  getNextHttpAgentPid: RuntimeContext["getNextHttpAgentPid"];
  launchApiProviderAgent: RuntimeContext["launchApiProviderAgent"];
  launchHttpAgent: RuntimeContext["launchHttpAgent"];
  getProviderModelConfig: RuntimeContext["getProviderModelConfig"];
  spawnCliAgent: RuntimeContext["spawnCliAgent"];
  handleTaskRunComplete: RuntimeContext["handleTaskRunComplete"];
  notifyCeo: RuntimeContext["notifyCeo"];
  startProgressTimer: RuntimeContext["startProgressTimer"];
  runAgentOneShot: RuntimeContext["runAgentOneShot"];
};

/** What a start attempt did, for callers that report back (the manual Run button). Most callers ignore it. */
export type TaskStartResult =
  | { ok: true; cwd: string; worktree: boolean; pid: number | null; logPath: string }
  | { ok: false; error: string };

export function createExecutionStartTaskTools(deps: CreateExecutionStartTaskToolsDeps) {
  const {
    nowMs,
    db,
    logsDir,
    appendTaskLog,
    broadcast,
    ensureTaskExecutionSession,
    resolveLang,
    notifyTaskStatus,
    resolveProjectPath,
    createWorktree,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getTaskContinuationContext,
    getRecentChanges,
    ensureClaudeMd,
    pickL,
    l,
    buildAvailableSkillsPromptBlock,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    getProviderModelConfig,
    spawnCliAgent,
    handleTaskRunComplete,
    notifyCeo,
    startProgressTimer,
    runAgentOneShot,
  } = deps;

  async function startTaskExecutionForAgent(
    taskId: string,
    execAgent: any,
    deptId: string | null,
    deptName: string,
  ): Promise<TaskStartResult> {
    const blocked =
      automaticStartBlockReason(db, taskId) ||
      admitAutonomyTaskStart(db as any, taskId) ||
      autonomyTaskStartBlockReason(db as any, taskId);
    if (blocked) {
      appendTaskLog(taskId, "system", `Not started: ${blocked}`);
      return { ok: false, error: blocked };
    }
    // An agent with no usable model never blocks work: the VPs give it one first (work restructure, phase 2).
    const checked = ensureRunnableAgent(db as any, execAgent);
    execAgent = checked.agent;
    if (checked.fixed) appendTaskLog(taskId, "system", checked.fixed);
    const execName = execAgent.name;
    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(execAgent.id, t, t, taskId);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(taskId, execAgent.id);
    appendTaskLog(taskId, "system", `${execName} started (approved)`);
    // Work type, business, goal, initiative and importance, filled from what the task links to when missing.
    const workRow = ensureTaskWorkModel(db as any, taskId);
    const workType = isWorkType(workRow?.work_type) ? workRow.work_type : "code";

    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));

    try {
      const route = await routeTaskModel(db as any, taskId, runAgentOneShot);
      if (route) appendTaskLog(taskId, "system", `Model route: ${route.provider}/${route.model} (${route.source})`);
    } catch (error) {
      appendTaskLog(taskId, "system", `Model director unavailable; using agent default: ${String(error)}`);
    }
    const current = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
      | { status: string; assigned_agent_id: string | null }
      | undefined;
    if (current?.status !== "in_progress" || current.assigned_agent_id !== execAgent.id)
      return { ok: false, error: "task_changed_during_model_routing" };
    const admissionBlock = automaticStartBlockReason(db, taskId) || autonomyTaskStartBlockReason(db as any, taskId);
    if (admissionBlock) {
      // Autonomous work is picked up again from planned; pending is a manual inbox state the work engine never scans.
      db.prepare(
        "UPDATE tasks SET status=CASE WHEN origin='autonomy' THEN 'planned' ELSE 'pending' END,started_at=NULL,updated_at=? WHERE id=? AND status='in_progress'",
      ).run(nowMs(), taskId);
      db.prepare("UPDATE agents SET status='idle',current_task_id=NULL WHERE id=? AND current_task_id=?").run(
        execAgent.id,
        taskId,
      );
      appendTaskLog(taskId, "system", `Autonomous launch held after routing: ${admissionBlock}`);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id=?").get(execAgent.id));
      return { ok: false, error: admissionBlock };
    }

    let provider = getCurrentTaskModelRoute(db as any, taskId)?.provider || execAgent.cli_provider || "claude";
    if (!RUNNABLE_PROVIDERS.includes(provider)) {
      appendTaskLog(taskId, "error", `Not started: provider '${provider}' cannot run tasks`);
      return { ok: false, error: "unsupported_provider" };
    }
    let executionSession = ensureTaskExecutionSession(taskId, execAgent.id, provider);
    const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, taskId, executionSession.sessionId);
    const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);

    const taskData = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          title: string;
          description: string | null;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
          base_branch: string | null;
        }
      | undefined;
    if (!taskData) return { ok: false, error: "not_found" };
    const taskLang = resolveLang(taskData.description ?? taskData.title);
    notifyTaskStatus(taskId, taskData.title, "in_progress", taskLang);

    const projPath = resolveProjectPath(taskData);
    const isCode = workType === "code";
    // Only code gets git: a worktree on its own branch. Everything else works in a plain folder (plan section 3.1).
    let worktreePath: string | null = null;
    if (isCode) {
      worktreePath = createWorktree(projPath, taskId, execAgent.name, taskData.base_branch ?? undefined);
    } else {
      try {
        worktreePath = resolveWorkFolder(db as any, workRow ?? {}, projPath || null);
      } catch (error) {
        appendTaskLog(taskId, "error", `Work folder could not be created: ${String(error)}`);
      }
    }
    if (!worktreePath) {
      const rollbackAt = nowMs();
      appendTaskLog(
        taskId,
        "error",
        `Execution blocked: isolated worktree creation failed for project path '${projPath}'`,
      );
      db.prepare("UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = ? WHERE id = ?").run(
        rollbackAt,
        taskId,
      );
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = CASE WHEN current_task_id = ? THEN NULL ELSE current_task_id END WHERE id = ?",
      ).run(taskId, execAgent.id);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id = ?").get(execAgent.id));
      notifyTaskStatus(taskId, taskData.title, "pending", taskLang);
      notifyCeo(
        pickL(
          l([
            isCode
              ? `[WORKTREE REQUIRED] Blocked execution for '${taskData.title}'. Isolated worktree creation failed, so run was aborted to protect the project root.`
              : `Couldn't start '${taskData.title}': its work folder couldn't be created.`,
          ]),
          taskLang,
        ),
        taskId,
      );
      return { ok: false, error: isCode ? "worktree_failed" : "work_folder_failed" };
    }
    const agentCwd = worktreePath;
    if (isCode) {
      appendTaskLog(taskId, "system", `Git worktree created: ${worktreePath} (branch: climpire/${taskId.slice(0, 8)})`);
    } else {
      db.prepare("UPDATE tasks SET work_folder = ? WHERE id = ?").run(worktreePath, taskId);
      appendTaskLog(taskId, "system", `Work folder (${workType}, no git): ${worktreePath}`);
    }
    const logFilePath = path.join(logsDir, `${taskId}.log`);
    const roleLabels: Record<string, string> = {
      team_leader: "Team Leader",
      senior: "Senior",
      junior: "Junior",
      intern: "Intern",
    };
    const roleLabel = roleLabels[execAgent.role] ?? execAgent.role;
    const deptConstraint = deptId ? getDeptRoleConstraint(deptId, deptName) : "";
    const deptPromptRaw = deptId ? getDepartmentPrompt(db as any, deptId) : null;
    const deptPrompt = typeof deptPromptRaw === "string" ? deptPromptRaw.trim() : "";
    const deptPromptBlock = deptPrompt ? `[Department Shared Prompt]\n${deptPrompt}` : "";
    let rollover = null;
    try {
      rollover = getContextRollover(db as any, taskId);
    } catch {
      /* Optional schema in isolated tests. */
    }
    const compactRollover = rollover && rollover.status !== "complete";
    const conversationCtx = compactRollover ? "" : getRecentConversationContext(execAgent.id);
    const continuationCtx = getTaskContinuationContext(taskId);
    const recentChanges = compactRollover || !isCode ? "" : getRecentChanges(projPath, taskId);
    if (provider === "claude" && isCode) {
      ensureClaudeMd(projPath, worktreePath);
    }
    const continuationInstruction = continuationCtx
      ? pickL(
          l([
            "Continuation run: keep ownership, skip greetings/kickoff narration, and execute unresolved review items immediately.",
          ]),
          taskLang,
        )
      : pickL(l(["Execute directly without long preamble and keep messages concise."]), taskLang);
    const runInstruction = pickL(
      l([
        "Please complete the task above thoroughly. Use the continuation brief and conversation context above if relevant.",
      ]),
      taskLang,
    );
    let availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);
    const promptOptions = {
      allowWarningFix: hasExplicitWarningFixRequest(taskData.title, taskData.description),
      workType,
    };
    let initialLocalPrompt: string | null = null;
    const localRoute = getCurrentTaskModelRoute(db as any, taskId);
    if (!compactRollover && localRoute?.provider === "api" && localRoute.context_window_tokens) {
      initialLocalPrompt = tryBuildCompactInitialTaskPrompt(
        {
          projectPath: agentCwd,
          taskId: taskId,
          title: taskData.title,
          description: taskData.description,
          contextWindowTokens: localRoute.context_window_tokens,
          departmentConstraint: deptConstraint,
          departmentSharedPrompt: deptPromptBlock,
          interruptPrompt: interruptPromptBlock,
          continuation: continuationCtx,
          taskToolsPath: taskToolsScriptPath(),
          worktreeBranch: `climpire/${taskId.slice(0, 8)}`,
          knowledge: (maxBytes) => buildCompactKnowledgeBlock(db as any, taskId, maxBytes),
        },
        (parts) => buildTaskExecutionPrompt(parts, promptOptions),
      );
      if (!initialLocalPrompt) {
        const fallback = await routeTaskModel(db as any, taskId, runAgentOneShot, true, true);
        provider = fallback?.provider || execAgent.cli_provider || "claude";
        executionSession = ensureTaskExecutionSession(taskId, execAgent.id, provider);
        availableSkillsPromptBlock = buildAvailableSkillsPromptBlock(provider);
        if (provider === "claude" && isCode) ensureClaudeMd(projPath, worktreePath);
        appendTaskLog(
          taskId,
          "system",
          "Local prompt exceeds context budget; using the configured worker with all task requirements preserved",
        );
      }
    }
    const spawnPrompt =
      initialLocalPrompt ??
      (compactRollover
        ? buildCompactContextRolloverPrompt(
            {
              projectPath: provider === "api" ? agentCwd : undefined,
              taskId,
              title: taskData.title,
              checkpointText: rollover!.checkpointText,
              contextWindowTokens:
                getCurrentTaskModelRoute(db as any, taskId)?.context_window_tokens ?? execAgent.context_window_tokens,
              departmentConstraint: deptConstraint,
              departmentSharedPrompt: deptPromptBlock,
              interruptPrompt: interruptPromptBlock,
              taskToolsPath: taskToolsScriptPath(),
              knowledge: (maxBytes) => buildCompactKnowledgeBlock(db as any, taskId, maxBytes),
              worktreeBranch: `climpire/${taskId.slice(0, 8)}`,
            },
            (parts) => buildTaskExecutionPrompt(parts, promptOptions),
          )
        : buildTaskExecutionPrompt(
            [
              availableSkillsPromptBlock,
              `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
              "This session is scoped to this task only. Keep context continuity inside this task session and do not mix with other projects.",
              recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
              `[Task] ${taskData.title}`,
              taskData.description ? `\n${taskData.description}` : "",
              continuationCtx,
              conversationCtx,
              `\n---`,
              `Agent: ${execAgent.name} (${roleLabel}, ${deptName})`,
              execAgent.personality ? `Personality: ${execAgent.personality}` : "",
              deptConstraint,
              deptPromptBlock,
              workTypeInstructions(workType, worktreePath),
              `If your current model cannot finish this task, write .atlas-model-upgrade.json in the working folder with {"reason":"at least ten characters","model":"optional configured model ID"}, then end this run. The VPs will decide; your work is kept for resume.`,
              interruptPromptBlock,
              continuationInstruction,
              runInstruction,
            ],
            { ...promptOptions, taskId: taskId },
          ));

    if (pendingInterruptPrompts.length > 0) {
      consumeInterruptPrompts(
        db as any,
        pendingInterruptPrompts.map((row) => row.id),
        nowMs(),
      );
      appendTaskLog(
        taskId,
        "system",
        `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
      );
    }

    appendTaskLog(taskId, "system", `RUN start (agent=${execAgent.name}, provider=${provider}, work=${workType})`);
    let launchedPid: number | null = null;
    if (provider === "api") {
      try {
        markContextRolloverStarted(db as any, taskId, nowMs());
      } catch {
        /* Optional schema in isolated tests. */
      }
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchedPid = fakePid;
      launchApiProviderAgent(
        taskId,
        execAgent.api_provider_id ?? null,
        execAgent.api_model ?? null,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
      );
    } else if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
      launchedPid = fakePid;
      launchHttpAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        controller,
        fakePid,
        execAgent.oauth_account_id ?? null,
      );
    } else {
      const modelConfig = getProviderModelConfig();
      const modelForProvider = execAgent.cli_model || modelConfig[provider]?.model || undefined;
      const reasoningLevel =
        provider === "codex"
          ? execAgent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
          : modelConfig[provider]?.reasoningLevel || undefined;
      const child = spawnCliAgent(
        taskId,
        provider,
        spawnPrompt,
        agentCwd,
        logFilePath,
        modelForProvider,
        reasoningLevel,
      );
      launchedPid = typeof child.pid === "number" ? child.pid : null;
      child.on("close", (code: number | null) => {
        handleTaskRunComplete(taskId, code ?? 1);
      });
    }

    // A synchronous policy/transport failure may already have restored the task.
    const launchedTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { status: string }
      | undefined;
    if (launchedTask?.status !== "in_progress") return { ok: false, error: "launch_failed" };
    const worktreeNote = isCode ? pickL(l([` (isolated branch: climpire/${taskId.slice(0, 8)})`]), taskLang) : "";
    notifyCeo(pickL(l([`${execName} started work on '${taskData.title}'.${worktreeNote}`]), taskLang), taskId);
    startProgressTimer(taskId, taskData.title, deptId);
    return { ok: true, cwd: agentCwd, worktree: isCode, pid: launchedPid, logPath: logFilePath };
  }

  return {
    startTaskExecutionForAgent,
  };
}
