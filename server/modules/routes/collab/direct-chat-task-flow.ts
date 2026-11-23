import { randomUUID } from "node:crypto";
import type { Lang } from "../../../types/lang.ts";
import type { DelegationOptions } from "./project-resolution.ts";
import type { AgentRow, DirectChatDeps } from "./direct-chat-types.ts";

type TaskFlowDeps = Pick<
  DirectChatDeps,
  | "db"
  | "nowMs"
  | "randomDelay"
  | "broadcast"
  | "appendTaskLog"
  | "recordTaskCreationAudit"
  | "resolveLang"
  | "detectProjectPath"
  | "normalizeTextField"
  | "resolveProjectFromOptions"
  | "buildRoundGoal"
  | "getDeptName"
  | "l"
  | "pickL"
  | "registerTaskMessengerRoute"
  | "isTaskWorkflowInterrupted"
  | "startTaskExecutionForAgent"
  | "handleTaskDelegation"
> & {
  sendInCharacterAutoMessage: (params: {
    agent: AgentRow;
    lang: Lang;
    scenario: string;
    fallback: string;
    options: DelegationOptions;
    messageType?: string;
    taskId?: string | null;
    strictFallback?: boolean;
  }) => void;
};

export function createDirectTaskFlow(deps: TaskFlowDeps) {
  function createDirectAgentTaskAndRun(agent: AgentRow, ceoMessage: string, options: DelegationOptions = {}): void {
    const lang = deps.resolveLang(ceoMessage);
    const taskId = randomUUID();
    const t = deps.nowMs();
    const taskTitle = ceoMessage.length > 60 ? `${ceoMessage.slice(0, 57)}...` : ceoMessage;
    const selectedProject = deps.resolveProjectFromOptions(options);
    const projectCoreGoal = selectedProject.coreGoal || "";
    const projectContextHint = deps.normalizeTextField(options.projectContext) || projectCoreGoal;
    const detectedPath =
      deps.detectProjectPath(options.projectPath || selectedProject.projectPath || ceoMessage) ||
      selectedProject.projectPath;
    const roundGoal = deps.buildRoundGoal(projectCoreGoal, ceoMessage);
    const deptId = agent.department_id ?? null;
    const deptName = deptId ? deps.getDeptName(deptId) : "Unassigned";
    const descriptionLines = [`[CEO DIRECT] ${ceoMessage}`];
    if (selectedProject.name) descriptionLines.push(`[PROJECT] ${selectedProject.name}`);
    if (projectCoreGoal) descriptionLines.push(`[PROJECT CORE GOAL] ${projectCoreGoal}`);
    descriptionLines.push(`[ROUND GOAL] ${roundGoal}`);
    if (projectContextHint && projectContextHint !== projectCoreGoal) {
      descriptionLines.push(`[PROJECT CONTEXT] ${projectContextHint}`);
    }

    deps.db
      .prepare(
        `
    INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type, project_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', 1, 'general', ?, ?, ?)
  `,
      )
      .run(taskId, taskTitle, descriptionLines.join("\n"), deptId, agent.id, selectedProject.id, detectedPath, t, t);
    deps.registerTaskMessengerRoute(taskId, options);
    deps.recordTaskCreationAudit({
      taskId,
      taskTitle,
      taskStatus: "planned",
      departmentId: deptId,
      assignedAgentId: agent.id,
      taskType: "general",
      projectPath: detectedPath ?? null,
      trigger: "workflow.direct_agent_task",
      triggerDetail: "direct chat escalated to task",
      actorType: "agent",
      actorId: agent.id,
      actorName: agent.name,
      body: {
        ceo_message: ceoMessage,
        message_type: "task_assign",
        project_id: selectedProject.id,
        project_context: projectContextHint,
        round_goal: roundGoal,
      },
    });
    if (selectedProject.id) {
      deps.db
        .prepare("UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?")
        .run(t, t, selectedProject.id);
    }

    deps.db.prepare("UPDATE agents SET current_task_id = ? WHERE id = ?").run(taskId, agent.id);
    deps.appendTaskLog(taskId, "system", `Direct CEO assignment to ${agent.name}: ${ceoMessage}`);
    deps.appendTaskLog(taskId, "system", `Round goal: ${roundGoal}`);
    if (selectedProject.id) {
      deps.appendTaskLog(taskId, "system", `Project linked: ${selectedProject.name || selectedProject.id}`);
    }
    if (detectedPath) {
      deps.appendTaskLog(taskId, "system", `Project path detected from direct chat: ${detectedPath}`);
    }

    const ack = deps.pickL(deps.l(["Understood. I will register this as a task and start right away."]), lang);
    deps.sendInCharacterAutoMessage({
      agent,
      lang,
      scenario: "You just accepted CEO's request and registered it as a task. Confirm immediate execution.",
      fallback: ack,
      options,
      messageType: "task_assign",
      taskId,
    });

    deps.broadcast("task_update", deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    deps.broadcast("agent_status", deps.db.prepare("SELECT * FROM agents WHERE id = ?").get(agent.id));

    setTimeout(
      () => {
        if (deps.isTaskWorkflowInterrupted(taskId)) return;
        deps.startTaskExecutionForAgent(taskId, agent, deptId, deptName);
      },
      deps.randomDelay(900, 1600),
    );
  }

  function runTaskFlowWithResolvedProject(
    agent: AgentRow,
    taskMessage: string,
    taskOptions: DelegationOptions,
    lang: Lang,
  ): void {
    if (agent.role === "team_leader" && agent.department_id) {
      const taskAck = deps.pickL(deps.l(["Got the project. I'll start the task now."]), lang);
      deps.sendInCharacterAutoMessage({
        agent,
        lang,
        scenario: "The project is confirmed. Tell the owner you'll start the task now in a casual sentence.",
        fallback: taskAck,
        options: taskOptions,
      });
      deps.handleTaskDelegation(agent, taskMessage, "", taskOptions);
      return;
    }
    createDirectAgentTaskAndRun(agent, taskMessage, taskOptions);
  }

  return {
    createDirectAgentTaskAndRun,
    runTaskFlowWithResolvedProject,
  };
}
