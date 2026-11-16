import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare">;

export type DepartmentRow = {
  id: string;
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  icon: string;
  color: string;
  description: string | null;
  prompt: string | null;
  sort_order: number;
  created_at: number;
};

export function getDepartment(db: DbLike, departmentId: unknown): DepartmentRow | null {
  const id = typeof departmentId === "string" ? departmentId.trim() : "";
  if (!id) return null;
  try {
    return (db.prepare("SELECT * FROM departments WHERE id = ?").get(id) as DepartmentRow | undefined) ?? null;
  } catch {
    return null;
  }
}

export function getDepartmentPrompt(db: DbLike, departmentId: unknown): string | null {
  return getDepartment(db, departmentId)?.prompt ?? null;
}
