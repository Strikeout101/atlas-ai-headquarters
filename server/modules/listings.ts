import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import { recordApprovalDecision } from "./trust-ramp.ts";
import { markOpportunityLaunched } from "./experiments.ts";

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
  taxonomy_id: number | null;
  who_made: string;
  when_made: string;
  etsy_listing_id: string | null;
  /** A change to a live listing: the package it revises. Approved like any package, then applied to the same listing. */
  revision_of: string | null;
  /** The listing's state on Etsy as last read (active, inactive, draft, expired, sold_out, removed). */
  etsy_state: string | null;
  /** 1 when the owner brought an existing Etsy listing into ATLAS (it was not created here). */
  etsy_adopted: number;
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
  // Fields Etsy needs to create a listing, and the Etsy listing id once a draft is pushed.
  const have = new Set(
    (db.prepare("PRAGMA table_info(listing_packages)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!have.has("taxonomy_id")) db.exec("ALTER TABLE listing_packages ADD COLUMN taxonomy_id INTEGER");
  if (!have.has("who_made")) db.exec("ALTER TABLE listing_packages ADD COLUMN who_made TEXT NOT NULL DEFAULT 'i_did'");
  if (!have.has("when_made"))
    db.exec("ALTER TABLE listing_packages ADD COLUMN when_made TEXT NOT NULL DEFAULT 'made_to_order'");
  if (!have.has("etsy_listing_id")) db.exec("ALTER TABLE listing_packages ADD COLUMN etsy_listing_id TEXT");
  if (!have.has("revision_of")) db.exec("ALTER TABLE listing_packages ADD COLUMN revision_of TEXT");
  if (!have.has("etsy_state")) db.exec("ALTER TABLE listing_packages ADD COLUMN etsy_state TEXT");
  if (!have.has("etsy_adopted"))
    db.exec("ALTER TABLE listing_packages ADD COLUMN etsy_adopted INTEGER NOT NULL DEFAULT 0");
}

/** Etsy's allowed values (from its OpenAPI spec). Digital goods made by the shop: `i_did` and `made_to_order`. */
export const ETSY_WHO_MADE = ["i_did", "someone_else", "collective"] as const;
export const ETSY_WHEN_MADE = [
  "made_to_order",
  "2020_2026",
  "2010_2019",
  "2007_2009",
  "before_2007",
  "2000_2006",
] as const;

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
  "taxonomy_id",
  "who_made",
  "when_made",
] as const;
const CREATE_FIELDS = ["business", "platform", ...EDITABLE] as const;

/** Etsy refuses tags longer than this; checked when the package is written, not when the draft is pushed. */
export const ETSY_TAG_MAX = 20;

function contentValues(input: Row, current?: ListingPackage) {
  const merged = { ...(current ?? {}), ...input } as Row;
  const tags = list(merged.tags, "tags", 13, 40);
  const longTag = merged.platform === "etsy" ? tags.find((tag) => tag.length > ETSY_TAG_MAX) : undefined;
  if (longTag !== undefined)
    fail(`etsy_tag_too_long: "${longTag.slice(0, 40)}" (Etsy allows ${ETSY_TAG_MAX} characters)`);
  const price = merged.price_minor ?? 0;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0 || price > 100_000_000)
    fail("invalid_price_minor");
  const currency = text(merged.currency ?? "USD", "currency", 3, true);
  if (!/^[A-Z]{3}$/.test(currency)) fail("invalid_currency");
  return {
    title: text(merged.title, "title", 140, true),
    description: text(merged.description, "description", 12000),
    tags,
    price_minor: price as number,
    currency,
    files: filePaths(merged.files, "files"),
    mockups: filePaths(merged.mockups, "mockups"),
    notes: text(merged.notes, "notes", 4000),
    project_id: text(merged.project_id, "project_id", 128) || null,
    opportunity_id: text(merged.opportunity_id, "opportunity_id", 128) || null,
    taxonomy_id: (() => {
      const value = merged.taxonomy_id;
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fail("invalid_taxonomy_id");
      return value;
    })(),
    who_made: (() => {
      const value = merged.who_made ?? "i_did";
      if (!(ETSY_WHO_MADE as readonly unknown[]).includes(value)) return fail("invalid_who_made");
      return value as string;
    })(),
    when_made: (() => {
      const value = merged.when_made ?? "made_to_order";
      if (!(ETSY_WHEN_MADE as readonly unknown[]).includes(value)) return fail("invalid_when_made");
      return value as string;
    })(),
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
      files,mockups,notes,fee_minor,fee_currency,status,agent_id,task_id,created_at,updated_at,taxonomy_id,who_made,when_made)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?)`,
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
    values.taxonomy_id,
    values.who_made,
    values.when_made,
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
      files=?,mockups=?,notes=?,taxonomy_id=?,who_made=?,when_made=?,updated_at=? WHERE id=? AND status='draft'`,
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
    values.taxonomy_id,
    values.who_made,
    values.when_made,
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
  const target = current.revision_of ? getListing(db, current.revision_of) : null;
  if (current.revision_of && !target) fail("listing_not_found");
  // A revision keeps the live listing's files and images when it leaves them empty (adopted listings have none here).
  if (!current.description || (!target && !current.files.length) || current.price_minor <= 0)
    fail("listing_incomplete");
  if (target && revisionChanges(current, target).length === 0) fail("listing_revision_unchanged");
  // Etsy will not create a listing without a category (taxonomy). Agents look one up with etsy.taxonomy.
  if (current.platform === "etsy" && !current.taxonomy_id) fail("listing_taxonomy_required");
  db.prepare(
    "UPDATE listing_packages SET status='ready',submitted_at=?,updated_at=? WHERE id=? AND status='draft'",
  ).run(now, now, id);
  return getListing(db, id)!;
}

/** VPs may approve a revision that moves the price by at most this share (50%) either way. */
export const REVISION_PRICE_SWING = 0.5;
export type RevisionField = "title" | "description" | "tags" | "price" | "images" | "files";

/** What a revision changes on the live listing. Empty images or files mean "keep the ones on Etsy". */
export function revisionChanges(revision: ListingPackage, target: ListingPackage): RevisionField[] {
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const changes: RevisionField[] = [];
  if (revision.title !== target.title) changes.push("title");
  if (revision.description !== target.description) changes.push("description");
  if (!same(revision.tags, target.tags)) changes.push("tags");
  if (revision.price_minor !== target.price_minor) changes.push("price");
  if (revision.mockups.length && !same(revision.mockups, target.mockups)) changes.push("images");
  if (revision.files.length && !same(revision.files, target.files)) changes.push("files");
  return changes;
}

const REVISABLE = ["title", "description", "tags", "price_minor", "files", "mockups", "notes"] as const;

/**
 * A change to a live Etsy listing (an experiment variant, a better title, new images). It starts as a draft copy of
 * the live package with the changes applied, and goes through the same submit and approval as any package. Once
 * approved, ATLAS applies it to the same Etsy listing. It costs no listing fee. One open revision per listing.
 */
export function createRevision(
  db: DatabaseSync,
  targetId: string,
  input: Row,
  author: { agentId?: string | null; taskId?: string | null } = {},
  now = Date.now(),
): ListingPackage {
  ensureListingSchema(db);
  const target = getListing(db, targetId) ?? fail("listing_not_found");
  if (target.platform !== "etsy" || target.status !== "published" || !target.etsy_listing_id || target.revision_of)
    fail("listing_not_revisable");
  if (Object.keys(input).some((key) => !(REVISABLE as readonly string[]).includes(key)))
    fail("listing_protected_field");
  const open = db
    .prepare("SELECT id FROM listing_packages WHERE revision_of=? AND status IN ('draft','ready','approved') LIMIT 1")
    .get(target.id);
  if (open) fail("listing_revision_open");
  const values = contentValues({
    ...Object.fromEntries(REVISABLE.map((key) => [key, target[key]])),
    notes: "",
    ...input,
    platform: target.platform,
    currency: target.currency,
    project_id: target.project_id,
    opportunity_id: target.opportunity_id,
    taxonomy_id: target.taxonomy_id,
    who_made: target.who_made,
    when_made: target.when_made,
  });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO listing_packages (id,business,platform,project_id,opportunity_id,title,description,tags,price_minor,currency,
      files,mockups,notes,fee_minor,fee_currency,status,agent_id,task_id,created_at,updated_at,taxonomy_id,who_made,when_made,
      etsy_listing_id,revision_of,listing_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,'draft',?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    target.business,
    target.platform,
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
    target.fee_currency,
    author.agentId ?? null,
    author.taskId ?? null,
    now,
    now,
    values.taxonomy_id,
    values.who_made,
    values.when_made,
    target.etsy_listing_id,
    target.id,
    target.listing_url,
  );
  return getListing(db, id)!;
}

/** After a revision is live on Etsy, the live package holds what Etsy now shows. */
export function applyRevisionLocally(db: DatabaseSync, revisionId: string, now = Date.now()): ListingPackage {
  const revision = getListing(db, revisionId) ?? fail("listing_not_found");
  const target = getListing(db, revision.revision_of ?? "") ?? fail("listing_not_found");
  const changes = revisionChanges(revision, target);
  db.prepare(
    "UPDATE listing_packages SET title=?,description=?,tags=?,price_minor=?,mockups=?,files=?,updated_at=? WHERE id=?",
  ).run(
    revision.title,
    revision.description,
    JSON.stringify(revision.tags),
    revision.price_minor,
    JSON.stringify(changes.includes("images") ? revision.mockups : target.mockups),
    JSON.stringify(changes.includes("files") ? revision.files : target.files),
    now,
    target.id,
  );
  return getListing(db, target.id)!;
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
  if (listing.revision_of) {
    // A big price move on a live listing is the owner's call, not the VPs'.
    const target = getListing(db, listing.revision_of);
    if (!target) return "owner";
    const ratio = target.price_minor > 0 ? listing.price_minor / target.price_minor : Infinity;
    if (ratio < 1 - REVISION_PRICE_SWING || ratio > 1 + REVISION_PRICE_SWING) return "owner";
  }
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
        listing.revision_of ?? null,
        ...(listing.platform === "etsy" ? [listing.taxonomy_id, listing.who_made, listing.when_made] : []),
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
export function markListingPublished(
  db: DatabaseSync,
  id: string,
  url: unknown,
  now = Date.now(),
  opts: { recordFee?: boolean } = {},
): ListingPackage {
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
    // Published through the Etsy API, the fee arrives with Etsy's own payment records, so it is not recorded twice.
    if (current.fee_minor > 0 && hasLedger && opts.recordFee !== false) {
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
    // The opportunity is live now: its "no sales in N days" clock starts.
    if (current.opportunity_id) markOpportunityLaunched(db, current.opportunity_id, now);
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
