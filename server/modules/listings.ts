import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import { recordApprovalDecision } from "./trust-ramp.ts";

/**
 * Listing packages: everything needed to publish one product on a storefront, prepared by agents.
 *
 * ATLAS does not publish anything itself yet. An agent prepares a package and submits it; it is approved (by the
 * VPs for the AI-run ventures, by the owner otherwise); the owner publishes it by hand from the checklist and
 * records the listing's address. Storefront API publishing can later replace only that last manual step.
 *
 * Listing fees are real money. A platform's fee only stays inside VP authority while the month's approved fees
 * fit the owner's listing-fee budget; past it, or with no budget set, the package goes to the owner.
 */
export const LISTING_PLATFORMS = ["etsy", "itch"] as const;
export type ListingPlatform = (typeof LISTING_PLATFORMS)[number];
export const LISTING_STATUSES = ["draft", "ready", "approved", "published", "rejected", "withdrawn"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** What the platform charges to publish one listing, in minor units. Etsy: USD 0.20 per listing; itch.io: free. */
export const LISTING_FEES: Record<ListingPlatform, { amount_minor: number; currency: string }> = {
  etsy: { amount_minor: 20, currency: "USD" },
  itch: { amount_minor: 0, currency: "USD" },
};
export const FEE_BUDGET_CURRENCY = "USD";
export const FEE_BUDGET_TIMEZONE = "America/New_York";
const MAX_FEE_BUDGET_MINOR = 100_000; // USD 1,000 a month; anything larger is not a "listing fee budget".

type Row = Record<string, unknown>;
export interface ListingPackage {
  id: string;
  business: BusinessKey;
  platform: ListingPlatform;
  project_id: string | null;
  opportunity_id: string | null;
  title: string;
  description: string;
  tags: string[];
  price_minor: number;
  currency: string;
  files: string[];
  mockups: string[];
  notes: string;
  fee_minor: number;
  fee_currency: string;
  status: ListingStatus;
  listing_url: string | null;
  agent_id: string | null;
  task_id: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  submitted_at: number | null;
  decided_at: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

export function ensureListingSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS listing_packages (
    id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    platform TEXT NOT NULL CHECK(platform IN ('etsy','itch')),
    project_id TEXT, opportunity_id TEXT,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
    price_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(price_minor)='integer' AND price_minor BETWEEN 0 AND 100000000),
    currency TEXT NOT NULL DEFAULT 'USD', files TEXT NOT NULL DEFAULT '[]', mockups TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    fee_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(fee_minor)='integer' AND fee_minor >= 0),
    fee_currency TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','approved','published','rejected','withdrawn')),
    listing_url TEXT, agent_id TEXT, task_id TEXT, decided_by TEXT, decision_reason TEXT,
    submitted_at INTEGER, decided_at INTEGER, published_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listing_packages_status ON listing_packages(status, updated_at DESC);
  CREATE TABLE IF NOT EXISTS listing_fee_budget (
    id INTEGER PRIMARY KEY CHECK(id=1),
    monthly_cap_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(monthly_cap_minor)='integer' AND monthly_cap_minor BETWEEN 0 AND ${MAX_FEE_BUDGET_MINOR}),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO listing_fee_budget(id) VALUES (1);`);
}

function fail(message: string): never {
  throw new Error(message);
}
function text(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) return required ? fail(`invalid_${field}`) : "";
  if (typeof value !== "string" || value.length > max || value.includes("\0")) return fail(`invalid_${field}`);
  const trimmed = value.trim();
  if (required && !trimmed) return fail(`invalid_${field}`);
  return trimmed;
}
function list(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return fail(`invalid_${field}`);
  const items = value.map((entry) => text(entry, field, maxLength, true));
  if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) return fail(`invalid_${field}`);
  return items;
}
/** Files are named, never read or served: a path inside the project, with no way out of it. */
function filePaths(value: unknown, field: string): string[] {
  const paths = list(value, field, 40, 400);
  for (const path of paths) {
    if (/^([a-zA-Z]:|[\\/])/.test(path) || path.split(/[\\/]/).includes("..")) fail(`invalid_${field}`);
  }
  return paths;
}
function parseList(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
function toPackage(row: Row): ListingPackage {
  return {
    ...(row as unknown as ListingPackage),
    tags: parseList(row.tags),
    files: parseList(row.files),
    mockups: parseList(row.mockups),
  };
}
export function getListing(db: DatabaseSync, id: string): ListingPackage | null {
  const row = db.prepare("SELECT * FROM listing_packages WHERE id=?").get(id) as Row | undefined;
  return row ? toPackage(row) : null;
}

const EDITABLE = [
  "title",
  "description",
  "tags",
  "price_minor",
  "currency",
  "files",
  "mockups",
  "notes",
  "project_id",
  "opportunity_id",
] as const;
const CREATE_FIELDS = ["business", "platform", ...EDITABLE] as const;

function contentValues(input: Row, current?: ListingPackage) {
  const merged = { ...(current ?? {}), ...input } as Row;
  const price = merged.price_minor ?? 0;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0 || price > 100_000_000)
    fail("invalid_price_minor");
  const currency = text(merged.currency ?? "USD", "currency", 3, true);
  if (!/^[A-Z]{3}$/.test(currency)) fail("invalid_currency");
  return {
    title: text(merged.title, "title", 140, true),
    description: text(merged.description, "description", 12000),
    tags: list(merged.tags, "tags", 13, 40),
    price_minor: price as number,
    currency,
    files: filePaths(merged.files, "files"),
    mockups: filePaths(merged.mockups, "mockups"),
    notes: text(merged.notes, "notes", 4000),
    project_id: text(merged.project_id, "project_id", 128) || null,
    opportunity_id: text(merged.opportunity_id, "opportunity_id", 128) || null,
  };
}

export function createListing(
  db: DatabaseSync,
  input: Row,
  author: { agentId?: string | null; taskId?: string | null } = {},
  now = Date.now(),
): ListingPackage {
  ensureListingSchema(db);
  if (Object.keys(input).some((key) => !(CREATE_FIELDS as readonly string[]).includes(key)))
    fail("listing_protected_field");
  if (!isBusinessKey(input.business)) fail("invalid_business");
  if (!(LISTING_PLATFORMS as readonly unknown[]).includes(input.platform)) fail("invalid_platform");
  const platform = input.platform as ListingPlatform;
  const values = contentValues(input);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO listing_packages (id,business,platform,project_id,opportunity_id,title,description,tags,price_minor,currency,
      files,mockups,notes,fee_minor,fee_currency,status,agent_id,task_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
  ).run(
    id,
    input.business as string,
    platform,
    values.project_id,
    values.opportunity_id,
    values.title,
    values.description,
    JSON.stringify(values.tags),
    values.price_minor,
    values.currency,
    JSON.stringify(values.files),
    JSON.stringify(values.mockups),
    values.notes,
    LISTING_FEES[platform].amount_minor,
    LISTING_FEES[platform].currency,
    author.agentId ?? null,
    author.taskId ?? null,
    now,
    now,
  );
  return getListing(db, id)!;
}

/** Only drafts change. Once submitted the content is frozen, so what was reviewed is what gets published. */
export function updateListing(db: DatabaseSync, id: string, input: Row, now = Date.now()): ListingPackage {
  ensureListingSchema(db);
  const current = getListing(db, id) ?? fail("listing_not_found");
  if (current.status !== "draft") fail("listing_not_editable");
  if (Object.keys(input).some((key) => !(EDITABLE as readonly string[]).includes(key))) fail("listing_protected_field");
  if (!Object.keys(input).length) fail("no_fields_to_update");
  const values = contentValues(input, current);
  db.prepare(
    `UPDATE listing_packages SET project_id=?,opportunity_id=?,title=?,description=?,tags=?,price_minor=?,currency=?,
      files=?,mockups=?,notes=?,updated_at=? WHERE id=? AND status='draft'`,
  ).run(
    values.project_id,
    values.opportunity_id,
    values.title,
    values.description,
    JSON.stringify(values.tags),
    values.price_minor,
    values.currency,
    JSON.stringify(values.files),
    JSON.stringify(values.mockups),
    values.notes,
    now,
    id,
  );
  return getListing(db, id)!;
}

/** Draft to ready: asks for approval. A package must be complete enough to publish as it stands. */
export function submitListing(db: DatabaseSync, id: string, now = Date.now()): ListingPackage {
  ensureListingSchema(db);
  const current = getListing(db, id) ?? fail("listing_not_found");
  if (current.status !== "draft") fail("listing_not_editable");
  if (!current.description || !current.files.length || current.price_minor <= 0) fail("listing_incomplete");
  db.prepare(
    "UPDATE listing_packages SET status='ready',submitted_at=?,updated_at=? WHERE id=? AND status='draft'",
  ).run(now, now, id);
  return getListing(db, id)!;
}

export function feeBudgetMonth(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FEE_BUDGET_TIMEZONE, year: "numeric", month: "2-digit" }).format(
    now,
  );
}

/** The owner's monthly allowance for listing fees and how much of it approved listings have used this month. */
export function feeBudget(db: DatabaseSync, now = Date.now()) {
  ensureListingSchema(db);
  const cap = Number(
    (db.prepare("SELECT monthly_cap_minor FROM listing_fee_budget WHERE id=1").get() as Row).monthly_cap_minor,
  );
  const month = feeBudgetMonth(now);
  const rows = db
    .prepare(
      `SELECT fee_minor, decided_at FROM listing_packages
       WHERE status IN ('approved','published') AND fee_minor > 0 AND fee_currency = ? AND decided_at >= ?`,
    )
    .all(FEE_BUDGET_CURRENCY, now - 32 * 86_400_000) as Array<{ fee_minor: number; decided_at: number }>;
  const used = rows
    .filter((row) => feeBudgetMonth(Number(row.decided_at)) === month)
    .reduce((sum, row) => sum + Number(row.fee_minor), 0);
  return {
    month,
    currency: FEE_BUDGET_CURRENCY,
    monthly_cap_minor: cap,
    used_minor: used,
    remaining_minor: Math.max(0, cap - used),
  };
}

export function setFeeBudget(db: DatabaseSync, capMinor: unknown, now = Date.now()) {
  ensureListingSchema(db);
  if (
    typeof capMinor !== "number" ||
    !Number.isSafeInteger(capMinor) ||
    capMinor < 0 ||
    capMinor > MAX_FEE_BUDGET_MINOR
  )
    fail("invalid_monthly_cap_minor");
  db.prepare("UPDATE listing_fee_budget SET monthly_cap_minor=?,updated_at=? WHERE id=1").run(capMinor as number, now);
  return feeBudget(db, now);
}

/** True when publishing this package would cost money the owner has not already allowed for this month. */
export function feeNeedsOwner(
  db: DatabaseSync,
  listing: Pick<ListingPackage, "fee_minor" | "fee_currency">,
  now = Date.now(),
) {
  if (listing.fee_minor <= 0) return false;
  if (listing.fee_currency !== FEE_BUDGET_CURRENCY) return true;
  return listing.fee_minor > feeBudget(db, now).remaining_minor;
}

/** Who may approve this package right now. Fails closed to the owner. */
export function listingApprover(db: DatabaseSync, listing: ListingPackage, now = Date.now()): "owner" | "vp" {
  if (businessPolicy(listing.business).customer_sends !== "vp") return "owner";
  return feeNeedsOwner(db, listing, now) ? "owner" : "vp";
}

/** Stable fingerprint of exactly what is being approved. */
export function listingContentHash(listing: ListingPackage): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        listing.business,
        listing.platform,
        listing.title,
        listing.description,
        listing.tags,
        listing.price_minor,
        listing.currency,
        listing.files,
        listing.mockups,
        listing.fee_minor,
        listing.fee_currency,
      ]),
    )
    .digest("hex");
}

/**
 * Approve or reject a submitted package. The budget is re-checked inside the same transaction that records the
 * approval, so two packages cannot both squeeze into the last of the month's allowance.
 */
export function decideListing(
  db: DatabaseSync,
  id: string,
  approve: boolean,
  decidedBy = "owner",
  reason = "",
  now = Date.now(),
): ListingPackage {
  ensureListingSchema(db);
  db.exec("SAVEPOINT listing_decision");
  try {
    const current = getListing(db, id) ?? fail("listing_not_found");
    if (current.status !== "ready") fail("listing_already_decided");
    if (decidedBy !== "owner") {
      if (!decidedBy.startsWith("vp:")) fail("listing_decider_forbidden");
      if (listingApprover(db, current, now) !== "vp") fail("owner_approval_required");
    }
    const changed = db
      .prepare(
        "UPDATE listing_packages SET status=?,decided_by=?,decision_reason=?,decided_at=?,updated_at=? WHERE id=? AND status='ready'",
      )
      .run(approve ? "approved" : "rejected", decidedBy, reason.trim().slice(0, 2000) || null, now, now, id).changes;
    if (!changed) fail("listing_already_decided");
    recordApprovalDecision(
      db,
      { approvalKind: "listing_publish", business: current.business, agentId: current.agent_id, approve, decidedBy },
      now,
    );
    db.exec("RELEASE listing_decision");
    return getListing(db, id)!;
  } catch (error) {
    db.exec("ROLLBACK TO listing_decision; RELEASE listing_decision");
    throw error;
  }
}

/** Owner only: the listing is live. Records where, and the platform fee as an unverified cost. */
export function markListingPublished(db: DatabaseSync, id: string, url: unknown, now = Date.now()): ListingPackage {
  ensureListingSchema(db);
  const address = text(url, "listing_url", 500, true);
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return fail("invalid_listing_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail("invalid_listing_url");
  db.exec("SAVEPOINT listing_published");
  try {
    const current = getListing(db, id) ?? fail("listing_not_found");
    if (current.status !== "approved") fail("listing_not_approved");
    db.prepare(
      "UPDATE listing_packages SET status='published',listing_url=?,published_at=?,updated_at=? WHERE id=? AND status='approved'",
    ).run(parsed.toString(), now, now, id);
    const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get();
    if (current.fee_minor > 0 && hasLedger) {
      // Recorded by hand, so it is never "verified": only imported payment evidence is.
      db.prepare(
        `INSERT INTO ledger_entries (id,business,kind,amount_minor,currency,source,external_id,verified,opportunity_id,
           description,occurred_at,created_at,updated_at)
         VALUES (?,?,'expense',?,?,'manual',?,0,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        current.business,
        current.fee_minor,
        current.fee_currency,
        `listing-fee:${current.id}`,
        current.opportunity_id,
        `${current.platform === "etsy" ? "Etsy" : "itch.io"} listing fee: ${current.title}`.slice(0, 300),
        now,
        now,
        now,
      );
    }
    db.exec("RELEASE listing_published");
    return getListing(db, id)!;
  } catch (error) {
    db.exec("ROLLBACK TO listing_published; RELEASE listing_published");
    throw error;
  }
}

/** Pull a package back before it is published. Published listings are taken down on the platform, not here. */
export function withdrawListing(db: DatabaseSync, id: string, now = Date.now()): ListingPackage {
  ensureListingSchema(db);
  const current = getListing(db, id) ?? fail("listing_not_found");
  if (!["draft", "ready", "approved"].includes(current.status)) fail("listing_not_withdrawable");
  db.prepare("UPDATE listing_packages SET status='withdrawn',updated_at=? WHERE id=? AND status=?").run(
    now,
    id,
    current.status,
  );
  return getListing(db, id)!;
}

export function listingsOverview(
  db: DatabaseSync,
  filter: { business?: string; status?: string } = {},
  now = Date.now(),
) {
  ensureListingSchema(db);
  if (filter.business !== undefined && !isBusinessKey(filter.business)) fail("invalid_business");
  if (filter.status !== undefined && !(LISTING_STATUSES as readonly string[]).includes(filter.status))
    fail("invalid_status");
  const where: string[] = [];
  const args: string[] = [];
  if (filter.business) {
    where.push("business=?");
    args.push(filter.business);
  }
  if (filter.status) {
    where.push("status=?");
    args.push(filter.status);
  }
  const rows = db
    .prepare(
      `SELECT * FROM listing_packages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 200`,
    )
    .all(...args) as Row[];
  return {
    items: rows.map(toPackage).map((item) => ({ ...item, approver: listingApprover(db, item, now) })),
    budget: feeBudget(db, now),
    fees: LISTING_FEES,
  };
}
