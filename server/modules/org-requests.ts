import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { DEFAULT_DEPARTMENT_IDS } from "./approval-policy.ts";
export const MAX_AGENTS = 40;
export const MAX_DEPARTMENT_AGENTS = 8;
export const ORG_REQUEST_KINDS = [
  "hire_agent",
  "create_department",
  "convert_department",
  "dissolve_department",
] as const;
export type OrgRequestKind = (typeof ORG_REQUEST_KINDS)[number];
export interface OrgRequest {
  id: string;
  kind: OrgRequestKind;
  requested_by: string;
  payload: string;
  status: "pending" | "approved" | "denied";
  reason: string;
  created_at: number;
  decided_by: string | null;
}
export function ensureOrgRequestSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS org_requests (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('hire_agent','create_department','convert_department','dissolve_department')),
    requested_by TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    reason TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
  )`);
}
function text(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validatePayload(kind: OrgRequestKind, payload: Record<string, unknown>): void {
  if (!text(payload.reason)) throw new Error("org_workload_reason_required");
  if (kind === "hire_agent") {
    if (!text(payload.name, 100) || !text(payload.department_id, 128))
      throw new Error("org_name_and_department_required");
    if (payload.role !== undefined && !["senior", "junior", "intern"].includes(String(payload.role)))
      throw new Error("org_invalid_worker_role");
    if (
      payload.cli_provider !== undefined &&
      !["api", "codex", "claude", "gemini", "opencode", "kimi"].includes(String(payload.cli_provider))
    )
      throw new Error("org_invalid_provider");
  } else {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text(payload.department_id))) throw new Error("org_invalid_department_id");
    if (kind !== "dissolve_department" && !text(payload.name, 100)) throw new Error("org_name_required");
    if (kind === "dissolve_department" && !["reassign", "remove"].includes(String(payload.agents_action)))
      throw new Error("org_agent_disposition_required");
  }
}
export function createOrgRequest(
  db: DatabaseSync,
  kind: OrgRequestKind,
  requestedBy: string,
  payload: Record<string, unknown>,
): OrgRequest {
  ensureOrgRequestSchema(db);
  if (!ORG_REQUEST_KINDS.includes(kind)) throw new Error("org_invalid_kind");
  const requester = db.prepare("SELECT role,department_id FROM agents WHERE id=?").get(requestedBy) as
    | { role: string; department_id: string | null }
    | undefined;
  if (!requester || (kind === "hire_agent" ? !["team_leader", "vp"].includes(requester.role) : requester.role !== "vp"))
    throw new Error("org_request_role_forbidden");
  validatePayload(kind, payload);
  if (requester.role === "team_leader" && payload.department_id !== requester.department_id)
    throw new Error("org_hire_own_department_only");
  if (JSON.stringify(payload).length > 16000) throw new Error("org_payload_too_large");
  const id = randomUUID();
  db.prepare("INSERT INTO org_requests (id,kind,requested_by,payload,reason,created_at) VALUES (?,?,?,?,?,?)").run(
    id,
    kind,
    requestedBy,
    JSON.stringify(payload),
    text(payload.reason),
    Date.now(),
  );
  return db.prepare("SELECT * FROM org_requests WHERE id=?").get(id) as unknown as OrgRequest;
}
function deleteWorker(db: DatabaseSync, id: string): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    const safeTable = `"${name.replaceAll('"', '""')}"`;
    const refs = db.prepare(`PRAGMA foreign_key_list(${safeTable})`).all() as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    const columns = db.prepare(`PRAGMA table_info(${safeTable})`).all() as { name: string; notnull: number }[];
    for (const ref of refs.filter((ref) => ref.table === "agents")) {
      const column = `"${ref.from.replaceAll('"', '""')}"`;
      if (columns.find((col) => col.name === ref.from)?.notnull || ref.on_delete === "CASCADE")
        db.prepare(`DELETE FROM ${safeTable} WHERE ${column}=?`).run(id);
      else db.prepare(`UPDATE ${safeTable} SET ${column}=NULL WHERE ${column}=?`).run(id);
    }
  }
  db.prepare("DELETE FROM agents WHERE id=? AND role!='vp'").run(id);
}
/** Atomic decision and mutation; a failure leaves the request pending for owner review. */
export function decideOrgRequest(db: DatabaseSync, id: string, approve: boolean, decidedBy = "owner"): OrgRequest {
  ensureOrgRequestSchema(db);
  db.exec("SAVEPOINT org_decision");
  try {
    const request = db.prepare("SELECT * FROM org_requests WHERE id=?").get(id) as unknown as OrgRequest | undefined;
    if (!request) throw new Error("org_request_not_found");
    if (request.status !== "pending") throw new Error("org_request_already_decided");
    const payload = JSON.parse(request.payload) as Record<string, unknown>;
    validatePayload(request.kind, payload);
    const departmentId = text(payload.department_id);
    if (approve) {
      if (
        request.kind === "dissolve_department" &&
        DEFAULT_DEPARTMENT_IDS.includes(departmentId as (typeof DEFAULT_DEPARTMENT_IDS)[number]) &&
        decidedBy !== "owner"
      )
        throw new Error("org_default_department_requires_owner");
      const department = db.prepare("SELECT id FROM departments WHERE id=?").get(departmentId);
      if (request.kind !== "create_department" && !department) throw new Error("org_department_not_found");
      if (request.kind === "hire_agent") {
        const total = Number((db.prepare("SELECT COUNT(*) AS count FROM agents").get() as { count: number }).count);
        const count = Number(
          (
            db.prepare("SELECT COUNT(*) AS count FROM agents WHERE department_id=?").get(departmentId) as {
              count: number;
            }
          ).count,
        );
        if (total >= MAX_AGENTS || count >= MAX_DEPARTMENT_AGENTS) throw new Error("org_agent_cap_reached");
        db.prepare(
          "INSERT INTO agents (id,name,department_id,role,cli_provider,avatar_emoji,personality,api_provider_id,api_model) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          text(payload.name, 100),
          departmentId,
          text(payload.role) || "junior",
          text(payload.cli_provider) || "api",
          "",
          text(payload.personality) || null,
          text(payload.api_provider_id) || null,
          text(payload.api_model) || null,
        );
      } else if (request.kind === "create_department") {
        if (department) throw new Error("org_department_exists");
        const maxOrder = Number(
          (db.prepare("SELECT COALESCE(MAX(sort_order),0) AS n FROM departments").get() as { n: number }).n,
        );
        db.prepare(
          "INSERT INTO departments (id,name,name_ko,icon,color,description,prompt,sort_order) VALUES (?,?,?,'','#6b7280',?,?,?)",
        ).run(
          departmentId,
          text(payload.name, 100),
          text(payload.name_ko, 100),
          text(payload.description) || null,
          text(payload.prompt) || null,
          maxOrder + 1,
        );
      } else if (request.kind === "convert_department") {
        db.prepare("UPDATE departments SET name=?, description=?, prompt=? WHERE id=?").run(
          text(payload.name, 100),
          text(payload.description) || null,
          text(payload.prompt) || null,
          departmentId,
        );
      } else {
        const running = db
          .prepare(
            "SELECT 1 FROM tasks WHERE (department_id=? OR assigned_agent_id IN (SELECT id FROM agents WHERE department_id=?)) AND status IN ('in_progress','collaborating','review') LIMIT 1",
          )
          .get(departmentId, departmentId);
        if (running || db.prepare("SELECT 1 FROM agents WHERE department_id=? AND status='working'").get(departmentId))
          throw new Error("org_department_has_running_tasks");
        const target = text(payload.reassign_department_id);
        if (payload.agents_action === "reassign") {
          if (!target || target === departmentId || !db.prepare("SELECT id FROM departments WHERE id=?").get(target))
            throw new Error("org_reassignment_department_required");
          const count = Number(
            (
              db
                .prepare("SELECT COUNT(*) AS count FROM agents WHERE department_id IN (?,?)")
                .get(departmentId, target) as { count: number }
            ).count,
          );
          if (count > MAX_DEPARTMENT_AGENTS) throw new Error("org_agent_cap_reached");
          db.prepare("UPDATE agents SET department_id=? WHERE department_id=?").run(target, departmentId);
        } else {
          const workers = db
            .prepare("SELECT id FROM agents WHERE department_id=? AND role!='vp'")
            .all(departmentId) as { id: string }[];
          for (const worker of workers) deleteWorker(db, worker.id);
        }
        // Preserve historic tasks while removing their obsolete organizational assignment.
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        for (const { name } of tables) {
          const table = `"${name.replaceAll('"', '""')}"`;
          const refs = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string }[];
          for (const ref of refs.filter((ref) => ref.table === "departments")) {
            const column = `"${ref.from.replaceAll('"', '""')}"`;
            db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(
              (target || null) as SQLInputValue,
              departmentId,
            );
          }
        }
        db.prepare("DELETE FROM departments WHERE id=?").run(departmentId);
      }
    }
    db.prepare("UPDATE org_requests SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'").run(
      approve ? "approved" : "denied",
      decidedBy,
      Date.now(),
      id,
    );
    db.exec("RELEASE org_decision");
    return db.prepare("SELECT * FROM org_requests WHERE id=?").get(id) as unknown as OrgRequest;
  } catch (error) {
    db.exec("ROLLBACK TO org_decision; RELEASE org_decision");
    throw error;
  }
}
