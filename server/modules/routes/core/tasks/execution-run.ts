import path from "node:path";
import { buildCompactKnowledgeBlock } from "../../../agent-knowledge.ts";
import { taskToolsScriptPath } from "../../../workflow/core/task-tools-line.ts";
import { areRunsAllowed, RUNS_HALTED_ERROR } from "../../../control-state.ts";
import { notifyTaskStatus } from "../../../../gateway/client.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../shared/types.ts";
import { resolveConstrainedAgentScopeForTask, selectAutoAssignableAgentForTask } from "./execution-run-auto-assign.ts";
import { routeTaskModel, getCurrentTaskModelRoute } from "../../../model-routing.ts";
import { getContextRollover } from "../../../workflow/agents/context-rollover-store.ts";
import {
  buildCompactContextRolloverPrompt,
  tryBuildCompactInitialTaskPrompt,
} from "../../../workflow/agents/context-rollover-prompt.ts";
import {
  buildInterruptPromptBlock,
  consumeInterruptPrompts,
  loadPendingInterruptPrompts,
} from "../../../workflow/core/interrupt-injection-tools.ts";

export type TaskRunRouteDeps = Pick<
  RuntimeContext,
  | "app"
  | "db"
  | "activeProcesses"
  | "appendTaskLog"
  | "nowMs"
  | "resolveLang"
  | "ensureTaskExecutionSession"
  | "resolveProjectPath"
  | "logsDir"
  | "createWorktree"
  | "generateProjectContext"
  | "getRecentChanges"
  | "ensureClaudeMd"
  | "getDeptRoleConstraint"
  | "normalizeTextField"
  | "getRecentConversationContext"
  | "getTaskContinuationContext"
  | "pickL"
  | "l"
  | "getProviderModelConfig"
  | "buildTaskExecutionPrompt"
  | "hasExplicitWarningFixRequest"
  | "getNextHttpAgentPid"
  | "broadcast"
  | "getAgentDisplayName"
  | "notifyCeo"
  | "startProgressTimer"
  | "launchApiProviderAgent"
  | "launchHttpAgent"
  | "spawnCliAgent"
  | "handleTaskRunComplete"
  | "buildAvailableSkillsPromptBlock"
  | "runAgentOneShot"
>;

export function registerTaskRunRoute(deps: TaskRunRouteDeps): void {
  const {
    app,
    db,
    activeProcesses,
    appendTaskLog,
    nowMs,
    resolveLang,
    ensureTaskExecutionSession,
    resolveProjectPath,
    logsDir,
    createWorktree,
    generateProjectContext,
    getRecentChanges,
    ensureClaudeMd,
    getDeptRoleConstraint,
    normalizeTextField,
    getRecentConversationContext,
    getTaskContinuationContext,
    pickL,
    l,
    getProviderModelConfig,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    getNextHttpAgentPid,
    broadcast,
    getAgentDisplayName,
    notifyCeo,
    startProgressTimer,
    launchApiProviderAgent,
    launchHttpAgent,
    spawnCliAgent,
    handleTaskRunComplete,
    buildAvailableSkillsPromptBlock,
    runAgentOneShot,
  } = deps;

  app.post("/api/tasks/:id/run", async (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          title: string;
          description: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
          project_id: string | null;
          project_path: string | null;
          status: string;
        }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (!areRunsAllowed()) return res.status(409).json({ error: RUNS_HALTED_ERROR });
    const taskLang = resolveLang(task.description ?? task.title);

    if (activeProcesses.has(id)) {
      const staleChild = activeProcesses.get(id);
      const stalePid = typeof staleChild?.pid === "number" ? staleChild.pid : null;
      let pidIsAlive = false;
      if (stalePid !== null && stalePid > 0) {
        try {
          process.kill(stalePid, 0);
          pidIsAlive = true;
        } catch {
          pidIsAlive = false;
        }
      }
      if (!pidIsAlive) {
        activeProcesses.delete(id);
        appendTaskLog(id, "system", `Cleaned up stale process handle (pid=${stalePid}) on re-run attempt`);
      }
    }

    if (task.status === "in_progress" || task.status === "collaborating") {
      if (activeProcesses.has(id)) {
        return res.status(400).json({ error: "already_running" });
      }
      const t = nowMs();
      db.prepare("UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?").run(t, id);
      task.status = "pending";
      appendTaskLog(id, "system", `Reset stale in_progress status (no active process) for re-run`);
    }

    if (activeProcesses.has(id)) {
      return res.status(409).json({
        error: "process_still_active",
        message: "Previous run is still stopping. Please retry after a moment.",
      });
    }

    let agentId = task.assigned_agent_id || (req.body?.agent_id as string | undefined);
    if (agentId) {
      const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db as any, {
        department_id: task.department_id,
        project_id: task.project_id,
      });
      if (
        Array.isArray(constrainedAgentIds) &&
        constrainedAgentIds.length > 0 &&
        !constrainedAgentIds.includes(agentId)
      ) {
        appendTaskLog(
          id,
          "system",
          `Assigned agent (${agentId}) is not assigned to this project. Re-selecting an agent.`,
        );
        agentId = undefined;
      }
    }
    if (!agentId) {
      const autoSelected = selectAutoAssignableAgentForTask(db as any, {
        department_id: task.department_id,
        project_id: task.project_id,
      });
      if (autoSelected) {
        agentId = autoSelected.agent.id;
        const assignedAt = nowMs();
        db.prepare(
          "UPDATE tasks SET assigned_agent_id = ?, department_id = COALESCE(department_id, ?), status = CASE WHEN status = 'inbox' THEN 'planned' ELSE status END, updated_at = ? WHERE id = ?",
        ).run(agentId, autoSelected.agent.department_id, assignedAt, id);
        db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(id, agentId);
        appendTaskLog(id, "system", `Auto-assigned: ${autoSelected.agent.name}`);
      }
    }
    if (!agentId) {
      return res.status(400).json({
        error: "no_agent_assigned",
        message: "Assign an agent before running.",
      });
    }

    let agent:
      | {
          id: string;
          name: string;
          name_ko: string | null;
          role: string;
          cli_provider: string | null;
          oauth_account_id: string | null;
          api_provider_id: string | null;
          api_model: string | null;
          context_window_tokens: number | null;
          cli_model: string | null;
          cli_reasoning_level: string | null;
          personality: string | null;
          department_id: string | null;
          department_name: string | null;
          department_name_ko: string | null;
          department_prompt: string | null;
        }
      | undefined;
    try {
      agent = db
        .prepare(
          `
      SELECT
        a.*,
        d.name AS department_name,
        d.name_ko AS department_name_ko,
        d.prompt AS department_prompt
      FROM agents a
      LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(agentId) as
        | {
            id: string;
            name: string;
            name_ko: string | null;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            context_window_tokens: number | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_name_ko: string | null;
            department_prompt: string | null;
          }
        | undefined;
    } catch {
      agent = db
        .prepare(
          `
      SELECT a.*, d.name AS department_name, d.name_ko AS department_name_ko, d.prompt AS department_prompt
      FROM agents a LEFT JOIN departments d ON a.department_id = d.id
      WHERE a.id = ?
    `,
        )
        .get(agentId) as
        | {
            id: string;
            name: string;
            name_ko: string | null;
            role: string;
            cli_provider: string | null;
            oauth_account_id: string | null;
            api_provider_id: string | null;
            api_model: string | null;
            context_window_tokens: number | null;
            cli_model: string | null;
            cli_reasoning_level: string | null;
            personality: string | null;
            department_id: string | null;
            department_name: string | null;
            department_name_ko: string | null;
            department_prompt: string | null;
          }
        | undefined;
    }
    if (!agent) return res.status(400).json({ error: "agent_not_found" });

    if (!task.assigned_agent_id) {
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(agentId, nowMs(), id);
    }

    const agentBusy = activeProcesses.has(
      (
        db.prepare("SELECT current_task_id FROM agents WHERE id = ? AND status = 'working'").get(agentId) as
          | { current_task_id: string | null }
          | undefined
      )?.current_task_id ?? "",
    );
    if (agentBusy) {
      return res
        .status(400)
        .json({ error: "agent_busy", message: `${agent.name} is already working on another task.` });
    }

    try {
      const selectedRoute = await routeTaskModel(db as any, id, runAgentOneShot);
      if (selectedRoute)
        appendTaskLog(
          id,
          "system",
          `Model route: ${selectedRoute.provider}/${selectedRoute.model} (${selectedRoute.source})`,
        );
    } catch (err) {
      appendTaskLog(id, "system", `Model director unavailable; using agent default: ${String(err)}`);
    }
    const currentTask = db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id = ?").get(id) as
      | { status: string; assigned_agent_id: string | null }
      | undefined;
    if (
      !currentTask ||
      activeProcesses.has(id) ||
      currentTask.status === "in_progress" ||
      currentTask.assigned_agent_id !== agentId
    ) {
      return res.status(409).json({ error: "task_changed_during_model_routing" });
    }
    let provider = getCurrentTaskModelRoute(db as any, id)?.provider || agent.cli_provider || "claude";
    if (!["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"].includes(provider)) {
      return res.status(400).json({ error: "unsupported_provider", provider });
    }
    let executionSession = ensureTaskExecutionSession(id, agentId, provider);
    const pendingInterruptPrompts = loadPendingInterruptPrompts(db as any, id, executionSession.sessionId);
    const interruptPromptBlock = buildInterruptPromptBlock(pendingInterruptPrompts);

    const projectPath = resolveProjectPath(task) || (req.body?.project_path as string | undefined) || process.cwd();
    const logPath = path.join(logsDir, `${id}.log`);

    const worktreePath = createWorktree(projectPath, id, agent.name);
    if (!worktreePath) {
      appendTaskLog(
        id,
        "error",
        `Execution blocked: isolated worktree creation failed for project path '${projectPath}'`,
      );
      return res.status(409).json({
        error: "worktree_required",
        message: "Isolated worktree creation failed. Task execution was blocked to protect the project root.",
      });
    }
    const agentCwd = worktreePath;

    appendTaskLog(id, "system", `Git worktree created: ${worktreePath} (branch: climpire/${id.slice(0, 8)})`);

    let rollover: ReturnType<typeof getContextRollover> = null;
    try {
      rollover = getContextRollover(db as any, id);
    } catch {
      /* Optional schema in isolated tests. */
    }
    const compactRollover = rollover && rollover.status !== "complete";
    const projectContext = compactRollover ? "" : generateProjectContext(projectPath);
    const recentChanges = compactRollover ? "" : getRecentChanges(projectPath, id);

    if (provider === "claude") {
      ensureClaudeMd(projectPath, worktreePath);
    }

    const roleLabel =
      { vp: "Vice President", team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[
        agent.role
      ] || agent.role;
    const deptConstraint = agent.department_id
      ? getDeptRoleConstraint(agent.department_id, agent.department_name || agent.department_id)
      : "";
    const departmentPrompt = normalizeTextField(agent.department_prompt);
    const departmentPromptBlock = departmentPrompt ? `[Department Shared Prompt]\n${departmentPrompt}` : "";
    const conversationCtx = compactRollover ? "" : getRecentConversationContext(agentId);
    const continuationCtx = getTaskContinuationContext(id);
    const continuationInstruction = continuationCtx
      ? pickL(
          l([
            "Continuation run: keep the same ownership context, avoid re-reading unrelated files, and apply only unresolved deltas.",
          ]),
          taskLang,
        )
      : pickL(l(["Execute directly without repeated kickoff narration."]), taskLang);
    const projectStructureBlock = continuationCtx
      ? ""
      : projectContext
        ? `[Project Structure]\n${projectContext.length > 4000 ? projectContext.slice(0, 4000) + "\n... (truncated)" : projectContext}`
        : "";
    const needsPlanInstruction = provider === "gemini" || provider === "copilot" || provider === "antigravity";
    const subtaskInstruction = needsPlanInstruction
      ? `\n\n${pickL(
          l([
            `[Task Plan Output Rules]
Before starting work, print a plan in the JSON format below:
\`\`\`json
{"subtasks": [{"title": "Subtask title 1"}, {"title": "Subtask title 2"}]}
\`\`\`
Whenever you complete a subtask, report it in this format:
\`\`\`json
{"subtask_done": "Completed subtask title"}
\`\`\``,
          ]),
          taskLang,
        )}\n`
      : "";

    const modelConfig = getProviderModelConfig();
    const mainModel = agent.cli_model || modelConfig[provider]?.model || undefined;
    const subModel = modelConfig[provider]?.subModel || undefined;
    const mainReasoningLevel =
      provider === "codex"
        ? agent.cli_reasoning_level || modelConfig[provider]?.reasoningLevel || undefined
        : modelConfig[provider]?.reasoningLevel || undefined;
    const subReasoningLevel = modelConfig[provider]?.subModelReasoningLevel || undefined;
    const subModelHint =
      subModel && (provider === "claude" || provider === "codex")
        ? `\n[Sub-agent model preference] When spawning sub-agents (Task tool), prefer using model: ${subModel}${subReasoningLevel ? ` with reasoning effort: ${subReasoningLevel}` : ""}`
        : "";
    const runInstruction = pickL(
      l([
        "Please complete the task above thoroughly. Use the continuation brief, conversation context, and project structure above if relevant. Do NOT spend time exploring the project structure again unless required by unresolved checklist items.",
      ]),
      taskLang,
    );

    const promptOptions = { allowWarningFix: hasExplicitWarningFixRequest(task.title, task.description) };
    let initialLocalPrompt: string | null = null;
    const localRoute = getCurrentTaskModelRoute(db as any, id);
    if (!compactRollover && localRoute?.provider === "api" && localRoute.context_window_tokens) {
      initialLocalPrompt = tryBuildCompactInitialTaskPrompt(
        {
          projectPath: agentCwd,
          taskId: id,
          title: task.title,
          description: task.description,
          contextWindowTokens: localRoute.context_window_tokens,
          departmentConstraint: deptConstraint,
          departmentSharedPrompt: departmentPromptBlock,
          interruptPrompt: interruptPromptBlock,
          continuation: continuationCtx,
          taskToolsPath: taskToolsScriptPath(),
          worktreeBranch: `climpire/${id.slice(0, 8)}`,
          knowledge: (maxBytes) => buildCompactKnowledgeBlock(db as any, id, maxBytes),
        },
        (parts) => buildTaskExecutionPrompt(parts, promptOptions),
      );
      if (!initialLocalPrompt) {
        const fallback = await routeTaskModel(db as any, id, runAgentOneShot, true, true);
        provider = fallback?.provider || agent.cli_provider || "claude";
        executionSession = ensureTaskExecutionSession(id, agent.id, provider);
        if (provider === "claude") ensureClaudeMd(projectPath, worktreePath);
        appendTaskLog(
          id,
          "system",
          "Local prompt exceeds context budget; using the configured worker with all task requirements preserved",
        );
      }
    }
    const prompt =
      initialLocalPrompt ??
      (compactRollover
        ? buildCompactContextRolloverPrompt(
            {
              projectPath: provider === "api" ? agentCwd : undefined,
              taskId: id,
              title: task.title,
              checkpointText: rollover!.checkpointText,
              contextWindowTokens:
                getCurrentTaskModelRoute(db as any, id)?.context_window_tokens ?? agent.context_window_tokens,
              departmentConstraint: deptConstraint,
              departmentSharedPrompt: departmentPromptBlock,
              interruptPrompt: interruptPromptBlock,
              taskToolsPath: taskToolsScriptPath(),
              knowledge: (maxBytes) => buildCompactKnowledgeBlock(db as any, id, maxBytes),
              worktreeBranch: `climpire/${id.slice(0, 8)}`,
            },
            (parts) => buildTaskExecutionPrompt(parts, promptOptions),
          )
        : buildTaskExecutionPrompt(
            [
              (
                buildAvailableSkillsPromptBlock ||
                ((providerName: string) => `[Available Skills][provider=${providerName || "unknown"}][unavailable]`)
              )(provider),
              `[Task Session] id=${executionSession.sessionId} owner=${executionSession.agentId} provider=${executionSession.provider}`,
              "This session is task-scoped. Keep continuity for this task only and do not cross-contaminate context from other projects.",
              projectStructureBlock,
              recentChanges ? `[Recent Changes]\n${recentChanges}` : "",
              `[Task] ${task.title}`,
              task.description ? `\n${task.description}` : "",
              continuationCtx,
              conversationCtx,
              `\n---`,
              `Agent: ${agent.name} (${roleLabel}, ${agent.department_name || "Unassigned"})`,
              agent.personality ? `Personality: ${agent.personality}` : "",
              deptConstraint,
              departmentPromptBlock,
              `NOTE: You are working in an isolated Git worktree branch (climpire/${id.slice(0, 8)}). Run relevant tests, but do not commit until the user explicitly approves.`,
              `If your current model cannot finish this task, write .climpire-model-upgrade.json at the worktree root with {"reason":"at least ten characters","model":"optional configured model ID"}, then end this run. The director will decide; the worktree will be preserved for resume.`,
              interruptPromptBlock,
              subtaskInstruction,
              subModelHint,
              continuationInstruction,
              runInstruction,
            ],
            { ...promptOptions, taskId: id },
          ));

    if (pendingInterruptPrompts.length > 0) {
      consumeInterruptPrompts(
        db as any,
        pendingInterruptPrompts.map((row) => row.id),
        nowMs(),
      );
      appendTaskLog(
        id,
        "system",
        `INJECT consumed (${pendingInterruptPrompts.length}) for session ${executionSession.sessionId}`,
      );
    }

    appendTaskLog(id, "system", `RUN start (agent=${agent.name}, provider=${provider})`);

    if (provider === "api") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();

      const t = nowMs();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
      ).run(agentId, t, t, id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("task_update", updatedTask);
      broadcast("agent_status", updatedAgent);
      launchApiProviderAgent(
        id,
        agent.api_provider_id ?? null,
        agent.api_model ?? null,
        prompt,
        agentCwd,
        logPath,
        controller,
        fakePid,
      );
      const launchedTask = db.prepare("SELECT status, department_id FROM tasks WHERE id = ?").get(id) as
        | { status: string; department_id: string | null }
        | undefined;
      if (launchedTask?.status !== "in_progress")
        return res.status(409).json({
          error: "worker_start_blocked",
          message: "Worker did not start; see the task log for the policy or transport failure.",
        });
      notifyTaskStatus(id, task.title, "in_progress", taskLang);
      const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
      const worktreeNote = pickL(l([` (isolated branch: climpire/${id.slice(0, 8)})`]), taskLang);
      notifyCeo(pickL(l([`${assigneeName} started work on '${task.title}'.${worktreeNote}`]), taskLang), id);
      startProgressTimer(id, task.title, launchedTask.department_id);
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: !!worktreePath });
    }

    if (provider === "copilot" || provider === "antigravity") {
      const controller = new AbortController();
      const fakePid = getNextHttpAgentPid();

      const t = nowMs();
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
      ).run(agentId, t, t, id);
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
      broadcast("task_update", updatedTask);
      broadcast("agent_status", updatedAgent);
      notifyTaskStatus(id, task.title, "in_progress", taskLang);

      const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
      const worktreeNote = pickL(l([` (isolated branch: climpire/${id.slice(0, 8)})`]), taskLang);
      notifyCeo(pickL(l([`${assigneeName} started work on '${task.title}'.${worktreeNote}`]), taskLang), id);

      const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
        | { department_id: string | null }
        | undefined;
      startProgressTimer(id, task.title, taskRow?.department_id ?? null);

      launchHttpAgent(id, provider, prompt, agentCwd, logPath, controller, fakePid, agent.oauth_account_id ?? null);
      return res.json({ ok: true, pid: fakePid, logPath, cwd: agentCwd, worktree: !!worktreePath });
    }

    const child = spawnCliAgent(id, provider, prompt, agentCwd, logPath, mainModel, mainReasoningLevel);

    child.on("close", (code: number | null) => {
      handleTaskRunComplete(id, code ?? 1);
    });

    const t = nowMs();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, started_at = ?, updated_at = ? WHERE id = ?",
    ).run(agentId, t, t, id);
    db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?").run(id, agentId);

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const updatedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    broadcast("task_update", updatedTask);
    broadcast("agent_status", updatedAgent);
    notifyTaskStatus(id, task.title, "in_progress", taskLang);

    const assigneeName = getAgentDisplayName(agent as unknown as AgentRow, taskLang);
    const worktreeNote = pickL(l([` (isolated branch: climpire/${id.slice(0, 8)})`]), taskLang);
    notifyCeo(pickL(l([`${assigneeName} started work on '${task.title}'.${worktreeNote}`]), taskLang), id);

    const taskRow = db.prepare("SELECT department_id FROM tasks WHERE id = ?").get(id) as
      | { department_id: string | null }
      | undefined;
    startProgressTimer(id, task.title, taskRow?.department_id ?? null);

    res.json({ ok: true, pid: child.pid ?? null, logPath, cwd: agentCwd, worktree: !!worktreePath });
  });
}
