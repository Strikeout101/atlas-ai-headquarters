import type { DatabaseSync } from "node:sqlite";
import { resolveConstrainedAgentScopeForTask } from "../../core/tasks/execution-run-auto-assign.ts";

type DbLike = Pick<DatabaseSync, "prepare">;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveDirectiveLeaderCandidateScope(
  db: DbLike,
  projectId: string | null,
  departmentId: string | null = "planning",
): string[] | null {
  const normalizedDeptId = normalizeText(departmentId) || "planning";
  const scopedCandidateIds = resolveConstrainedAgentScopeForTask(db, {
    project_id: normalizeText(projectId) || null,
    department_id: normalizedDeptId,
  });
  if (!Array.isArray(scopedCandidateIds) || scopedCandidateIds.length <= 0) return scopedCandidateIds;

  try {
    const placeholders = scopedCandidateIds.map(() => "?").join(", ");
    const deptRows = db
      .prepare(
        `
        SELECT id
        FROM agents
        WHERE id IN (${placeholders})
          AND department_id = ?
      `,
      )
      .all(...scopedCandidateIds, normalizedDeptId) as Array<{ id?: unknown }>;
    const deptScopedIds = deptRows.map((row) => normalizeText(row.id)).filter((id): id is string => id.length > 0);
    // If no candidate exists for the requested department, keep the broader scope as fallback.
    return deptScopedIds.length > 0 ? deptScopedIds : scopedCandidateIds;
  } catch {
    return scopedCandidateIds;
  }
}
