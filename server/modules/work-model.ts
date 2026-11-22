import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureWorkModelSchema,
  WORK_TYPES,
  type TaskImportance,
  type WorkType,
} from "./bootstrap/schema/work-model-migration.ts";

/**
 * Task-level helpers for the work restructure (docs/work-restructure-plan.md, sections 3 and phase 2):
 * which kind of work a task is, where it runs, what instructions it gets and the hand-off it leaves behind.
 */

type Db = Pick<DatabaseSync, "prepare" | "exec">;
type Row = Record<string, unknown>;

export { WORK_TYPES, type WorkType, type TaskImportance };

// Checked in order: the first match wins, so the more specific kinds come first.
const WORK_TYPE_RULES: Array<[WorkType, RegExp]> = [
  ["listing", /\b(listing|listings|etsy tags?|seo title|item description|itch\.io page)\b/i],
  [
    "shop_admin",
    /\b(shop (setup|profile|policies|announcement|sections?|banner|icon|about)|shop owner|storefront setup)\b/i,
  ],
  [
    "outreach",
    /\b(e-?mail|newsletter|outreach|social (post|media)|instagram|facebook|tiktok|pinterest pin|reply to)\b/i,
  ],
  [
    "code",
    /\b(code|coding|bug|refactor|typescript|javascript|python|api endpoint|repo|repository|pull request|deploy|website|web app|script|unit tests?|build fails?|compile)\b/i,
  ],
  [
    "design",
    /\b(mock-?ups?|logo|banner|thumbnail|images?|visuals?|graphic|illustration|brand(ing)?|colou?r palette)\b/i,
  ],
  ["ops", /\b(homelab|ssh|server|backup|uptime|dns|vpn|account access|credentials?|security check|monitoring)\b/i],
  [
    "product",
    /\b(printables?|templates?|planner|workbook|bundle|worksheet|tracker|spreadsheet|digital (file|download|product)|pdf|game assets?|build the product)\b/i,
  ],
  [
    "research",
    /\b(research|strategy|market|trends?|competitors?|niche|analy[sz]e|analysis|audit|investigate|compare)\b/i,
  ],
];

const DEPARTMENT_DEFAULTS: Record<string, WorkType> = {
  development: "code",
  design: "design",
  planning: "research",
  "qa/qc": "research",
  qa: "research",
  devsecops: "ops",
  operations: "ops",
};

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === "string" && (WORK_TYPES as readonly string[]).includes(value);
}

/** A best guess from the task text, then the department. Playbook steps and the planner set it explicitly. */
export function inferWorkType(input: {
  title: string;
  description?: string | null;
  departmentName?: string | null;
}): WorkType {
  // "Research X", "Analyze X", "Strategy: X" are research whatever X is about.
  if (/^\s*(research|analy[sz]e|investigate|compare|audit|study|find out|strategy)/i.test(input.title))
    return "research";
  // The title says what the task is; the description may mention many other things.
  for (const text of [input.title, `${input.title}\n${(input.description ?? "").slice(0, 2000)}`]) {
    for (const [type, pattern] of WORK_TYPE_RULES) if (pattern.test(text)) return type;
  }
  const dept = String(input.departmentName ?? "")
    .trim()
    .toLowerCase();
  return DEPARTMENT_DEFAULTS[dept] ?? "research";
}

/** Important work is done by the lead; routine work goes to the senior (plan section 5). */
export function defaultImportance(type: WorkType, title: string): TaskImportance {
  if (type === "research") return /\bstrategy\b/i.test(title) ? "important" : "routine";
  if (type === "design" || type === "ops") return "routine";
  return "important";
}

/**
 * Fills a task's work type, business, goal, initiative and importance when they are missing, from what the task
 * already links to. Never overwrites a value that is set. Returns the task row as it is afterwards.
 */
export function ensureTaskWorkModel(db: Db, taskId: string): Row | null {
  ensureWorkModelSchema(db);
  const task = db
    .prepare(
      `SELECT t.*, d.name AS department_name, p.business AS project_business
       FROM tasks t LEFT JOIN departments d ON d.id = t.department_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    )
    .get(taskId) as Row | undefined;
  if (!task) return null;
  const updates: Record<string, unknown> = {};
  let initiativeId = (task.initiative_id as string | null) ?? null;
  let goalId = (task.goal_id as string | null) ?? null;
  if (!initiativeId || !goalId) {
    // A delegated child inherits its initiative and goal from its parent.
    const parent = task.source_task_id
      ? (db
          .prepare("SELECT initiative_id, goal_id, business FROM tasks WHERE id = ?")
          .get(String(task.source_task_id)) as Row | undefined)
      : undefined;
    initiativeId ??= (parent?.initiative_id as string | null) ?? null;
    goalId ??= (parent?.goal_id as string | null) ?? null;
    if (initiativeId && !goalId) {
      goalId =
        ((db.prepare("SELECT goal_id FROM initiatives WHERE id = ?").get(initiativeId) as Row | undefined)?.goal_id as
          | string
          | null) ?? null;
    }
    if (initiativeId && !task.initiative_id) updates.initiative_id = initiativeId;
    if (goalId && !task.goal_id) updates.goal_id = goalId;
  }
  if (!task.business) {
    const fromGoal = goalId
      ? ((db.prepare("SELECT business FROM business_goals WHERE id = ?").get(goalId) as Row | undefined)?.business as
          | string
          | undefined)
      : undefined;
    const business = fromGoal ?? (task.project_business as string | null) ?? null;
    if (business) updates.business = business;
  }
  let workType = isWorkType(task.work_type) ? task.work_type : null;
  if (!workType) {
    workType = inferWorkType({
      title: String(task.title ?? ""),
      description: task.description as string | null,
      departmentName: task.department_name as string | null,
    });
    updates.work_type = workType;
    // Importance has a column default; only refine it when the type was just decided.
    updates.importance = defaultImportance(workType, String(task.title ?? ""));
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...(keys.map((k) => updates[k]) as Array<string | number | null>),
      taskId,
    );
  }
  return { ...task, ...updates };
}

function tableHas(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "work"
  );
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where non-code work is kept when its project has no folder. */
export function workRoot(): string {
  // ATLAS_WORK_DIR may be relative (the test runtime uses one); it resolves against where ATLAS runs.
  const configured = process.env.ATLAS_WORK_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), "ATLAS-Work");
}

/**
 * A plain folder (no git) for a non-code task: inside its project's folder when it has one, otherwise under the
 * work root. Initiative work shares one folder per initiative so later steps find earlier files; goal research
 * gets a folder per goal; Operations work shares one folder per business.
 */
export function resolveWorkFolder(db: Db, task: Row, projectPath: string | null, atlasDir = process.cwd()): string {
  const usable =
    projectPath && path.isAbsolute(projectPath) && fs.existsSync(projectPath) && !isInside(projectPath, atlasDir);
  // A task with no project of its own resolves to the ATLAS folder; its files must never land in ATLAS's repo.
  const base = usable ? projectPath : path.join(workRoot(), String(task.business ?? "general"));
  let folder: string;
  if (task.initiative_id) {
    const initiative = db.prepare("SELECT title FROM initiatives WHERE id = ?").get(String(task.initiative_id)) as
      | Row
      | undefined;
    folder = path.join(
      base,
      "initiatives",
      `${slug(String(initiative?.title ?? "initiative"))}-${String(task.initiative_id).slice(0, 8)}`,
    );
  } else if (task.goal_id) {
    folder = path.join(base, "goals", String(task.goal_id).slice(0, 8));
  } else {
    folder = path.join(base, "operations");
  }
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

const SHARED_LINES = [
  "Write like a friendly coworker: plain and short. Customer-facing text follows the business's brand voice.",
  "Before you finish, call task.handoff (see the task tools line) with a plain summary, the files you made and the key numbers. The next step and your reviewer read it; nobody reads your log.",
];

const WORK_TYPE_INSTRUCTIONS: Record<WorkType, string[]> = {
  research: [
    "Research work. Search widely (web.search, web.read, etsy.search) and read the sources, not just the snippets.",
    "Keep measured facts apart from estimates, date them, and link the source for each claim.",
    "End with a clear recommendation backed by the evidence. No code, no git.",
  ],
  product: [
    "Product work: make the real files a buyer receives, ready to sell, in this folder.",
    "Check them like a buyer would: open each file, check sizes, margins and that every page or sheet works.",
    "List every file in your hand-off. No git.",
  ],
  design: [
    "Design work: make the images or visual assets asked for, in this folder (studio.mockup, or your own image tool, then media.register).",
    "Match the product and the brand. Note sizes and where each image is used. No git.",
  ],
  listing: [
    "Listing work: write the listing (title, description, tags, price) with listings.create or listings.revise.",
    "Use real search terms buyers type; Etsy tags are at most 20 characters. Publishing waits for approval. No git.",
  ],
  shop_admin: [
    "Shop work: propose shop changes with etsy.shop_propose (profile, policies, sections, images). They are applied after approval. No git.",
  ],
  outreach: ["Outreach work: draft the messages or posts. Nothing is sent or posted without approval. No git."],
  code: [
    "Code work in an isolated Git worktree. Run the relevant tests. Do not commit; the system merges after review.",
    "Do not run git merge, rebase, cherry-pick or push.",
    "Fix CRITICAL and HIGH issues you find; report MEDIUM and LOW ones without changing them unless asked.",
  ],
  ops: [
    "Operations work: check and fix systems through the approved tools (SSH commands outside the read-only list need approval).",
    "Record what you checked and what you changed. No git unless the task is about a repository.",
  ],
};

export function workTypeInstructions(type: WorkType, workFolder: string): string {
  const where =
    type === "code"
      ? `Working folder (isolated worktree): ${workFolder}`
      : `Working folder (plain, no git): ${workFolder}`;
  return [
    `[Work type: ${type}]`,
    ...[where, ...WORK_TYPE_INSTRUCTIONS[type], ...SHARED_LINES].map((line) => `- ${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-offs

export type Handoff = {
  task_id: string;
  summary: string;
  files: Array<{ path: string; note: string }>;
  numbers: Record<string, string | number>;
  open_issues: string;
  next_step_notes: string;
  generated: boolean;
  created_at: number;
  updated_at: number;
};

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, max)
    : "";
}

/** `task.handoff` from the agent. Replaces an earlier hand-off from the same task (the last one counts). */
export function saveHandoff(db: Db, taskId: string, input: Row, now = Date.now(), generated = false): Handoff {
  ensureWorkModelSchema(db);
  const summary = cleanText(input.summary, 1200);
  if (summary.length < 20) throw new Error("handoff_summary_too_short");
  const files = (Array.isArray(input.files) ? input.files : [])
    .slice(0, 50)
    .map((file) =>
      typeof file === "string"
        ? { path: cleanText(file, 500), note: "" }
        : { path: cleanText((file as Row)?.path, 500), note: cleanText((file as Row)?.note, 200) },
    )
    .filter((file) => file.path);
  const numbers: Record<string, string | number> = {};
  if (input.numbers && typeof input.numbers === "object" && !Array.isArray(input.numbers)) {
    for (const [key, value] of Object.entries(input.numbers as Row).slice(0, 30)) {
      const k = cleanText(key, 80);
      if (!k) continue;
      if (typeof value === "number" && Number.isFinite(value)) numbers[k] = value;
      else if (typeof value === "string" && value.trim()) numbers[k] = cleanText(value, 200);
    }
  }
  const openIssues = cleanText(input.open_issues, 1200);
  const nextStep = cleanText(input.next_step_notes, 1200);
  db.prepare(
    `INSERT INTO task_handoffs (task_id,summary,files_json,numbers_json,open_issues,next_step_notes,generated,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(task_id) DO UPDATE SET summary=excluded.summary, files_json=excluded.files_json,
       numbers_json=excluded.numbers_json, open_issues=excluded.open_issues, next_step_notes=excluded.next_step_notes,
       generated=excluded.generated, updated_at=excluded.updated_at`,
  ).run(
    taskId,
    summary,
    JSON.stringify(files),
    JSON.stringify(numbers),
    openIssues,
    nextStep,
    generated ? 1 : 0,
    now,
    now,
  );
  return getHandoff(db, taskId)!;
}

export function getHandoff(db: Db, taskId: string): Handoff | null {
  ensureWorkModelSchema(db);
  const row = db.prepare("SELECT * FROM task_handoffs WHERE task_id = ?").get(taskId) as Row | undefined;
  if (!row) return null;
  const parse = <T>(text: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(text)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    task_id: String(row.task_id),
    summary: String(row.summary),
    files: parse(row.files_json, []),
    numbers: parse(row.numbers_json, {}),
    open_issues: String(row.open_issues ?? ""),
    next_step_notes: String(row.next_step_notes ?? ""),
    generated: Number(row.generated) === 1,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/**
 * When a run ends without `task.handoff`, ATLAS writes one from the agent's final message so the next step still
 * has something, and marks it `generated` so the reviewer knows the agent skipped it.
 */
export function ensureHandoffAfterRun(
  db: Db,
  taskId: string,
  finalText: string | null,
  now = Date.now(),
): Handoff | null {
  const existing = getHandoff(db, taskId);
  if (existing) return existing;
  const text = cleanText(finalText ?? "", 20000);
  if (!text) return null;
  // The end of the output is where agents summarise; keep it readable.
  const summary = text.length > 1200 ? `…${text.slice(-1150)}` : text;
  if (summary.length < 20) return null;
  return saveHandoff(db, taskId, { summary }, now, true);
}

/** Plain-text block for prompts and reviews. */
export function formatHandoff(handoff: Handoff, heading: string): string {
  const lines = [
    `${heading}${handoff.generated ? " (written by ATLAS from the final message; the agent skipped task.handoff)" : ""}`,
    handoff.summary,
  ];
  if (handoff.files.length)
    lines.push("Files:", ...handoff.files.map((f) => `- ${f.path}${f.note ? ` (${f.note})` : ""}`));
  const numbers = Object.entries(handoff.numbers);
  if (numbers.length) lines.push("Key numbers:", ...numbers.map(([k, v]) => `- ${k}: ${v}`));
  if (handoff.open_issues) lines.push(`Open issues: ${handoff.open_issues}`);
  if (handoff.next_step_notes) lines.push(`For the next step: ${handoff.next_step_notes}`);
  return lines.join("\n");
}
