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
 * - owner_amount_minor / amount_currency: deals and quotes at or above this amount always go to the owner (0 = off).
 *   An amount in another currency cannot be compared, so it goes to the owner too.
 * - tier_to_owner: which client tiers always go to the owner: `important` (important and VIP), `vip`, or `off`.
 * - trust_ramp_after: after this many owner approvals in a row with no denial, offer to let the VPs approve that
 *   kind of item (0 = never offer). The offer is never applied automatically.
 *
 * Hard floors are not here and cannot be switched off: spending money (beyond the owner's spending budgets),
 * paid accounts, accepting terms and destructive SSH always need the owner (approval-policy.ts).
 */
export const CUSTOMER_SEND_LEVELS = ["owner", "vp"] as const;
export const GATE_LEVELS = ["none", "vp", "owner"] as const;
export const TIER_RULES = ["important", "vip", "off"] as const;
export type CustomerSendLevel = (typeof CUSTOMER_SEND_LEVELS)[number];
export type GateLevel = (typeof GATE_LEVELS)[number];
export type TierRule = (typeof TIER_RULES)[number];
export const MAX_POLICY_AMOUNT_MINOR = 100_000_000_00;

export interface BusinessPolicy {
  business: BusinessKey;
  customer_sends: CustomerSendLevel;
  record_changes: GateLevel;
  code_pushes: GateLevel;
  owner_amount_minor: number;
  amount_currency: string;
  tier_to_owner: TierRule;
  trust_ramp_after: number;
  updated_at: number;
}

type PolicyFields = Omit<BusinessPolicy, "business" | "updated_at">;
const SHARED_DEFAULTS = {
  owner_amount_minor: 100_000,
  amount_currency: "USD",
  tier_to_owner: "important",
  trust_ramp_after: 20,
} as const;

/** What a fresh install starts with. Primrose Events is the LLC, so its record changes need the owner. */
export const DEFAULT_POLICIES: Record<BusinessKey, PolicyFields> = {
  tech: { customer_sends: "owner", record_changes: "none", code_pushes: "none", ...SHARED_DEFAULTS },
  rental: { customer_sends: "owner", record_changes: "owner", code_pushes: "none", ...SHARED_DEFAULTS },
  ventures: { customer_sends: "vp", record_changes: "none", code_pushes: "none", ...SHARED_DEFAULTS },
};
const FIELDS = Object.keys(DEFAULT_POLICIES.tech) as (keyof PolicyFields)[];

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
  const columns = new Set(
    (db.prepare("PRAGMA table_info(business_policies)").all() as { name: string }[]).map((c) => c.name),
  );
  const added: Record<string, string> = {
    owner_amount_minor: `INTEGER NOT NULL DEFAULT ${SHARED_DEFAULTS.owner_amount_minor} CHECK(typeof(owner_amount_minor)='integer' AND owner_amount_minor BETWEEN 0 AND ${MAX_POLICY_AMOUNT_MINOR})`,
    amount_currency: `TEXT NOT NULL DEFAULT '${SHARED_DEFAULTS.amount_currency}'`,
    tier_to_owner: `TEXT NOT NULL DEFAULT '${SHARED_DEFAULTS.tier_to_owner}' CHECK(tier_to_owner IN ('important','vip','off'))`,
    trust_ramp_after: `INTEGER NOT NULL DEFAULT ${SHARED_DEFAULTS.trust_ramp_after} CHECK(typeof(trust_ramp_after)='integer' AND trust_ramp_after BETWEEN 0 AND 1000)`,
  };
  for (const [name, definition] of Object.entries(added))
    if (!columns.has(name)) db.exec(`ALTER TABLE business_policies ADD COLUMN ${name} ${definition}`);
  const seed = db.prepare(
    `INSERT OR IGNORE INTO business_policies (business,${FIELDS.join(",")}) VALUES (?,${FIELDS.map(() => "?").join(",")})`,
  );
  for (const key of BUSINESS_KEYS) seed.run(key, ...FIELDS.map((field) => DEFAULT_POLICIES[key][field]));
  loadBusinessPolicies(db);
}

export function loadBusinessPolicies(db: DatabaseSync): Record<BusinessKey, BusinessPolicy> {
  const next = defaults();
  for (const row of db.prepare("SELECT * FROM business_policies").all() as unknown as BusinessPolicy[]) {
    if (isBusinessKey(row.business)) next[row.business] = { ...next[row.business], ...row };
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

function oneOf<T extends string>(values: readonly T[], value: unknown, error: string): T {
  if (!(values as readonly unknown[]).includes(value)) throw new Error(error);
  return value as T;
}
function wholeNumber(value: unknown, max: number, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(error);
  return value;
}

export function saveBusinessPolicy(db: DatabaseSync, business: unknown, input: unknown, now = Date.now()) {
  if (!isBusinessKey(business)) throw new Error("invalid_business");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const body = input as Record<string, unknown>;
  if (!Object.keys(body).length || Object.keys(body).some((key) => !(FIELDS as string[]).includes(key)))
    throw new Error("invalid_policy_field");
  const merged = { ...businessPolicy(business), ...body };
  const next: PolicyFields = {
    customer_sends: oneOf(CUSTOMER_SEND_LEVELS, merged.customer_sends, "invalid_customer_sends"),
    record_changes: oneOf(GATE_LEVELS, merged.record_changes, "invalid_record_changes"),
    code_pushes: oneOf(GATE_LEVELS, merged.code_pushes, "invalid_code_pushes"),
    owner_amount_minor: wholeNumber(merged.owner_amount_minor, MAX_POLICY_AMOUNT_MINOR, "invalid_owner_amount"),
    amount_currency:
      typeof merged.amount_currency === "string" && /^[A-Z]{3}$/.test(merged.amount_currency.trim().toUpperCase())
        ? merged.amount_currency.trim().toUpperCase()
        : (() => {
            throw new Error("invalid_amount_currency");
          })(),
    tier_to_owner: oneOf(TIER_RULES, merged.tier_to_owner, "invalid_tier_to_owner"),
    trust_ramp_after: wholeNumber(merged.trust_ramp_after, 1000, "invalid_trust_ramp_after"),
  };
  db.prepare(
    `INSERT INTO business_policies (business,${FIELDS.join(",")},updated_at) VALUES (?,${FIELDS.map(() => "?").join(",")},?)
     ON CONFLICT(business) DO UPDATE SET ${FIELDS.map((f) => `${f}=excluded.${f}`).join(",")}, updated_at=excluded.updated_at`,
  ).run(business, ...FIELDS.map((field) => next[field]), now);
  loadBusinessPolicies(db);
  return businessPolicy(business);
}

/** Tests only. */
export function resetBusinessPoliciesForTests(): void {
  cache = null;
}
