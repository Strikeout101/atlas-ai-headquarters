import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_KEYS, BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";

/**
 * Who approves what, per business. These are owner settings (Settings > Businesses > Approvals), not code, so the
 * level of automation can be raised business by business over time.
 *
 * - customer_sends: emails, posts and listings a customer can see. `owner` or `vp` (both VPs must agree).
 * - record_changes: agents creating, editing or deleting contacts, tickets, quotes and deals. `none` applies them
 *   directly; `vp` or `owner` queues them for approval first.
 * - code_pushes: pushing approved work to the project's GitHub repo. `none` pushes right after review.
 *
 * Hard floors are not here and cannot be switched off: spending money, paid accounts, accepting terms and
 * destructive SSH always need the owner (approval-policy.ts).
 */
export const CUSTOMER_SEND_LEVELS = ["owner", "vp"] as const;
export const GATE_LEVELS = ["none", "vp", "owner"] as const;
export type CustomerSendLevel = (typeof CUSTOMER_SEND_LEVELS)[number];
export type GateLevel = (typeof GATE_LEVELS)[number];

export interface BusinessPolicy {
  business: BusinessKey;
  customer_sends: CustomerSendLevel;
  record_changes: GateLevel;
  code_pushes: GateLevel;
  updated_at: number;
}

/** What a fresh install starts with. Primrose Events is the LLC, so its record changes need the owner. */
export const DEFAULT_POLICIES: Record<BusinessKey, Omit<BusinessPolicy, "business" | "updated_at">> = {
  tech: { customer_sends: "owner", record_changes: "none", code_pushes: "none" },
  rental: { customer_sends: "owner", record_changes: "owner", code_pushes: "none" },
  ventures: { customer_sends: "vp", record_changes: "none", code_pushes: "none" },
};

let cache: Record<BusinessKey, BusinessPolicy> | null = null;

function defaults(): Record<BusinessKey, BusinessPolicy> {
  return Object.fromEntries(
    BUSINESS_KEYS.map((key) => [key, { business: key, ...DEFAULT_POLICIES[key], updated_at: 0 }]),
  ) as Record<BusinessKey, BusinessPolicy>;
}

export function ensureBusinessPolicySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_policies (
    business TEXT PRIMARY KEY CHECK(business IN (${BUSINESS_SQL_LIST})),
    customer_sends TEXT NOT NULL CHECK(customer_sends IN ('owner','vp')),
    record_changes TEXT NOT NULL CHECK(record_changes IN ('none','vp','owner')),
    code_pushes TEXT NOT NULL CHECK(code_pushes IN ('none','vp','owner')),
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  const seed = db.prepare(
    "INSERT OR IGNORE INTO business_policies (business,customer_sends,record_changes,code_pushes) VALUES (?,?,?,?)",
  );
  for (const key of BUSINESS_KEYS) {
    const policy = DEFAULT_POLICIES[key];
    seed.run(key, policy.customer_sends, policy.record_changes, policy.code_pushes);
  }
  loadBusinessPolicies(db);
}

export function loadBusinessPolicies(db: DatabaseSync): Record<BusinessKey, BusinessPolicy> {
  const next = defaults();
  for (const row of db.prepare("SELECT * FROM business_policies").all() as unknown as BusinessPolicy[]) {
    if (isBusinessKey(row.business)) next[row.business] = { ...row };
  }
  cache = next;
  return next;
}

/** The current policy for a business. Before the table is loaded (tests, early startup) the defaults apply. */
export function businessPolicy(business: BusinessKey): BusinessPolicy {
  return (cache ?? defaults())[business];
}

export function listBusinessPolicies(): BusinessPolicy[] {
  const current = cache ?? defaults();
  return BUSINESS_KEYS.map((key) => current[key]);
}

export function saveBusinessPolicy(db: DatabaseSync, business: unknown, input: unknown, now = Date.now()) {
  if (!isBusinessKey(business)) throw new Error("invalid_business");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const body = input as Record<string, unknown>;
  const allowed = ["customer_sends", "record_changes", "code_pushes"];
  if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key)))
    throw new Error("invalid_policy_field");
  const current = businessPolicy(business);
  const next = { ...current, ...body };
  if (!(CUSTOMER_SEND_LEVELS as readonly unknown[]).includes(next.customer_sends))
    throw new Error("invalid_customer_sends");
  if (!(GATE_LEVELS as readonly unknown[]).includes(next.record_changes)) throw new Error("invalid_record_changes");
  if (!(GATE_LEVELS as readonly unknown[]).includes(next.code_pushes)) throw new Error("invalid_code_pushes");
  db.prepare(
    `INSERT INTO business_policies (business,customer_sends,record_changes,code_pushes,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(business) DO UPDATE SET customer_sends=excluded.customer_sends, record_changes=excluded.record_changes,
       code_pushes=excluded.code_pushes, updated_at=excluded.updated_at`,
  ).run(business, next.customer_sends, next.record_changes, next.code_pushes, now);
  loadBusinessPolicies(db);
  return businessPolicy(business);
}

/** Tests only. */
export function resetBusinessPoliciesForTests(): void {
  cache = null;
}
