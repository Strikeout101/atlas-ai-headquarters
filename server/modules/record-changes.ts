import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import { createDeal, updateDeal } from "./finance-store.ts";
import { localApi } from "./local-api.ts";

/**
 * Agent changes to business records that the business's policy says must be approved first.
 *
 * When a business's `record_changes` setting is `owner` or `vp`, an agent's create, update or delete of a contact,
 * ticket, quote or deal is stored here instead of being applied. It shows in the approval queue; approving applies it
 * through the same code the app uses. If the record changed after the request was made, approving refuses it rather
 * than overwriting someone else's edit. Drafts are never gated: they are drafts, and sending them has its own approval.
 */
export const GATED_RESOURCES = ["contacts", "tickets", "quotes", "deals"] as const;
export type GatedResource = (typeof GATED_RESOURCES)[number];
export type RecordAction = "create" | "update" | "delete";

const TABLE_FOR: Record<GatedResource, string> = {
  contacts: "business_contacts",
  tickets: "business_tickets",
  quotes: "business_quotes",
  deals: "deals",
};
const FIXED_BUSINESS: Partial<Record<GatedResource, BusinessKey>> = { tickets: "tech", quotes: "rental" };

export interface RecordChangeRequest {
  id: string;
  business: BusinessKey;
  resource: GatedResource;
  action: RecordAction;
  target_id: string | null;
  payload: Record<string, unknown>;
  target_sha256: string | null;
  agent_id: string | null;
  task_id: string | null;
  status: "pending" | "applied" | "denied" | "failed";
  decided_by: string | null;
  decided_at: number | null;
  result_id: string | null;
  error_code: string | null;
  created_at: number;
}

type Row = Record<string, unknown>;

export function ensureRecordChangeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS record_change_requests (
    id TEXT PRIMARY KEY,
    business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    resource TEXT NOT NULL CHECK(resource IN ('contacts','tickets','quotes','deals')),
    action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
    target_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    target_sha256 TEXT,
    agent_id TEXT,
    task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','denied','failed')),
    decided_by TEXT,
    decided_at INTEGER,
    result_id TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_record_change_requests_status ON record_change_requests(status, created_at DESC);`);
}

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function targetRow(db: DatabaseSync, resource: GatedResource, id: string): Row | undefined {
  if (!tableExists(db, TABLE_FOR[resource])) return undefined;
  return db.prepare(`SELECT * FROM ${TABLE_FOR[resource]} WHERE id=?`).get(id) as Row | undefined;
}

export function isGatedResource(value: unknown): value is GatedResource {
  return typeof value === "string" && (GATED_RESOURCES as readonly string[]).includes(value);
}

/** Which business a change belongs to: fixed for tickets and quotes, the payload's for a new record, else the record's. */
export function recordChangeBusiness(
  db: DatabaseSync,
  resource: GatedResource,
  action: RecordAction,
  targetId: string | null,
  payload: Record<string, unknown> | undefined,
): BusinessKey | null {
  if (FIXED_BUSINESS[resource]) return FIXED_BUSINESS[resource]!;
  if (action === "create") return isBusinessKey(payload?.business) ? payload.business : null;
  const row = targetId ? targetRow(db, resource, targetId) : undefined;
  return isBusinessKey(row?.business) ? row.business : null;
}

/** True when this change must wait for approval under the business's current policy. */
export function recordChangeNeedsApproval(business: BusinessKey | null): boolean {
  return business !== null && businessPolicy(business).record_changes !== "none";
}

function toRequest(row: Row): RecordChangeRequest {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row.payload ?? "{}"));
  } catch {
    payload = {};
  }
  return { ...(row as unknown as RecordChangeRequest), payload };
}

export function getRecordChange(db: DatabaseSync, id: string): RecordChangeRequest | null {
  ensureRecordChangeSchema(db);
  const row = db.prepare("SELECT * FROM record_change_requests WHERE id=?").get(id) as Row | undefined;
  return row ? toRequest(row) : null;
}

export function queueRecordChange(
  db: DatabaseSync,
  input: {
    business: BusinessKey;
    resource: GatedResource;
    action: RecordAction;
    targetId?: string | null;
    payload?: Record<string, unknown>;
    agentId?: string | null;
    taskId?: string | null;
  },
  now = Date.now(),
): RecordChangeRequest {
  ensureRecordChangeSchema(db);
  const targetId = input.targetId ?? null;
  if (input.action !== "create" && !targetId) throw new Error("business_id_required");
  const target = targetId ? targetRow(db, input.resource, targetId) : undefined;
  if (input.action !== "create" && !target) throw new Error("record_not_found");
  const payload = input.payload ?? {};
  if (JSON.stringify(payload).length > 16_000) throw new Error("business_payload_too_large");
  // The same pending request from the same task is reused instead of piling up in the owner's queue.
  const duplicate = db
    .prepare(
      `SELECT id FROM record_change_requests WHERE status='pending' AND resource=? AND action=? AND
       COALESCE(target_id,'')=COALESCE(?,'') AND payload=? AND COALESCE(task_id,'')=COALESCE(?,'')`,
    )
    .get(input.resource, input.action, targetId, JSON.stringify(payload), input.taskId ?? null) as Row | undefined;
  if (duplicate) return getRecordChange(db, String(duplicate.id))!;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO record_change_requests (id,business,resource,action,target_id,payload,target_sha256,agent_id,task_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.business,
    input.resource,
    input.action,
    targetId,
    JSON.stringify(payload),
    target ? hash(target) : null,
    input.agentId ?? null,
    input.taskId ?? null,
    now,
  );
  return getRecordChange(db, id)!;
}

/** What applying a request does. Business records go through the app's own routes; deals through the finance store. */
export type ApplyRecordChange = (db: DatabaseSync, request: RecordChangeRequest) => Promise<string | null>;

export const applyRecordChangeDefault: ApplyRecordChange = async (db, request) => {
  if (request.resource === "deals") {
    if (request.action === "create") return String(createDeal(db, request.payload).id);
    if (request.action === "update") return String(updateDeal(db, request.target_id ?? "", request.payload).id);
    throw new Error("record_action_unsupported");
  }
  const base = `/api/business/${request.resource}`;
  const path = request.target_id ? `${base}/${encodeURIComponent(request.target_id)}` : base;
  const method = { create: "POST", update: "PATCH", delete: "DELETE" }[request.action];
  const upstream = await localApi(method, path, request.action === "delete" ? undefined : request.payload);
  if (upstream.status >= 300) throw new Error(String(upstream.result?.error ?? "record_change_failed"));
  return String(upstream.result?.item?.id ?? upstream.result?.id ?? request.target_id ?? "") || null;
};

/**
 * Approve (apply) or deny a pending request. Claimed before any await, so it is applied at most once. A target that
 * changed since the request was made is refused, not overwritten.
 */
export async function decideRecordChange(
  db: DatabaseSync,
  id: string,
  approve: boolean,
  decidedBy = "owner",
  apply: ApplyRecordChange = applyRecordChangeDefault,
  now = Date.now(),
): Promise<RecordChangeRequest> {
  const request = getRecordChange(db, id);
  if (!request) throw new Error("record_change_not_found");
  if (request.status !== "pending") throw new Error("record_change_already_decided");
  if (!approve) {
    db.prepare(
      "UPDATE record_change_requests SET status='denied',decided_by=?,decided_at=? WHERE id=? AND status='pending'",
    ).run(decidedBy, now, id);
    return getRecordChange(db, id)!;
  }
  if (request.target_id) {
    const current = targetRow(db, request.resource, request.target_id);
    if (!current || hash(current) !== request.target_sha256) {
      db.prepare(
        "UPDATE record_change_requests SET status='failed',error_code='record_changed_since_request',decided_by=?,decided_at=? WHERE id=? AND status='pending'",
      ).run(decidedBy, now, id);
      throw new Error("record_changed_since_request");
    }
  }
  const claim = db
    .prepare(
      "UPDATE record_change_requests SET status='applied',decided_by=?,decided_at=? WHERE id=? AND status='pending'",
    )
    .run(decidedBy, now, id);
  if (!claim.changes) throw new Error("record_change_already_decided");
  try {
    const resultId = await apply(db, request);
    db.prepare("UPDATE record_change_requests SET result_id=? WHERE id=?").run(resultId, id);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : "record_change_failed";
    db.prepare("UPDATE record_change_requests SET status='failed',error_code=? WHERE id=?").run(code, id);
    throw error;
  }
  return getRecordChange(db, id)!;
}

/** Short human description for the approval queue. */
export function describeRecordChange(request: RecordChangeRequest): string {
  const name =
    request.payload.name ?? request.payload.title ?? request.payload.event_name ?? request.target_id ?? "a record";
  const noun = { contacts: "contact", tickets: "ticket", quotes: "quote", deals: "deal" }[request.resource];
  return `${request.action === "create" ? "Add" : request.action === "update" ? "Change" : "Delete"} ${noun} "${String(name).slice(0, 120)}"`;
}
