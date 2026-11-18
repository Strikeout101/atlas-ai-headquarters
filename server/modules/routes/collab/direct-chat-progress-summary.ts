import { isMessengerChannel } from "../../../messenger/channels.ts";
import type { Lang } from "../../../types/lang.ts";
import type { DelegationOptions } from "./project-resolution.ts";
import { resolveProjectBindingFromText } from "./direct-chat-project-binding.ts";
import type { AgentRow, DirectChatDeps, ProjectProgressTarget, ProjectProgressTaskRow } from "./direct-chat-types.ts";

type BuildProjectProgressDeps = Pick<
  DirectChatDeps,
  "db" | "l" | "pickL" | "resolveLang" | "resolveProjectFromOptions" | "detectProjectPath" | "normalizeTextField"
>;

type SendProjectProgressDeps = BuildProjectProgressDeps &
  Pick<DirectChatDeps, "sendAgentMessage"> & {
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
    composeInCharacterAutoMessage: (agent: AgentRow, lang: Lang, scenario: string, fallback: string) => Promise<string>;
    relayReplyToMessenger: (options: DelegationOptions, agent: AgentRow, rawContent: string) => Promise<void>;
  };

function resolveProjectProgressTargetFromBinding(
  deps: Pick<BuildProjectProgressDeps, "normalizeTextField" | "resolveProjectFromOptions">,
  projectIdLike: string | null | undefined,
  projectPathLike: string | null | undefined,
): ProjectProgressTarget | null {
  const resolved = deps.resolveProjectFromOptions({
    projectId: deps.normalizeTextField(projectIdLike),
    projectPath: deps.normalizeTextField(projectPathLike),
  });
  if (!resolved.id && !resolved.projectPath) return null;
  return {
    projectId: resolved.id ?? null,
    projectName: resolved.name ?? null,
    projectPath: resolved.projectPath ?? null,
    projectContext: resolved.coreGoal ?? null,
  };
}

function resolveProjectProgressTargetBySessionRoute(
  deps: Pick<BuildProjectProgressDeps, "db" | "normalizeTextField" | "resolveProjectFromOptions">,
  options: DelegationOptions,
): ProjectProgressTarget | null {
  if (!isMessengerChannel(options.messengerChannel)) return null;
  const targetId = deps.normalizeTextField(options.messengerTargetId);
  if (!targetId) return null;

  const routeLine = `[messenger-route] ${options.messengerChannel}:${targetId}`;
  const activeRow = deps.db
    .prepare(
      `
        SELECT t.project_id, t.project_path
        FROM task_logs tl
        JOIN tasks t ON t.id = tl.task_id
        WHERE tl.kind = 'system'
          AND tl.message = ?
          AND COALESCE(t.hidden, 0) = 0
          AND (
            (t.project_id IS NOT NULL AND TRIM(t.project_id) <> '')
            OR (t.project_path IS NOT NULL AND TRIM(t.project_path) <> '')
          )
          AND t.status NOT IN ('done', 'cancelled')
        ORDER BY tl.created_at DESC, t.updated_at DESC
        LIMIT 1
      `,
    )
    .get(routeLine) as { project_id: string | null; project_path: string | null } | undefined;
  const activeTarget = resolveProjectProgressTargetFromBinding(deps, activeRow?.project_id, activeRow?.project_path);
  if (activeTarget) return activeTarget;

  const latestRow = deps.db
    .prepare(
      `
        SELECT t.project_id, t.project_path
        FROM task_logs tl
        JOIN tasks t ON t.id = tl.task_id
        WHERE tl.kind = 'system'
          AND tl.message = ?
          AND COALESCE(t.hidden, 0) = 0
          AND (
            (t.project_id IS NOT NULL AND TRIM(t.project_id) <> '')
            OR (t.project_path IS NOT NULL AND TRIM(t.project_path) <> '')
          )
        ORDER BY tl.created_at DESC, t.updated_at DESC
        LIMIT 1
      `,
    )
    .get(routeLine) as { project_id: string | null; project_path: string | null } | undefined;
  return resolveProjectProgressTargetFromBinding(deps, latestRow?.project_id, latestRow?.project_path);
}

function resolveProjectProgressTargetByAgentRecent(
  deps: Pick<BuildProjectProgressDeps, "db" | "resolveProjectFromOptions" | "normalizeTextField">,
  agent: AgentRow,
): ProjectProgressTarget | null {
  const activeRow = deps.db
    .prepare(
      `
        SELECT project_id, project_path
        FROM tasks
        WHERE (assigned_agent_id = ? OR department_id = ?)
          AND (
            (project_id IS NOT NULL AND TRIM(project_id) <> '')
            OR (project_path IS NOT NULL AND TRIM(project_path) <> '')
          )
          AND status NOT IN ('done', 'cancelled')
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(agent.id, agent.department_id) as { project_id: string | null; project_path: string | null } | undefined;
  const activeTarget = resolveProjectProgressTargetFromBinding(deps, activeRow?.project_id, activeRow?.project_path);
  if (activeTarget) return activeTarget;

  const latestRow = deps.db
    .prepare(
      `
        SELECT project_id, project_path
        FROM tasks
        WHERE (assigned_agent_id = ? OR department_id = ?)
          AND (
            (project_id IS NOT NULL AND TRIM(project_id) <> '')
            OR (project_path IS NOT NULL AND TRIM(project_path) <> '')
          )
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(agent.id, agent.department_id) as { project_id: string | null; project_path: string | null } | undefined;
  return resolveProjectProgressTargetFromBinding(deps, latestRow?.project_id, latestRow?.project_path);
}

function resolveProjectProgressTarget(
  deps: BuildProjectProgressDeps,
  agent: AgentRow,
  ceoMessage: string,
  options: DelegationOptions,
): ProjectProgressTarget | null {
  const fromText = resolveProjectBindingFromText(
    {
      db: deps.db,
      detectProjectPath: deps.detectProjectPath,
      normalizeTextField: deps.normalizeTextField,
    },
    ceoMessage,
  );
  if (fromText) {
    const resolved = deps.resolveProjectFromOptions({
      ...options,
      projectId: fromText.projectId ?? options.projectId,
      projectPath: fromText.projectPath ?? options.projectPath,
      projectContext: fromText.projectContext ?? options.projectContext,
    });
    if (resolved.id || resolved.projectPath) {
      return {
        projectId: resolved.id ?? null,
        projectName: resolved.name ?? null,
        projectPath: resolved.projectPath ?? null,
        projectContext: resolved.coreGoal ?? null,
      };
    }
  }

  const fromOptions = deps.resolveProjectFromOptions(options);
  if (fromOptions.id || fromOptions.projectPath) {
    return {
      projectId: fromOptions.id ?? null,
      projectName: fromOptions.name ?? null,
      projectPath: fromOptions.projectPath ?? null,
      projectContext: fromOptions.coreGoal ?? null,
    };
  }

  if (agent.current_task_id) {
    const currentTaskBinding = deps.db
      .prepare("SELECT project_id, project_path FROM tasks WHERE id = ? LIMIT 1")
      .get(agent.current_task_id) as { project_id: string | null; project_path: string | null } | undefined;
    const currentTaskTarget = resolveProjectProgressTargetFromBinding(
      deps,
      currentTaskBinding?.project_id,
      currentTaskBinding?.project_path,
    );
    if (currentTaskTarget) return currentTaskTarget;
  }

  const sessionRouteTarget = resolveProjectProgressTargetBySessionRoute(deps, options);
  if (sessionRouteTarget) return sessionRouteTarget;

  const agentRecentTarget = resolveProjectProgressTargetByAgentRecent(deps, agent);
  if (agentRecentTarget) return agentRecentTarget;

  return null;
}

function resolveProgressStatusLabel(status: string, lang: Lang): string {
  const labels: Record<string, Record<Lang, string>> = {
    inbox: { en: "Inbox" },
    planned: { en: "Planned" },
    collaborating: { en: "Collaborating" },
    in_progress: { en: "In Progress" },
    review: { en: "Review" },
    pending: { en: "Pending" },
    done: { en: "Done" },
    cancelled: { en: "Cancelled" },
  };
  return labels[status]?.[lang] ?? status;
}

function loadProjectProgressTasks(
  deps: Pick<BuildProjectProgressDeps, "db" | "normalizeTextField">,
  target: ProjectProgressTarget,
): ProjectProgressTaskRow[] {
  if (target.projectId) {
    return deps.db
      .prepare(
        `
          SELECT
            t.id,
            t.title,
            t.status,
            t.updated_at,
            t.assigned_agent_id,
            a.name AS assignee_name,
            a.name_ko AS assignee_name_ko
          FROM tasks t
          LEFT JOIN agents a ON a.id = t.assigned_agent_id
          WHERE t.project_id = ?
            AND COALESCE(t.hidden, 0) = 0
          ORDER BY t.updated_at DESC
          LIMIT 250
        `,
      )
      .all(target.projectId) as ProjectProgressTaskRow[];
  }

  const projectPath = deps.normalizeTextField(target.projectPath);
  if (!projectPath) return [];
  if (process.platform === "win32" || process.platform === "darwin") {
    return deps.db
      .prepare(
        `
          SELECT
            t.id,
            t.title,
            t.status,
            t.updated_at,
            t.assigned_agent_id,
            a.name AS assignee_name,
            a.name_ko AS assignee_name_ko
          FROM tasks t
          LEFT JOIN agents a ON a.id = t.assigned_agent_id
          WHERE LOWER(t.project_path) = LOWER(?)
            AND COALESCE(t.hidden, 0) = 0
          ORDER BY t.updated_at DESC
          LIMIT 250
        `,
      )
      .all(projectPath) as ProjectProgressTaskRow[];
  }
  return deps.db
    .prepare(
      `
        SELECT
          t.id,
          t.title,
          t.status,
          t.updated_at,
          t.assigned_agent_id,
          a.name AS assignee_name,
          a.name_ko AS assignee_name_ko
        FROM tasks t
        LEFT JOIN agents a ON a.id = t.assigned_agent_id
        WHERE t.project_path = ?
          AND COALESCE(t.hidden, 0) = 0
        ORDER BY t.updated_at DESC
        LIMIT 250
      `,
    )
    .all(projectPath) as ProjectProgressTaskRow[];
}

export function buildProjectProgressSummary(
  deps: BuildProjectProgressDeps,
  agent: AgentRow,
  ceoMessage: string,
  options: DelegationOptions,
): {
  lang: Lang;
  content: string;
  projectFound: boolean;
} {
  const lang = deps.resolveLang(ceoMessage);
  const target = resolveProjectProgressTarget(deps, agent, ceoMessage, options);
  if (!target) {
    return {
      lang,
      projectFound: false,
      content: deps.pickL(
        deps.l([
          "I couldn't identify which project to inspect yet. Share the project name or path and I'll check immediately.",
        ]),
        lang,
      ),
    };
  }

  const rows = loadProjectProgressTasks(deps, target);
  const projectName =
    target.projectName || target.projectPath || target.projectId || deps.pickL(deps.l(["(unknown)"]), lang);
  if (rows.length === 0) {
    return {
      lang,
      projectFound: true,
      content: deps.pickL(deps.l([`There are no tasks registered yet for project '${projectName}'.`]), lang),
    };
  }

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }

  const total = rows.length;
  const done = counts.get("done") ?? 0;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;
  const statusOrder = ["inbox", "planned", "collaborating", "in_progress", "review", "pending", "done", "cancelled"];
  const statusSummary = statusOrder
    .map((status) => ({ status, count: counts.get(status) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const label = resolveProgressStatusLabel(entry.status, lang);

      return `${label} ${entry.count}`;
    })
    .join(", ");

  const recentRows = rows.slice(0, 5);
  const recentLines = recentRows.map((row, index) => {
    const statusLabel = resolveProgressStatusLabel(row.status, lang);
    const assignee = deps.normalizeTextField(row.assignee_name);

    return `${index + 1}. [${statusLabel}] ${row.title}${assignee ? ` · owner: ${assignee}` : ""}`;
  });

  const header = deps.pickL(
    deps.l([
      `Here is the current project progress.\n- Project: ${projectName}\n- Total: ${total} / Completion: ${completionRate}%\n- Status: ${statusSummary}\n\nRecent updates:\n${recentLines.join("\n")}`,
    ]),
    lang,
  );

  return {
    lang,
    projectFound: true,
    content: header,
  };
}

export function sendProjectProgressReply(
  deps: SendProjectProgressDeps,
  agent: AgentRow,
  ceoMessage: string,
  options: DelegationOptions,
): void {
  const summary = buildProjectProgressSummary(deps, agent, ceoMessage, options);
  if (!summary.projectFound) {
    deps.sendInCharacterAutoMessage({
      agent,
      lang: summary.lang,
      scenario: "The user asked for project progress but no project is identified. Ask for project name or path.",
      fallback: summary.content,
      options,
    });
    return;
  }

  const leadFallback = deps.pickL(deps.l(["Got it. Here's the current project progress summary."]), summary.lang);

  void (async () => {
    const lead = await deps.composeInCharacterAutoMessage(
      agent,
      summary.lang,
      "You are reporting current project task progress to the user. Keep one concise in-character sentence.",
      leadFallback,
    );
    const content = `${lead}\n\n${summary.content}`;
    deps.sendAgentMessage(agent, content);
    await deps.relayReplyToMessenger(options, agent, content);
  })().catch((err) => {
    console.warn(`[project-progress] failed to send progress reply from ${agent.name}: ${String(err)}`);
  });
}
