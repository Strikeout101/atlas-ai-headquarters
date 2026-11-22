import path from "node:path";
import { areRunsAllowed, RUNS_HALTED_ERROR } from "../../../control-state.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import { resolveConstrainedAgentScopeForTask, selectAutoAssignableAgentForTask } from "./execution-run-auto-assign.ts";

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
  | "startTaskExecutionForAgent"
>;

export function registerTaskRunRoute(deps: TaskRunRouteDeps): void {
  const { app, db, activeProcesses, appendTaskLog, nowMs, startTaskExecutionForAgent } = deps;

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

    // One start path for every task (work restructure, phase 2): the same model check, work type, work folder
    // or worktree, prompt and launch as automatic starts. An owner-given folder fills a task that has none.
    const bodyProjectPath = typeof req.body?.project_path === "string" ? req.body.project_path.trim() : "";
    if (!task.project_id && !task.project_path && bodyProjectPath && path.isAbsolute(bodyProjectPath)) {
      db.prepare("UPDATE tasks SET project_path = ?, updated_at = ? WHERE id = ?").run(bodyProjectPath, nowMs(), id);
    }
    const result = await startTaskExecutionForAgent(
      id,
      agent,
      agent.department_id ?? task.department_id,
      agent.department_name ?? "",
    );
    if (!result?.ok) {
      const error = result?.error ?? "not_started";
      return res.status(error === "not_found" ? 404 : 409).json({ error });
    }
    return res.json({ ok: true, pid: result.pid, logPath: result.logPath, cwd: result.cwd, worktree: result.worktree });
  });
}
