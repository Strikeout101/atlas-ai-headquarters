import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger } from "./autonomy-store.ts";
import { createWorkTask, pickStepAgent, SHOP_SETUP_STEP } from "./work-engine.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import { etsyRequest, type EtsyDeps } from "./etsy.ts";

/**
 * The Etsy shop itself, not just its listings.
 *
 * What Etsy's Open API v3 lets an app change (scope shops_w): the shop title (the headline under the name), the
 * announcement, the sale messages (including the one sent with digital orders), the additional policy text and
 * shop sections. What it does not: the logo, the banner, the About story, the shop name and FAQs. ATLAS can read
 * whether the logo and banner exist.
 *
 * So agents make the whole shop setup (logo and banner files, title, announcement, story, messages, sections) and
 * propose it as one shop change. It is customer-facing, so it is approved like a listing (the VPs for Ventures).
 * Once approved, ATLAS applies what the API allows; the logo, banner and story become an owner step (upload these
 * files, paste this text) that the owner ticks off.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const SHOP_LIMITS = {
  title: 55,
  announcement: 5000,
  sale_message: 2000,
  digital_sale_message: 2000,
  policy_additional: 5000,
  about: 5000,
  section_title: 24,
  sections: 20,
} as const;
const TEXT_FIELDS = ["title", "announcement", "sale_message", "digital_sale_message", "policy_additional"] as const;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const DAY_MS = 86_400_000;

function fail(message: string): never {
  throw new Error(message);
}

export function ensureEtsyShopSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS etsy_shop_changes (
    id TEXT PRIMARY KEY, business TEXT NOT NULL, project_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ready','approved','applied','rejected')),
    title TEXT, announcement TEXT, sale_message TEXT, digital_sale_message TEXT, policy_additional TEXT,
    sections TEXT NOT NULL DEFAULT '[]', logo_path TEXT, banner_path TEXT, about TEXT, notes TEXT NOT NULL DEFAULT '',
    agent_id TEXT, task_id TEXT, decided_by TEXT, decision_reason TEXT, decided_at INTEGER, applied_at INTEGER,
    error TEXT, owner_done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const have = new Set(
    (db.prepare("PRAGMA table_info(etsy_connection)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [column, type] of [
    ["shop_json", "TEXT"],
    ["shop_seen_at", "INTEGER"],
    ["granted_scopes", "TEXT"],
  ] as const)
    if (!have.has(column)) db.exec(`ALTER TABLE etsy_connection ADD COLUMN ${column} ${type}`);
}

function connection(db: Db): Row {
  ensureEtsyShopSchema(db);
  return (db.prepare("SELECT * FROM etsy_connection WHERE id=1").get() as Row | undefined) ?? {};
}

/** True once the owner has connected with the permission to change the shop (shops_w). */
export function canChangeShop(db: Db): boolean {
  return String(connection(db).granted_scopes ?? "")
    .split(/\s+/)
    .includes("shops_w");
}

/** Reads the shop and its sections into etsy_connection.shop_json. Called from every sync. */
export async function refreshShopProfile(db: Db, deps: EtsyDeps = {}) {
  const r = connection(db);
  if (!r.shop_id || !r.access_token_enc) return null;
  const shop = await etsyRequest(db, "GET", `/shops/${r.shop_id}`, {}, deps);
  const sections = await etsyRequest(db, "GET", `/shops/${r.shop_id}/sections`, {}, deps);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const profile = {
    shop_name: text(shop.shop_name),
    title: text(shop.title),
    announcement: text(shop.announcement),
    sale_message: text(shop.sale_message),
    digital_sale_message: text(shop.digital_sale_message),
    policy_additional: text(shop.policy_additional),
    has_logo: Boolean(shop.icon_url_fullxfull),
    has_banner: Boolean(shop.image_url_760x100),
    url: text(shop.url).split("?")[0],
    active_listings: Number(shop.listing_active_count ?? 0),
    digital_listings: Number(shop.digital_listing_count ?? 0),
    reviews: Number(shop.review_count ?? 0),
    favorers: Number(shop.num_favorers ?? 0),
    sales: Number(shop.transaction_sold_count ?? 0),
    sections: (Array.isArray(sections.results) ? (sections.results as Row[]) : []).map((section) => ({
      id: String(section.shop_section_id ?? ""),
      title: text(section.title),
      listings: Number(section.active_listing_count ?? 0),
    })),
  };
  db.prepare("UPDATE etsy_connection SET shop_json=?, shop_seen_at=? WHERE id=1").run(
    JSON.stringify(profile),
    deps.now?.() ?? Date.now(),
  );
  return profile;
}

export type ShopProfile = NonNullable<Awaited<ReturnType<typeof refreshShopProfile>>>;

/** The shop as last read, what is missing, and what the API can and cannot change. */
export function shopProfile(db: Db) {
  const r = connection(db);
  let profile: ShopProfile | null = null;
  try {
    profile = r.shop_json ? (JSON.parse(String(r.shop_json)) as ShopProfile) : null;
  } catch {
    profile = null;
  }
  const storyDone = Boolean(
    db
      .prepare(
        "SELECT 1 FROM etsy_shop_changes WHERE status='applied' AND about IS NOT NULL AND about<>'' AND owner_done_at IS NOT NULL LIMIT 1",
      )
      .get(),
  );
  const gaps: string[] = [];
  if (profile) {
    if (!profile.has_logo) gaps.push("logo (owner uploads the file agents make)");
    if (!profile.has_banner) gaps.push("banner (owner uploads the file agents make)");
    if (!profile.title) gaps.push("shop title (headline)");
    if (!profile.announcement) gaps.push("announcement");
    if (!profile.digital_sale_message) gaps.push("message sent with digital orders");
    if (!profile.sections.length) gaps.push("shop sections");
    if (!storyDone) gaps.push("About story (owner pastes the text agents write)");
  }
  return {
    profile,
    seen_at: (r.shop_seen_at as number | null) ?? null,
    gaps,
    can_change: canChangeShop(db),
    api_can_change: ["title", "announcement", "sale_message", "digital_sale_message", "policy_additional", "sections"],
    owner_must_do: ["logo", "banner", "About story", "shop name", "FAQs"],
  };
}

export function shopNeedsSetup(db: Db): boolean {
  const { profile, gaps } = shopProfile(db);
  return Boolean(profile) && gaps.length > 0;
}

function toChange(row: Row) {
  let sections: string[] = [];
  try {
    sections = JSON.parse(String(row.sections ?? "[]"));
  } catch {
    sections = [];
  }
  return { ...row, sections } as Row & { id: string; status: string; sections: string[]; business: BusinessKey };
}

export function getShopChange(db: Db, id: string) {
  ensureEtsyShopSchema(db);
  const row = db.prepare("SELECT * FROM etsy_shop_changes WHERE id=?").get(id) as Row | undefined;
  return row ? toChange(row) : null;
}

export function listShopChanges(db: Db, limit = 20) {
  ensureEtsyShopSchema(db);
  return (db.prepare("SELECT * FROM etsy_shop_changes ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(
    toChange,
  );
}

/**
 * `etsy.shop_propose`: an agent proposes the shop setup (or a later change). Text within Etsy's limits; logo and
 * banner are image files inside the project. One open change at a time.
 */
export function proposeShopChange(
  db: Db,
  input: Row,
  ctx: { projectId: string | null; projectPath: string | null; agentId: string | null; taskId: string | null },
  now = Date.now(),
) {
  ensureEtsyShopSchema(db);
  const business = String(connection(db).business ?? "ventures");
  if (db.prepare("SELECT 1 FROM etsy_shop_changes WHERE status IN ('ready','approved') LIMIT 1").get())
    fail("shop_change_open");
  const values: Record<string, string | null> = {};
  for (const field of [...TEXT_FIELDS, "about"] as const) {
    const value = input[field];
    if (value === undefined || value === null) {
      values[field] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > SHOP_LIMITS[field])
      fail(`invalid_${field}: at most ${SHOP_LIMITS[field]} characters`);
    values[field] = value.trim() || null;
  }
  const sections = input.sections === undefined ? [] : input.sections;
  if (!Array.isArray(sections) || sections.length > SHOP_LIMITS.sections) fail("invalid_sections");
  const sectionTitles = sections.map((title) => {
    if (typeof title !== "string" || !title.trim() || title.trim().length > SHOP_LIMITS.section_title)
      fail(`invalid_sections: each title 1-${SHOP_LIMITS.section_title} characters`);
    return title.trim();
  });
  const image = (field: "logo" | "banner") => {
    const value = input[field];
    if (value === undefined || value === null || value === "") return null;
    if (!ctx.projectPath) fail("shop_change_needs_project");
    if (typeof value !== "string") fail(`invalid_${field}`);
    const root = path.resolve(ctx.projectPath);
    const full = path.resolve(root, value.trim());
    if (!full.startsWith(root + path.sep)) fail(`invalid_${field}: the file must be inside the project`);
    if (!IMAGE_EXT.has(path.extname(full).toLowerCase())) fail(`invalid_${field}: PNG or JPG`);
    if (!fs.existsSync(full)) fail(`invalid_${field}: file not found`);
    return path.relative(root, full).split(path.sep).join("/");
  };
  const logo = image("logo");
  const banner = image("banner");
  if (!Object.values(values).some(Boolean) && !sectionTitles.length && !logo && !banner) fail("shop_change_empty");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO etsy_shop_changes (id,business,project_id,status,title,announcement,sale_message,digital_sale_message,policy_additional,
       sections,logo_path,banner_path,about,notes,agent_id,task_id,created_at,updated_at)
     VALUES (?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    business,
    ctx.projectId,
    values.title,
    values.announcement,
    values.sale_message,
    values.digital_sale_message,
    values.policy_additional,
    JSON.stringify(sectionTitles),
    logo,
    banner,
    values.about,
    typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "",
    ctx.agentId,
    ctx.taskId,
    now,
    now,
  );
  appendAutonomyLedger(
    db,
    {
      event: "shop_change_proposed",
      business: isBusinessKey(business) ? business : null,
      sourceId: id,
      taskId: ctx.taskId,
      message: "Etsy shop setup proposed for approval",
    },
    now,
  );
  return getShopChange(db, id)!;
}

/** Who may approve a shop change: the VPs when the business lets them approve customer-facing sends. */
export function shopChangeApprover(business: unknown): "owner" | "vp" {
  return isBusinessKey(business) && businessPolicy(business).customer_sends === "vp" ? "vp" : "owner";
}

export function decideShopChange(
  db: Db,
  id: string,
  approve: boolean,
  decidedBy = "owner",
  reason = "",
  now = Date.now(),
) {
  const change = getShopChange(db, id) ?? fail("shop_change_not_found");
  if (change.status !== "ready") fail("shop_change_already_decided");
  if (decidedBy !== "owner") {
    if (!decidedBy.startsWith("vp:")) fail("shop_change_decider_forbidden");
    if (shopChangeApprover(change.business) !== "vp") fail("owner_approval_required");
  }
  db.prepare(
    "UPDATE etsy_shop_changes SET status=?, decided_by=?, decision_reason=?, decided_at=?, updated_at=? WHERE id=? AND status='ready'",
  ).run(approve ? "approved" : "rejected", decidedBy, reason.trim().slice(0, 2000) || null, now, now, id);
  return getShopChange(db, id)!;
}

/**
 * Applies an approved change: the text fields through updateShop, then any sections not already in the shop. The
 * logo, banner and story are left for the owner (owner_done_at). Needs the shops_w permission.
 */
export async function applyShopChange(db: Db, id: string, deps: EtsyDeps = {}) {
  const change = getShopChange(db, id) ?? fail("shop_change_not_found");
  if (change.status !== "approved") fail("shop_change_not_approved");
  const now = deps.now?.() ?? Date.now();
  const r = connection(db);
  const form: Record<string, string> = {};
  for (const field of TEXT_FIELDS) if (change[field]) form[field] = String(change[field]);
  const needsApi = Object.keys(form).length > 0 || change.sections.length > 0;
  if (needsApi) {
    if (!r.shop_id) fail("etsy_not_connected");
    if (!canChangeShop(db)) {
      db.prepare("UPDATE etsy_shop_changes SET error=?, updated_at=? WHERE id=?").run(
        "Reconnect Etsy in Settings to allow shop changes (permission shops_w).",
        now,
        id,
      );
      return getShopChange(db, id)!;
    }
    try {
      if (Object.keys(form).length) await etsyRequest(db, "PUT", `/shops/${r.shop_id}`, { form }, deps);
      if (change.sections.length) {
        const existing = await etsyRequest(db, "GET", `/shops/${r.shop_id}/sections`, {}, deps);
        const titles = new Set(
          (Array.isArray(existing.results) ? (existing.results as Row[]) : []).map((s) =>
            String(s.title).toLowerCase(),
          ),
        );
        for (const title of change.sections)
          if (!titles.has(title.toLowerCase()))
            await etsyRequest(db, "POST", `/shops/${r.shop_id}/sections`, { form: { title } }, deps);
      }
    } catch (error) {
      db.prepare("UPDATE etsy_shop_changes SET error=?, updated_at=? WHERE id=?").run(
        (error instanceof Error ? error.message : "shop_change_failed").slice(0, 300),
        now,
        id,
      );
      throw error;
    }
  }
  db.prepare("UPDATE etsy_shop_changes SET status='applied', applied_at=?, error=NULL, updated_at=? WHERE id=?").run(
    now,
    now,
    id,
  );
  appendAutonomyLedger(
    db,
    {
      event: "shop_change_applied",
      business: isBusinessKey(change.business) ? change.business : null,
      sourceId: id,
      message: `Etsy shop updated${change.logo_path || change.banner_path || change.about ? "; logo, banner or story wait for the owner to upload" : ""}`,
    },
    now,
  );
  await refreshShopProfile(db, deps).catch(() => null);
  return getShopChange(db, id)!;
}

/** Owner: the logo, banner and story from an applied change are uploaded on Etsy. */
export function markShopChangeOwnerDone(db: Db, id: string, now = Date.now()) {
  const change = getShopChange(db, id) ?? fail("shop_change_not_found");
  if (change.status !== "applied") fail("shop_change_not_applied");
  db.prepare("UPDATE etsy_shop_changes SET owner_done_at=?, updated_at=? WHERE id=?").run(now, now, id);
  return getShopChange(db, id)!;
}

/** Applies approved shop changes; called from the Etsy tick. Failures stay on the change for the next tick. */
export async function applyApprovedShopChanges(db: Db, deps: EtsyDeps = {}) {
  ensureEtsyShopSchema(db);
  const ids = (db.prepare("SELECT id FROM etsy_shop_changes WHERE status='approved'").all() as Row[]).map((r) =>
    String(r.id),
  );
  for (const id of ids) await applyShopChange(db, id, deps).catch(() => null);
}

/**
 * A new or unfinished shop gets one setup task (design team) once the goal's strategy is approved, so the shop's look
 * and words match what it will sell. Listing steps wait for it. Not repeated while one is open or for 3 days.
 */
export function queueShopSetupIfNeeded(db: Db, goal: Row, strategySummary: string, now = Date.now()): string | null {
  ensureEtsyShopSchema(db);
  const r = connection(db);
  if (!r.shop_id || String(r.business) !== String(goal.business) || !shopNeedsSetup(db)) return null;
  if (db.prepare("SELECT 1 FROM etsy_shop_changes WHERE status IN ('ready','approved') LIMIT 1").get()) return null;
  const recent = db
    .prepare(
      "SELECT 1 FROM tasks WHERE business=? AND playbook_step=? AND (status NOT IN ('done','cancelled') OR created_at>?) LIMIT 1",
    )
    .get(String(goal.business), SHOP_SETUP_STEP, now - 3 * DAY_MS);
  if (recent) return null;
  const department = ["design", "planning"].find((d) => pickStepAgent(db, d, { importance: "important" }));
  if (!department) return null;
  const agent = pickStepAgent(db, department, { importance: "important" })!;
  const { profile, gaps } = shopProfile(db);
  const description = [
    `The Etsy shop "${profile?.shop_name ?? ""}" (${profile?.url ?? ""}) is not set up yet. Missing: ${gaps.join("; ")}.`,
    "Set it up so it matches the strategy below and looks like a shop buyers trust. You decide the brand: name style, colors, voice.",
    "Make, in your working folder (for example brand/):",
    "- a logo (square, at least 500x500 PNG) and a banner (3360x840 PNG works for Etsy's big banner). Use your own image generation or the canvas-design skill; original work only, no trademarks. Record each with media.register.",
    `- a shop title (headline, at most ${SHOP_LIMITS.title} characters), an announcement, an About story (who we are, what we make, why; honest, no invented people or claims), the message sent with digital orders (how to download and use the files, how to get help) and shop sections for the product families in the strategy (each at most ${SHOP_LIMITS.section_title} characters).`,
    "Then propose it all at once with etsy.shop_propose {title, announcement, about, digital_sale_message, sale_message?, policy_additional?, sections[], logo, banner}. It is approved like a listing; ATLAS applies the text and sections on Etsy, and the owner uploads the logo, banner and story (Etsy's API cannot).",
    "etsy.shop shows the shop as it is now. Do not change listings or publish anything in this task.",
    strategySummary ? `STRATEGY:\n${strategySummary.slice(0, 3000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const taskId = createWorkTask(
    db,
    {
      title: "Set up the Etsy shop: brand, banner, story and sections",
      description: `${description}\n\nWhy: a new shop with no logo, banner, story or sections converts poorly; buyers check the shop before buying.`,
      department_id: department,
      agent_id: String(agent.id),
      business: String(goal.business),
      goal_id: String(goal.id),
      project_id: (goal.project_id as string | null) ?? null,
      work_type: "shop_admin",
      importance: "important",
      playbook_step: SHOP_SETUP_STEP,
    },
    now,
  );
  appendAutonomyLedger(
    db,
    {
      event: "shop_setup_queued",
      business: isBusinessKey(goal.business) ? goal.business : null,
      sourceId: String(goal.id),
      message: `Shop setup queued (missing: ${gaps.join(", ")})`.slice(0, 300),
    },
    now,
  );
  return taskId;
}
