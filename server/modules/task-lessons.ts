import type { DatabaseSync } from "node:sqlite";
import { addMemory, ensureAgentMemorySchema } from "./agent-memory.ts";
import { resolveTaskContext } from "./agent-knowledge.ts";

/**
 * Lessons at task end. Agents are asked to save what they learned with `memory.add`, or, when they cannot call tools,
 * to end their final message with lines like:
 *
 *   LESSON: <short title> | <what to do next time>
 *   FACT: <short title> | <something true that the next task should know>
 *   LESSON: none
 *
 * When a task finishes, this checks which happened. Lines from the final output are saved as unreviewed memories
 * (the owner reviews them in Team > Knowledge). Every check is recorded, so missing lessons are visible.
 */
type Db = DatabaseSync;

export type LessonOutcome = "agent_added" | "captured" | "none_declared" | "missing";

export interface ParsedLesson {
  kind: "lesson" | "fact";
  title: string;
  body: string;
}

const MAX_CAPTURED = 3;
const LINE_RE = /^\s*(?:[-*]\s*)?(LESSON|FACT)\s*:\s*(.+)$/gim;

export function ensureLessonCheckSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS task_lesson_checks (
    task_id TEXT PRIMARY KEY,
    agent_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('agent_added','captured','none_declared','missing')),
    saved INTEGER NOT NULL DEFAULT 0,
    detail TEXT,
    checked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_lesson_checks_time ON task_lesson_checks(checked_at);`);
}

/** The `LESSON:` and `FACT:` lines of an agent's final output. `none` means the agent said there was nothing. */
export function parseLessonLines(text: string): { lessons: ParsedLesson[]; declaredNone: boolean } {
  const lessons: ParsedLesson[] = [];
  let declaredNone = false;
  for (const match of text.matchAll(LINE_RE)) {
    const kind = match[1].toLowerCase() as "lesson" | "fact";
    const rest = match[2].replace(/[`*]+$/g, "").trim();
    if (/^(none|n\/a|nothing)\.?$/i.test(rest)) {
      declaredNone = true;
      continue;
    }
    const split = rest.split(/\s+\|\s+|\s+[—–]\s+/);
    const title = (split.length > 1 ? split[0] : rest.slice(0, 80)).trim().slice(0, 120);
    const body = (split.length > 1 ? split.slice(1).join(" | ") : rest).trim().slice(0, 1500);
    if (title.length < 4 || body.length < 8) continue;
    if (lessons.some((lesson) => lesson.title.toLowerCase() === title.toLowerCase())) continue;
    lessons.push({ kind, title, body });
  }
  return { lessons, declaredNone };
}

/**
 * Called once when a task's run finishes successfully. Never throws: lessons must not block a task.
 * `output` is the readable final output of the run (the end of it is enough).
 */
export function captureTaskLessons(
  db: Db,
  input: { taskId: string; agentId: string | null; output: string },
  now = Date.now(),
): { outcome: LessonOutcome; saved: number } {
  try {
    ensureAgentMemorySchema(db);
    ensureLessonCheckSchema(db);
    const already = Number(
      (
        db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE source_task_id=?").get(input.taskId) as {
          n: number;
        }
      ).n,
    );
    let outcome: LessonOutcome;
    let saved = 0;
    let detail = "";
    if (already > 0) {
      outcome = "agent_added";
      saved = already;
    } else {
      const { lessons, declaredNone } = parseLessonLines(input.output.slice(-12_000));
      const ctx = resolveTaskContext(db, input.taskId);
      const scope = ctx?.projectId
        ? { scope: "project", project_id: ctx.projectId, business: ctx.business ?? undefined }
        : ctx?.business
          ? { scope: "business", business: ctx.business }
          : { scope: "global" };
      const refused: string[] = [];
      for (const lesson of lessons.slice(0, MAX_CAPTURED)) {
        try {
          addMemory(
            db,
            { kind: lesson.kind, ...scope, title: lesson.title, body: lesson.body },
            { agentId: input.agentId, taskId: input.taskId },
            now,
          );
          saved += 1;
        } catch (error) {
          refused.push(error instanceof Error ? error.message : "refused");
        }
      }
      outcome = saved > 0 ? "captured" : declaredNone ? "none_declared" : "missing";
      if (refused.length) detail = `not saved: ${refused.join(", ")}`;
    }
    db.prepare(
      `INSERT INTO task_lesson_checks (task_id, agent_id, outcome, saved, detail, checked_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id, outcome=excluded.outcome, saved=excluded.saved,
         detail=excluded.detail, checked_at=excluded.checked_at`,
    ).run(input.taskId, input.agentId, outcome, saved, detail || null, now);
    return { outcome, saved };
  } catch {
    return { outcome: "missing", saved: 0 };
  }
}

export interface LessonCoverage {
  days: number;
  counts: Record<LessonOutcome, number>;
  recentMissing: Array<{ task_id: string; title: string; agent_name: string | null; checked_at: number }>;
}

/** How often finished tasks left lessons, for Team > Knowledge. */
export function lessonCoverage(db: Db, days = 30, now = Date.now()): LessonCoverage {
  ensureLessonCheckSchema(db);
  const since = now - days * 86_400_000;
  const counts: Record<LessonOutcome, number> = { agent_added: 0, captured: 0, none_declared: 0, missing: 0 };
  for (const row of db
    .prepare("SELECT outcome, COUNT(*) AS n FROM task_lesson_checks WHERE checked_at >= ? GROUP BY outcome")
    .all(since) as Array<{ outcome: LessonOutcome; n: number }>) {
    counts[row.outcome] = Number(row.n);
  }
  const recentMissing = db
    .prepare(
      `SELECT c.task_id, COALESCE(t.title, c.task_id) AS title, a.name AS agent_name, c.checked_at
       FROM task_lesson_checks c LEFT JOIN tasks t ON t.id = c.task_id LEFT JOIN agents a ON a.id = c.agent_id
       WHERE c.outcome = 'missing' AND c.checked_at >= ? ORDER BY c.checked_at DESC LIMIT 5`,
    )
    .all(since) as LessonCoverage["recentMissing"];
  return { days, counts, recentMissing };
}
