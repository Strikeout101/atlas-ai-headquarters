import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { factsFromContent, routeApproval } from "./approval-policy.ts";

export interface ReviewableApproval {
  kind: string;
  id: string;
  business?: string;
  org_kind?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export function ensureApprovalReviewSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_reviews (
    approval_kind TEXT NOT NULL, approval_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    vp_agent_id TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('approve','deny','escalate')),
    reason TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (approval_kind,approval_id,snapshot_hash,vp_agent_id)
  );
  CREATE TABLE IF NOT EXISTS approval_vp_state (
    approval_kind TEXT NOT NULL, approval_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reviewing','waiting','escalated','decided')),
    reason TEXT NOT NULL DEFAULT '', outcome TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(approval_kind,approval_id)
  );
  CREATE TABLE IF NOT EXISTS vp_unavailability (
    provider TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, reason TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_vp_events (
    id INTEGER PRIMARY KEY, approval_kind TEXT NOT NULL, approval_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT NOT NULL, outcome TEXT, created_at INTEGER NOT NULL
  );`);
}

export function approvalSnapshot(item: ReviewableApproval): string {
  const { vp_review: _review, ...content } = item;
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, stable(entry)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable(content)))
    .digest("hex");
}

export function approvalRoute(item: ReviewableApproval): "owner" | "vp" {
  // Product copy is full of words like "buy" and "purchase"; they describe the product, not a spend by ATLAS.
  // The only money a listing spends is the platform fee, and the server works that out against the owner's budget.
  if (item.kind === "listing_publish")
    return routeApproval(item.kind, item.business, { spendsMoney: item.fee_over_budget !== false });
  return routeApproval(item.kind, item.business, {
    ...factsFromContent(JSON.stringify(item)),
    orgKind: item.org_kind,
    departmentId: typeof item.payload?.department_id === "string" ? item.payload.department_id : undefined,
    spendsMoney: factsFromContent(JSON.stringify(item)).spendsMoney || item.payload?.spends_money === true,
    newPaidAccount: item.payload?.new_paid_account === true || factsFromContent(JSON.stringify(item)).newPaidAccount,
    agreesToTerms: item.payload?.agrees_to_terms === true || factsFromContent(JSON.stringify(item)).agreesToTerms,
  });
}

export function getApprovalVpState(db: DatabaseSync, item: ReviewableApproval) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_vp_state'").get()) return null;
  const state = db
    .prepare(
      "SELECT status,reason,outcome,snapshot_hash,updated_at FROM approval_vp_state WHERE approval_kind=? AND approval_id=?",
    )
    .get(item.kind, item.id) as
    | { status: string; reason: string; outcome: string | null; snapshot_hash: string; updated_at: number }
    | undefined;
  if (!state || state.snapshot_hash !== approvalSnapshot(item)) return null;
  const reviews = db
    .prepare(
      "SELECT vp_agent_id,verdict,reason,created_at FROM approval_reviews WHERE approval_kind=? AND approval_id=? AND snapshot_hash=? ORDER BY created_at,vp_agent_id",
    )
    .all(item.kind, item.id, state.snapshot_hash);
  return { status: state.status, reason: state.reason, reviews, updated_at: state.updated_at };
}

export function isOwnerApproval(db: DatabaseSync, item: ReviewableApproval): boolean {
  if (approvalRoute(item) === "owner") return true;
  return ["waiting", "escalated"].includes(getApprovalVpState(db, item)?.status ?? "");
}
