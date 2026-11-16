import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

type ProjectAssignmentModeRow = {
  assignment_mode?: string | null;
};

type ProjectAgentRow = {
  agent_id: string;
};

export type AutoAssignableAgent = {
  id: string;
  name: string;
  department_id: string | null;
  role: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  status: string;
  current_task_id: string | null;
  stats_tasks_done: number;
  created_at: number;
};

type CandidateTaskShape = {
  department_id?: string | null;
  project_id?: string | null;
};

export type AutoAssignSelectionResult = {
  agent: AutoAssignableAgent;
};

/** Departments tried first when a task names none, in order. */
const PREFERRED_DEPARTMENTS = ["dev", "qa", "devsecops", "operations", "planning", "design"];

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function buildPreferredDepartmentOrder(taskDepartmentId: string | null | undefined): string[] {
  const out: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    if (out.includes(value)) return;
    out.push(value);
  };

  add(taskDepartmentId);
  for (const deptId of PREFERRED_DEPARTMENTS) add(deptId);
  return out;
}

function loadManualProjectAgentScope(db: DbLike, projectId: string | null | undefined): string[] | null {
  if (!projectId) return null;
  const project = db.prepare("SELECT assignment_mode FROM projects WHERE id = ?").get(projectId) as
    | ProjectAssignmentModeRow
    | undefined;
  if (project?.assignment_mode !== "manual") return null;
  const rows = db
    .prepare("SELECT agent_id FROM project_agents WHERE project_id = ?")
    .all(projectId) as ProjectAgentRow[];
  return rows.map((row) => row.agent_id).filter((id) => typeof id === "string" && id.length > 0);
}

function loadActiveOAuthAccountIdsByProvider(db: DbLike): Map<string, Set<string>> | null {
  try {
    const rows = db.prepare("SELECT id, provider FROM oauth_accounts WHERE status = 'active'").all() as Array<{
      id?: unknown;
      provider?: unknown;
    }>;
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = normalizeText(row?.id);
      const provider = normalizeText(row?.provider).toLowerCase();
      if (!id || !provider) continue;
      const current = out.get(provider) ?? new Set<string>();
      current.add(id);
      out.set(provider, current);
    }
    return out;
  } catch {
    // Some tests or legacy databases may not have oauth_accounts yet.
    return null;
  }
}

function isOAuthBackedProviderReady(
  agent: AutoAssignableAgent,
  activeOAuthByProvider: Map<string, Set<string>> | null,
): boolean {
  const provider = normalizeText(agent.cli_provider).toLowerCase();
  const requiredOAuthProvider =
    provider === "copilot" ? "github" : provider === "antigravity" ? "google_antigravity" : null;
  if (!requiredOAuthProvider) return true;
  if (!activeOAuthByProvider) return true;

  const activeAccounts = activeOAuthByProvider.get(requiredOAuthProvider);
  if (!activeAccounts || activeAccounts.size <= 0) return false;

  const preferredAccountId = normalizeText(agent.oauth_account_id);
  if (preferredAccountId && !activeAccounts.has(preferredAccountId)) return false;
  return true;
}

function selectCandidate(
  db: DbLike,
  preferredDeptIds: string[],
  constrainedAgentIds: string[] | null,
): AutoAssignableAgent | null {
  if (Array.isArray(constrainedAgentIds) && constrainedAgentIds.length === 0) {
    return null;
  }

  const conditions: string[] = [
    "cli_provider IS NOT NULL",
    "status IN ('idle', 'break')",
    "(current_task_id IS NULL OR current_task_id = '')",
  ];
  const params: SQLInputValue[] = [];

  if (preferredDeptIds.length > 0) {
    conditions.push(`department_id IN (${preferredDeptIds.map(() => "?").join(", ")})`);
    params.push(...preferredDeptIds);
  }

  if (Array.isArray(constrainedAgentIds)) {
    conditions.push(`id IN (${constrainedAgentIds.map(() => "?").join(", ")})`);
    params.push(...constrainedAgentIds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
      SELECT id, name, department_id, role, cli_provider, oauth_account_id, status, current_task_id, stats_tasks_done, created_at
      FROM agents
      ${where}
      ORDER BY created_at ASC
    `,
    )
    .all(...params) as AutoAssignableAgent[];
  if (rows.length === 0) return null;

  const activeOAuthByProvider = loadActiveOAuthAccountIdsByProvider(db);
  const runnableRows = rows.filter((row) => isOAuthBackedProviderReady(row, activeOAuthByProvider));
  if (runnableRows.length === 0) return null;

  const deptRank = (deptId: string | null): number => {
    if (!deptId) return preferredDeptIds.length + 1;
    const index = preferredDeptIds.indexOf(deptId);
    return index >= 0 ? index : preferredDeptIds.length;
  };
  const statusRank = (status: string): number => (status === "idle" ? 0 : status === "break" ? 1 : 2);
  const leaderRank = (role: string): number => (role === "team_leader" ? 1 : 0);

  runnableRows.sort((a, b) => {
    const byDept = deptRank(a.department_id) - deptRank(b.department_id);
    if (byDept !== 0) return byDept;

    const byStatus = statusRank(a.status) - statusRank(b.status);
    if (byStatus !== 0) return byStatus;

    const byLeader = leaderRank(a.role) - leaderRank(b.role);
    if (byLeader !== 0) return byLeader;

    const byTasksDone = (a.stats_tasks_done ?? 0) - (b.stats_tasks_done ?? 0);
    if (byTasksDone !== 0) return byTasksDone;

    return (a.created_at ?? 0) - (b.created_at ?? 0);
  });

  return runnableRows[0] ?? null;
}

export function resolveConstrainedAgentScopeForTask(db: DbLike, task: CandidateTaskShape): string[] | null {
  return loadManualProjectAgentScope(db, task.project_id);
}

export function selectAutoAssignableAgentForTask(
  db: DbLike,
  task: CandidateTaskShape,
): AutoAssignSelectionResult | null {
  const preferredDeptIds = buildPreferredDepartmentOrder(task.department_id);
  const constrainedAgentIds = resolveConstrainedAgentScopeForTask(db, task);
  const agent =
    selectCandidate(db, preferredDeptIds, constrainedAgentIds) ?? selectCandidate(db, [], constrainedAgentIds);
  return agent ? { agent } : null;
}
