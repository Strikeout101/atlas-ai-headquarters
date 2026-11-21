import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger, ensureAutonomySchema } from "./autonomy-store.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { ensureExperimentSchema } from "./experiments.ts";

/**
 * Playbooks: the steps one income stream repeats, stored as data the owner can edit (nothing hard-coded except the
 * seeded default). The default `etsy_digital` playbook for Ventures digital products:
 *
 *   research  - a schedule: find niches with demand evidence, record each with opportunity.propose
 *   build     - make the product files in the project folder
 *   mockups   - preview images with studio.mockup (and studio.generate when the owner enabled it)
 *   listing   - an Etsy listing package (category, title, 13 tags, price), submitted for VP review
 *
 * After the listing step the package follows the existing approvals; when Etsy is connected the approved package is
 * pushed as a draft and published by the owner or by auto-publish. Optimizing (variants, stopping) is the planner's.
 *
 * The engine queues each step as ordinary autonomy work, so every gate still applies: VP approval of the work, the
 * daily start cap, usage headroom, the opportunity's budget and the emergency controls.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export interface PlaybookStep {
  key: string;
  title: string;
  department_id: string;
  instructions: string;
}

export interface Playbook {
  key: string;
  title: string;
  business: BusinessKey;
  research: PlaybookStep;
  steps: PlaybookStep[];
  updated_at: number;
}

export const DEFAULT_ETSY_PLAYBOOK: Omit<Playbook, "updated_at"> = {
  key: "etsy_digital",
  title: "Etsy digital products",
  business: "ventures",
  research: {
    key: "research",
    title: "Etsy niche research",
    department_id: "planning",
    instructions: [
      "Find 3 to 5 digital-product niches the Ventures Etsy shop could win in (printables, planners, templates, spreadsheets, digital art or anything better the evidence shows).",
      "Choose your own approach. etsy.search gives live numbers per search: how many listings compete, their prices, favorites, views and common tags. Compare niches by demand against competition, and look for gaps (few strong listings, weak titles or images, missing variants).",
      "web.search and web.read help with trends and buyer language; Etsy's search pages refuse automated readers, its category pages do not.",
      "Avoid trademarks, licensed characters and anything the business profile rules out.",
      "Record each niche with opportunity.propose: title, description (the evidence with its numbers, and the product you would make), the five scores 0-100 and a budget in USD (usually 0-10 for listing fees and images).",
      "Do not make products in this task.",
    ].join("\n"),
  },
  steps: [
    {
      key: "build",
      title: "Make the product: {title}",
      department_id: "design",
      instructions: [
        "Opportunity {opportunity_id}: {title}",
        "{description}",
        "Make the finished digital product files inside the project folder (for example products/{slug}/). PDF for printables, plus the source files.",
        "Original work only: no copied designs, fonts you may not redistribute or trademarked names.",
        "End with the list of files you made (relative paths).",
      ].join("\n"),
    },
    {
      key: "mockups",
      title: "Mockups for: {title}",
      department_id: "design",
      instructions: [
        "Opportunity {opportunity_id}: {title}",
        "Make 5 to 8 Etsy preview images from the product files with studio.mockup (templates cover, grid, printable, device; 2000x1600).",
        "If studio.generate is available and within its monthly cap you may add lifestyle images; otherwise do not.",
        "End with the list of image paths (they are saved under atlas-media/).",
      ].join("\n"),
    },
    {
      key: "listing",
      title: "Etsy listing for: {title}",
      department_id: "planning",
      instructions: [
        "Opportunity {opportunity_id}: {title}",
        "Prepare an Etsy listing package with listings.create (business ventures, platform etsy, opportunity_id {opportunity_id}):",
        "- taxonomy_id from etsy.taxonomy, who_made i_did, when_made made_to_order",
        "- a clear, searchable title (max 140 characters) and a description that says exactly what the buyer downloads",
        "- 13 tags of at most 20 characters each (check what similar listings use with etsy.search), a price based on the research, files = the product files, mockups = the preview images",
        "Then listings.submit. Do not publish anything yourself.",
      ].join("\n"),
    },
  ],
};

export function ensurePlaybookSchema(db: Db): void {
  ensureAutonomySchema(db);
  ensureExperimentSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS playbooks (
    key TEXT PRIMARY KEY, title TEXT NOT NULL, business TEXT NOT NULL, definition TEXT NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const work = new Set(
    (db.prepare("PRAGMA table_info(autonomy_work)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!work.has("playbook_step")) db.exec("ALTER TABLE autonomy_work ADD COLUMN playbook_step TEXT");
  const schedules = new Set(
    (db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!schedules.has("playbook")) db.exec("ALTER TABLE schedules ADD COLUMN playbook TEXT");
  const { key, title, business, research, steps } = DEFAULT_ETSY_PLAYBOOK;
  const definition = JSON.stringify({ research, steps });
  const seeded = db.prepare("SELECT definition, updated_at FROM playbooks WHERE key=?").get(key) as Row | undefined;
  if (!seeded)
    db.prepare("INSERT INTO playbooks(key,title,business,definition,updated_at) VALUES (?,?,?,?,?)").run(
      key,
      title,
      business,
      definition,
      0,
    );
  // A default the owner never edited (updated_at 0) follows improvements to the default; an edited one is theirs.
  else if (Number(seeded.updated_at) === 0 && seeded.definition !== definition)
    db.prepare("UPDATE playbooks SET title=?, definition=? WHERE key=? AND updated_at=0").run(title, definition, key);
}

function fail(message: string): never {
  throw new Error(message);
}

function toPlaybook(row: Row): Playbook {
  const definition = JSON.parse(String(row.definition)) as { research: PlaybookStep; steps: PlaybookStep[] };
  return {
    key: String(row.key),
    title: String(row.title),
    business: row.business as BusinessKey,
    research: definition.research,
    steps: definition.steps,
    updated_at: Number(row.updated_at),
  };
}

export function listPlaybooks(db: Db): Playbook[] {
  ensurePlaybookSchema(db);
  return (db.prepare("SELECT * FROM playbooks ORDER BY key").all() as Row[]).map(toPlaybook);
}

export function getPlaybook(db: Db, key: string): Playbook | null {
  ensurePlaybookSchema(db);
  const row = db.prepare("SELECT * FROM playbooks WHERE key=?").get(key) as Row | undefined;
  return row ? toPlaybook(row) : null;
}

function cleanStep(value: unknown, field: string): PlaybookStep {
  const step = (value && typeof value === "object" ? value : {}) as Row;
  const text = (key: string, max: number) => {
    const v = step[key];
    if (typeof v !== "string" || !v.trim() || v.length > max) fail(`invalid_${field}_${key}`);
    return (v as string).trim();
  };
  const key = text("key", 40);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) fail(`invalid_${field}_key`);
  return {
    key,
    title: text("title", 200),
    department_id: text("department_id", 100),
    instructions: text("instructions", 6000),
  };
}

/** Owner edit. Steps keep their keys unique; every department must exist. */
export function savePlaybook(db: Db, key: string, input: Row, now = Date.now()): Playbook {
  const current = getPlaybook(db, key) ?? fail("playbook_not_found");
  const title =
    input.title === undefined
      ? current.title
      : typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 120)
        : fail("invalid_title");
  const research = input.research === undefined ? current.research : cleanStep(input.research, "research");
  const steps =
    input.steps === undefined
      ? current.steps
      : Array.isArray(input.steps)
        ? input.steps.map((s, i) => cleanStep(s, `step${i + 1}`))
        : fail("invalid_steps");
  if (!steps.length || steps.length > 12) fail("invalid_steps");
  if (new Set(steps.map((s) => s.key)).size !== steps.length) fail("duplicate_step_key");
  for (const step of [research, ...steps])
    if (!db.prepare("SELECT 1 FROM departments WHERE id=?").get(step.department_id))
      fail(`department_not_found: ${step.department_id}`);
  db.prepare("UPDATE playbooks SET title=?, definition=?, updated_at=? WHERE key=?").run(
    title,
    JSON.stringify({ research, steps }),
    now,
    key,
  );
  return getPlaybook(db, key)!;
}

export function resetPlaybook(db: Db, key: string, now = Date.now()): Playbook {
  if (key !== DEFAULT_ETSY_PLAYBOOK.key) fail("playbook_has_no_default");
  ensurePlaybookSchema(db);
  const { research, steps } = DEFAULT_ETSY_PLAYBOOK;
  db.prepare("UPDATE playbooks SET definition=?, updated_at=? WHERE key=?").run(
    JSON.stringify({ research, steps }),
    now,
    key,
  );
  return getPlaybook(db, key)!;
}

function fill(template: string, opportunity: Row): string {
  const slug = String(opportunity.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return template
    .replace(/\{title\}/g, String(opportunity.title ?? ""))
    .replace(/\{description\}/g, String(opportunity.description ?? "").slice(0, 4000))
    .replace(/\{opportunity_id\}/g, String(opportunity.id))
    .replace(/\{slug\}/g, slug || "product");
}

type Queue = (
  db: Db,
  input: {
    business: string;
    project_id: string;
    department_id: string;
    title: string;
    description: string;
    reason: string;
    opportunity_id?: string | null;
    playbook_step?: string | null;
  },
  now?: number,
) => string;

function queueStep(
  db: Db,
  queue: Queue,
  playbook: Playbook,
  opportunity: Row,
  step: PlaybookStep,
  now: number,
): string {
  const id = queue(
    db,
    {
      business: String(opportunity.business),
      project_id: String(opportunity.project_id),
      department_id: step.department_id,
      title: fill(step.title, opportunity).slice(0, 200),
      description: fill(step.instructions, opportunity),
      reason: `Playbook "${playbook.title}", step ${step.key}`,
      opportunity_id: String(opportunity.id),
      playbook_step: step.key,
    },
    now,
  );
  db.prepare("UPDATE opportunities SET playbook=?, playbook_stage=?, updated_at=? WHERE id=?").run(
    playbook.key,
    step.key,
    now,
    String(opportunity.id),
  );
  return id;
}

/** Starts an opportunity's playbook at its first step. Used by the planner for opportunities that have a playbook. */
export function startPlaybook(db: Db, opportunityId: string, queue: Queue, now = Date.now()): string {
  ensurePlaybookSchema(db);
  const opportunity =
    (db.prepare("SELECT * FROM opportunities WHERE id=?").get(opportunityId) as Row | undefined) ??
    fail("opportunity_not_found");
  const playbook = getPlaybook(db, String(opportunity.playbook ?? "")) ?? fail("playbook_not_found");
  if (opportunity.playbook_stage) fail("playbook_already_started");
  return queueStep(db, queue, playbook, opportunity, playbook.steps[0], now);
}

/**
 * Called when a piece of autonomy work finishes. If it was a playbook step, the next step is queued (through every
 * gate); after the last step the opportunity waits for its listing's approval.
 */
export function advancePlaybook(db: Db, work: Row, queue: Queue, now = Date.now()): string | null {
  if (!work.opportunity_id || !work.playbook_step) return null;
  ensurePlaybookSchema(db);
  const opportunity = db.prepare("SELECT * FROM opportunities WHERE id=?").get(String(work.opportunity_id)) as
    | Row
    | undefined;
  if (!opportunity || opportunity.status === "stopped") return null;
  const playbook = getPlaybook(db, String(opportunity.playbook ?? ""));
  if (!playbook) return null;
  const index = playbook.steps.findIndex((step) => step.key === work.playbook_step);
  const next = index >= 0 ? playbook.steps[index + 1] : undefined;
  const business = isBusinessKey(opportunity.business) ? opportunity.business : null;
  if (!next) {
    db.prepare("UPDATE opportunities SET playbook_stage='awaiting_listing', updated_at=? WHERE id=?").run(
      now,
      String(opportunity.id),
    );
    appendAutonomyLedger(
      db,
      {
        event: "playbook",
        business,
        sourceId: String(opportunity.id),
        message: `Playbook steps done for "${String(opportunity.title).slice(0, 100)}"; the listing follows its approvals`,
      },
      now,
    );
    return null;
  }
  try {
    return queueStep(db, queue, playbook, opportunity, next, now);
  } catch (error) {
    db.prepare("UPDATE opportunities SET playbook_stage=?, updated_at=? WHERE id=?").run(
      `blocked:${next.key}`,
      now,
      String(opportunity.id),
    );
    appendAutonomyLedger(
      db,
      {
        event: "skipped",
        business,
        sourceId: String(opportunity.id),
        message: `Playbook step ${next.key} not queued: ${error instanceof Error ? error.message : "error"}`,
      },
      now,
    );
    return null;
  }
}

/** A research agent records a niche it found. Ideas only; the VP planner scores and picks them. */
export function proposeOpportunity(
  db: Db,
  input: Row,
  ctx: {
    business: BusinessKey | null;
    projectId: string | null;
    taskId: string;
    playbook?: string | null;
    /** Set when a goal's strategy task proposes the idea. */
    goalId?: string | null;
  },
  now = Date.now(),
): Row {
  ensurePlaybookSchema(db);
  if (!ctx.business || !ctx.projectId) fail("opportunity_needs_business_project");
  const already = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE source_task_id=?").get(ctx.taskId) as { n: number }).n,
  );
  if (already >= 5) fail("opportunity_task_limit_reached");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 4 || title.length > 200) fail("invalid_title");
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 12000) : "";
  if (
    db
      .prepare("SELECT 1 FROM opportunities WHERE business=? AND project_id=? AND lower(title)=lower(?)")
      .get(ctx.business, ctx.projectId, title)
  )
    fail("opportunity_duplicate");
  const score = (key: string) => {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  };
  const budget =
    typeof input.budget === "number" && Number.isFinite(input.budget) ? Math.max(0, Math.min(1000, input.budget)) : 0;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO opportunities(id,business,project_id,goal_id,title,description,demand_score,revenue_score,cost_score,difficulty_score,
       time_to_launch_score,budget,status,playbook,source_task_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'idea',?,?,?,?)`,
  ).run(
    id,
    ctx.business,
    ctx.projectId,
    ctx.goalId ?? null,
    title,
    description,
    score("demand_score"),
    score("revenue_score"),
    score("cost_score"),
    score("difficulty_score"),
    score("time_to_launch_score"),
    budget,
    ctx.playbook ?? null,
    ctx.taskId,
    now,
    now,
  );
  appendAutonomyLedger(
    db,
    {
      event: "proposed",
      business: ctx.business,
      sourceId: id,
      taskId: ctx.taskId,
      message: `Research proposed: ${title.slice(0, 150)}`,
    },
    now,
  );
  return db.prepare("SELECT * FROM opportunities WHERE id=?").get(id) as Row;
}
