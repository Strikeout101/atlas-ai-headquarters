import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger, ensureAutonomySchema } from "./autonomy-store.ts";
import { type BusinessKey } from "./businesses.ts";
import { ensureExperimentSchema } from "./experiments.ts";
import {
  TASK_IMPORTANCE,
  WORK_TYPES,
  type TaskImportance,
  type WorkType,
} from "./bootstrap/schema/work-model-migration.ts";

/**
 * Playbooks: the steps one kind of initiative repeats, stored as data the owner can edit (nothing hard-coded except
 * the seeded default). The default `etsy_digital` playbook for Ventures digital products:
 *
 *   build     - make the product files (product work, important)
 *   mockups   - preview images with studio.mockup and generated images (design work)
 *   listing   - an Etsy listing package (listing work, important); waits for the shop setup
 *   publish   - stops for the owner to approve publishing; the listing's approval and publish flow takes over
 *
 * The work engine (work-engine.ts) runs the steps: one task per step, each given the strategy, the initiative brief
 * and every earlier step's hand-off. `research` is reference material for the goal's research phase.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const STEP_KINDS = ["task", "owner_approval"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export interface PlaybookStep {
  key: string;
  title: string;
  department_id: string;
  instructions: string;
  /** What kind of work the step's task is; decides its instructions, folder and reviewer. */
  work_type?: WorkType;
  importance?: TaskImportance;
  /** `owner_approval` creates no task: the initiative waits at this step for the owner. */
  kind?: StepKind;
  /** Wait until the business's shop setup is finished before this step starts. */
  wait_for?: "shop_setup";
}

export interface PlaybookCaps {
  /** Step tasks started per rolling 24 hours for one initiative. */
  task_cap_daily: number;
}

export interface Playbook {
  key: string;
  title: string;
  business: BusinessKey;
  research: PlaybookStep;
  steps: PlaybookStep[];
  caps: PlaybookCaps;
  updated_at: number;
}

export const DEFAULT_PLAYBOOK_CAPS: PlaybookCaps = { task_cap_daily: 3 };

export const DEFAULT_ETSY_PLAYBOOK: Omit<Playbook, "updated_at"> = {
  key: "etsy_digital",
  title: "Etsy digital products",
  business: "ventures",
  research: {
    key: "research",
    title: "Etsy niche research",
    department_id: "planning",
    instructions: [
      "Find digital-product niches the Ventures Etsy shop could win in (printables, planners, templates, spreadsheets, digital art or anything better the evidence shows).",
      "Choose your own approach. Search the web with your own web search or web.search / web.read: trend reports, best-seller roundups, what buyers ask for, seller communities. etsy.search gives live Etsy numbers per search: how many listings compete, their prices, favorites, views and common tags. Compare niches by demand against competition, and look for gaps (few strong listings, weak titles or images, missing variants).",
      "Etsy's own search pages refuse automated readers, its category pages do not. If a skill would help, skills.search finds one and skills.request asks for it (VP-reviewed).",
      "Avoid trademarks, licensed characters and anything the business profile rules out.",
      "Record each niche with initiative.propose: title, description (the evidence with its numbers, and the product you would make), the five scores 0-100 and a budget in USD (usually 0-10 for listing fees and images).",
      "Do not make products in this task.",
    ].join("\n"),
  },
  steps: [
    {
      key: "build",
      title: "Make the product: {title}",
      department_id: "design",
      work_type: "product",
      importance: "important",
      instructions: [
        "Initiative {initiative_id}: {title}",
        "{description}",
        "Make the finished digital product files in your working folder (for example products/{slug}/). PDF for printables, plus the source files.",
        "Original work only: no copied designs, fonts you may not redistribute or trademarked names.",
        "End with the list of files you made (relative paths).",
      ].join("\n"),
    },
    {
      key: "mockups",
      title: "Mockups for: {title}",
      department_id: "design",
      work_type: "design",
      importance: "routine",
      instructions: [
        "Initiative {initiative_id}: {title}",
        "Make 5 to 8 Etsy preview images from the product files with studio.mockup (templates cover, grid, printable, device; 2000x1600).",
        "You may add a few lifestyle or cover images with your own image generation (Codex can generate images): save each in your working folder and record it with media.register {path, prompt}. Mockups of the real pages come first; never show content the buyer does not get.",
        "End with the list of image paths (they are saved under atlas-media/).",
      ].join("\n"),
    },
    {
      key: "listing",
      title: "Etsy listing for: {title}",
      department_id: "planning",
      work_type: "listing",
      importance: "important",
      wait_for: "shop_setup",
      instructions: [
        "Initiative {initiative_id}: {title}",
        "Prepare an Etsy listing package with listings.create (business ventures, platform etsy, initiative_id {initiative_id}):",
        "- taxonomy_id from etsy.taxonomy, who_made i_did, when_made made_to_order",
        "- a clear, searchable title (max 140 characters) and a description that says exactly what the buyer downloads",
        "- 13 tags of at most 20 characters each (check what similar listings use with etsy.search), a price based on the research, files = the product files, mockups = the preview images",
        "Then listings.submit. Do not publish anything yourself.",
      ].join("\n"),
    },
    {
      key: "publish",
      title: "Owner approves publishing: {title}",
      department_id: "planning",
      kind: "owner_approval",
      instructions: "The listing package waits for the owner to approve publishing it on Etsy.",
    },
  ],
  caps: DEFAULT_PLAYBOOK_CAPS,
};

export function ensurePlaybookSchema(db: Db): void {
  ensureAutonomySchema(db);
  ensureExperimentSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS playbooks (
    key TEXT PRIMARY KEY, title TEXT NOT NULL, business TEXT NOT NULL, definition TEXT NOT NULL, updated_at INTEGER NOT NULL
  );`);
  const schedules = new Set(
    (db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!schedules.has("playbook")) db.exec("ALTER TABLE schedules ADD COLUMN playbook TEXT");
  const { key, title, business, research, steps, caps } = DEFAULT_ETSY_PLAYBOOK;
  const definition = JSON.stringify({ research, steps, caps });
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
  const definition = JSON.parse(String(row.definition)) as {
    research: PlaybookStep;
    steps: PlaybookStep[];
    caps?: Partial<PlaybookCaps>;
  };
  return {
    key: String(row.key),
    title: String(row.title),
    business: row.business as BusinessKey,
    research: definition.research,
    steps: definition.steps,
    caps: { ...DEFAULT_PLAYBOOK_CAPS, ...(definition.caps ?? {}) },
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
  const out: PlaybookStep = {
    key,
    title: text("title", 200),
    department_id: text("department_id", 100),
    instructions: text("instructions", 6000),
  };
  if (step.work_type !== undefined) {
    if (!(WORK_TYPES as readonly unknown[]).includes(step.work_type)) fail(`invalid_${field}_work_type`);
    out.work_type = step.work_type as WorkType;
  }
  if (step.importance !== undefined) {
    if (!(TASK_IMPORTANCE as readonly unknown[]).includes(step.importance)) fail(`invalid_${field}_importance`);
    out.importance = step.importance as TaskImportance;
  }
  if (step.kind !== undefined) {
    if (!(STEP_KINDS as readonly unknown[]).includes(step.kind)) fail(`invalid_${field}_kind`);
    out.kind = step.kind as StepKind;
  }
  if (step.wait_for !== undefined && step.wait_for !== null) {
    if (step.wait_for !== "shop_setup") fail(`invalid_${field}_wait_for`);
    out.wait_for = "shop_setup";
  }
  return out;
}

function cleanCaps(value: unknown, current: PlaybookCaps): PlaybookCaps {
  if (value === undefined) return current;
  const caps = (value && typeof value === "object" ? value : {}) as Row;
  const daily = caps.task_cap_daily ?? current.task_cap_daily;
  if (typeof daily !== "number" || !Number.isSafeInteger(daily) || daily < 1 || daily > 50)
    fail("invalid_caps_task_cap_daily");
  return { task_cap_daily: daily };
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
  if (steps.every((step) => step.kind === "owner_approval")) fail("invalid_steps");
  const caps = cleanCaps(input.caps, current.caps);
  if (new Set(steps.map((s) => s.key)).size !== steps.length) fail("duplicate_step_key");
  for (const step of [research, ...steps])
    if (!db.prepare("SELECT 1 FROM departments WHERE id=?").get(step.department_id))
      fail(`department_not_found: ${step.department_id}`);
  db.prepare("UPDATE playbooks SET title=?, definition=?, updated_at=? WHERE key=?").run(
    title,
    JSON.stringify({ research, steps, caps }),
    now,
    key,
  );
  return getPlaybook(db, key)!;
}

export function resetPlaybook(db: Db, key: string, now = Date.now()): Playbook {
  if (key !== DEFAULT_ETSY_PLAYBOOK.key) fail("playbook_has_no_default");
  ensurePlaybookSchema(db);
  const { research, steps, caps } = DEFAULT_ETSY_PLAYBOOK;
  db.prepare("UPDATE playbooks SET definition=?, updated_at=? WHERE key=?").run(
    JSON.stringify({ research, steps, caps }),
    now,
    key,
  );
  return getPlaybook(db, key)!;
}

/** Fills a step's {title}, {description}, {initiative_id} and {slug} from its initiative. */
export function fillStepText(template: string, initiative: Row): string {
  const slug = String(initiative.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return template
    .replace(/\{title\}/g, String(initiative.title ?? ""))
    .replace(/\{description\}/g, String(initiative.description ?? "").slice(0, 4000))
    .replace(/\{initiative_id\}/g, String(initiative.id))
    .replace(/\{slug\}/g, slug || "product");
}

/** The playbook a business's initiatives follow by default (Ventures: Etsy digital products). */
export function playbookForBusiness(db: Db, business: unknown): Playbook | null {
  return listPlaybooks(db).find((playbook) => playbook.business === business) ?? null;
}

/** Most ideas one task may propose: the research synthesis gives 6 to 10. */
export const MAX_PROPOSALS_PER_TASK = 10;

/** A research agent records a niche it found. Ideas only; the VP planner scores and picks them. */
export function proposeInitiative(
  db: Db,
  input: Row,
  ctx: {
    business: BusinessKey | null;
    projectId?: string | null;
    taskId: string;
    playbook?: string | null;
    /** Set when a goal's strategy task proposes the idea. */
    goalId?: string | null;
  },
  now = Date.now(),
): Row {
  ensurePlaybookSchema(db);
  if (!ctx.business) fail("initiative_needs_business");
  // Every initiative belongs to a goal (work restructure). Ideas from research outside a strategy task
  // attach to the business's current goal; with no goal there is nothing to work toward.
  const goalId =
    ctx.goalId ??
    (
      db
        .prepare(
          "SELECT id FROM business_goals WHERE business=? AND period_end>? ORDER BY period_end ASC, created_at DESC LIMIT 1",
        )
        .get(ctx.business, now) as { id: string } | undefined
    )?.id ??
    null;
  if (!goalId) fail("initiative_needs_goal");
  const already = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM initiatives WHERE source_task_id=?").get(ctx.taskId) as { n: number }).n,
  );
  if (already >= MAX_PROPOSALS_PER_TASK) fail("initiative_task_limit_reached");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 4 || title.length > 200) fail("invalid_title");
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 12000) : "";
  if (db.prepare("SELECT 1 FROM initiatives WHERE goal_id=? AND lower(title)=lower(?)").get(goalId, title))
    fail("initiative_duplicate");
  const score = (key: string) => {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  };
  const budget =
    typeof input.budget === "number" && Number.isFinite(input.budget) ? Math.max(0, Math.min(1000, input.budget)) : 0;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO initiatives(id,business,project_id,goal_id,title,description,demand_score,revenue_score,cost_score,difficulty_score,
       time_to_launch_score,budget,status,playbook,source_task_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?)`,
  ).run(
    id,
    ctx.business,
    ctx.projectId ?? null,
    goalId,
    title,
    description,
    score("demand_score"),
    score("revenue_score"),
    score("cost_score"),
    score("difficulty_score"),
    score("time_to_launch_score"),
    budget,
    ctx.playbook ?? playbookForBusiness(db, ctx.business)?.key ?? null,
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
  return db.prepare("SELECT * FROM initiatives WHERE id=?").get(id) as Row;
}
