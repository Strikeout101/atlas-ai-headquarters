import type { DatabaseSync } from "node:sqlite";

/**
 * Content guard. Text that agents read from outside (web pages, search results, and later emails, Etsy messages and
 * reviews) is data, never instructions. This module:
 *
 *   - strips invisible and direction-changing characters (used to hide text from people);
 *   - flags phrasings that try to give the agent instructions ("ignore previous instructions", fake system tags,
 *     "send this to ...", "transfer $...");
 *   - records a flag against the task that read it. From then on every approval that task asks for (emails, listings,
 *     spending, record changes, code pushes) goes to the owner instead of the VPs, so planted text can never trigger a
 *     send, publish or spend on its own.
 */
type Db = DatabaseSync;

// Zero-width, bidi embedding/override/isolate marks, BOM, soft hyphen and the Unicode tag block.
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

const DIRECTIVES: Array<[string, RegExp]> = [
  [
    "ignore_instructions",
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidelines?)\b/i,
  ],
  [
    "role_takeover",
    /\byou are now\b|\bact as (the )?(system|admin|developer|owner)\b|\bnew (system )?instructions?\s*:/i,
  ],
  [
    "fake_system_tags",
    /<\s*\/?\s*(system|assistant|developer|instructions?)\s*>|\[\s*(system|inst)\s*\]|BEGIN (SYSTEM|INSTRUCTIONS)/i,
  ],
  ["prompt_probe", /\b(reveal|print|show|repeat)\b[^.\n]{0,30}\b(system|hidden|developer) prompt\b/i],
  [
    "hide_from_owner",
    /\b(do not|don't|never) (tell|inform|show|mention)[^.\n]{0,20}\b(the )?(user|owner|human|ceo)\b/i,
  ],
  ["send_elsewhere", /\b(send|forward|email|post|upload)\b[^.\n]{0,50}\b(to|at)\b[^.\n]{0,10}[\w.+-]+@[\w-]+\.[\w.]+/i],
  ["move_money", /\b(transfer|wire|send|pay|refund)\b[^.\n]{0,20}(\$|usd|eur|€|£)\s?\d/i],
  [
    "run_commands",
    /\b(run|execute|paste)\b[^.\n]{0,20}\b(this|the following|these)\b[^.\n]{0,20}\b(commands?|code|script|in (a|the|your) terminal)\b/i,
  ],
  [
    "credential_request",
    /\b(enter|share|send|provide|give)\b[^.\n]{0,30}\b(password|api key|token|secret|credentials?|2fa|one-time code)\b/i,
  ],
];

export interface GuardResult {
  text: string;
  flags: string[];
}

/** Cleans one piece of outside text and lists the instruction-like patterns found in it. */
export function guardText(value: unknown): GuardResult {
  if (typeof value !== "string" || !value) return { text: typeof value === "string" ? value : "", flags: [] };
  const text = value.replace(INVISIBLE, "");
  const flags = DIRECTIVES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (text.length !== value.length) flags.push("hidden_characters");
  return { text, flags };
}

/** Guards every string inside a JSON-like value (search results, a read page). Returns the cleaned copy and all flags. */
export function guardValue<T>(value: T): { value: T; flags: string[] } {
  const flags = new Set<string>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      const result = guardText(input);
      result.flags.forEach((flag) => flags.add(flag));
      return result.text;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    return input;
  };
  return { value: walk(value) as T, flags: [...flags] };
}

export function ensureContentGuardSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS untrusted_content_flags (
    id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, flags TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_untrusted_flags_task ON untrusted_content_flags(task_id);`);
}

export function recordUntrustedContent(
  db: Db,
  taskId: string,
  source: string,
  flags: string[],
  now = Date.now(),
): void {
  if (!flags.length) return;
  ensureContentGuardSchema(db);
  db.prepare("INSERT INTO untrusted_content_flags(task_id,source,flags,created_at) VALUES (?,?,?,?)").run(
    taskId,
    source.slice(0, 500),
    flags.join(","),
    now,
  );
}

/** Whether this task, or the task it was delegated from (up to three steps up), read flagged outside content. */
export function taskReadFlaggedContent(db: Db, taskId: unknown): boolean {
  if (typeof taskId !== "string" || !taskId) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='untrusted_content_flags'").get())
    return false;
  const hasSource = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some(
    (column) => column.name === "source_task_id",
  );
  let current: string | null = taskId;
  for (let depth = 0; current && depth < 4; depth++) {
    if (db.prepare("SELECT 1 FROM untrusted_content_flags WHERE task_id=? LIMIT 1").get(current)) return true;
    if (!hasSource) break;
    const row = db.prepare("SELECT source_task_id FROM tasks WHERE id=?").get(current) as
      | { source_task_id: string | null }
      | undefined;
    current = row?.source_task_id ?? null;
  }
  return false;
}

/** Flags for one task, for the approval card and the task log. */
export function untrustedFlagsForTask(db: Db, taskId: string) {
  ensureContentGuardSchema(db);
  return db
    .prepare("SELECT source, flags, created_at FROM untrusted_content_flags WHERE task_id=? ORDER BY id DESC LIMIT 10")
    .all(taskId) as Array<{ source: string; flags: string; created_at: number }>;
}
