import path from "node:path";
import { buildCompactKnowledgeBlock } from "../../agent-knowledge.ts";
import { taskToolsScriptPath } from "../core/task-tools-line.ts";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { getDepartmentPrompt } from "../department-lookup.ts";
import { routeTaskModel, getCurrentTaskModelRoute } from "../../model-routing.ts";
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
  ): Promise<void> {
    const blocked =
      automaticStartBlockReason(db, taskId) ||
      admitAutonomyTaskStart(db as any, taskId) ||
      autonomyTaskStartBlockReason(db as any, taskId);
    if (blocked) {
      appendTaskLog(taskId, "system", `Not started: ${blocked}`);
      return;
    }
    const execName = execAgent.name;
    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(execAgent.id, t, t, taskId);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(taskId, execAgent.id);
    appendTaskLog(taskId, "system", `${execName} started (approved)`);

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
    if (current?.status !== "in_progress" || current.assigned_agent_id !== execAgent.id) return;
    const admissionBlock = automaticStartBlockReason(db, taskId) || autonomyTaskStartBlockReason(db as any, taskId);
    if (admissionBlock) {
      db.prepare("UPDATE tasks SET status='pending',updated_at=? WHERE id=? AND status='in_progress'").run(
        nowMs(),
        taskId,
      );
      db.prepare("UPDATE agents SET status='idle',current_task_id=NULL WHERE id=? AND current_task_id=?").run(
        execAgent.id,
        taskId,
      );
      appendTaskLog(taskId, "system", `Autonomous launch held after routing: ${admissionBlock}`);
      broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId));
      broadcast("agent_status", db.prepare("SELECT * FROM agents WHERE id=?").get(execAgent.id));
      return;
    }

    let provider = getCurrentTaskModelRoute(db as any, taskId)?.provider || execAgent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"].includes(provider)) return;
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
    if (!taskData) return;
    const taskLang = resolveLang(taskData.description ?? taskData.title);
    notifyTaskStatus(taskId, taskData.title, "in_progress", taskLang);

    const projPath = resolveProjectPath(taskData);
    const worktreePath = createWorktree(projPath, taskId, execAgent.name, taskData.base_branch ?? undefined);
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
            `[WORKTREE REQUIRED] Blocked execution for '${taskData.title}'. Isolated worktree creation failed, so run was aborted to protect the project root.`,
          ]),
          taskLang,
        ),
        taskId,
      );
      return;
    }
    const agentCwd = worktreePath;
    appendTaskLog(taskId, "system", `Git worktree created: ${worktreePath} (branch: climpire/${taskId.slice(0, 8)})`);
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
    const recentChanges = compactRollover ? "" : getRecentChanges(projPath, taskId);
    if (provider === "claude") {
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
    const promptOptions = { allowWarningFix: hasExplicitWarningFixRequest(taskData.title, taskData.description) };
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
        if (provider === "claude") ensureClaudeMd(projPath, worktreePath);
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
              `NOTE: You are working in an isolated Git worktree branch (climpire/${taskId.slice(0, 8)}). Run relevant tests, but do not commit until the user explicitly approves.`,
              `If your current model cannot finish this task, write .climpire-model-upgrade.json at the worktree root with {"reason":"at least ten characters","model":"optional configured model ID"}, then end this run. The director will decide; the worktree will be preserved for resume.`,
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

    appendTaskLog(taskId, "system", `RUN start (agent=${execAgent.name}, provider=${provider})`);
    if (provider === "api") {
      try {
        markContextRolloverStarted(db as any, taskId, nowMs());
      } catch {
        /* Optional schema in isolated tests. */
      }
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();
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
      child.on("close", (code: number | null) => {
        handleTaskRunComplete(taskId, code ?? 1);
      });
    }

    // A synchronous policy/transport failure may already have restored the task.
    const launchedTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | { status: string }
      | undefined;
    if (launchedTask?.status !== "in_progress") return;
    const worktreeNote = pickL(l([` (isolated branch: climpire/${taskId.slice(0, 8)})`]), taskLang);
    notifyCeo(pickL(l([`${execName} started work on '${taskData.title}'.${worktreeNote}`]), taskLang), taskId);
    startProgressTimer(taskId, taskData.title, deptId);
  }

  return {
    startTaskExecutionForAgent,
  };
}
