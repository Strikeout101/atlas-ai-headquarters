import type { DatabaseSync } from "node:sqlite";
import type { ReviewOwnerDecisionItem, TimeoutResumeDecisionItem } from "./types.ts";

type TextFns = {
  db: DatabaseSync;
  nowMs: () => number;
  getPreferredLanguage: () => string;
  pickL: (localized: any, lang: string) => string;
  l: (en: string[]) => any;
};

/** Tasks that timed out and went back to the inbox: resume or keep. */
export function buildTimeoutResumeDecisionItems(deps: TextFns): TimeoutResumeDecisionItem[] {
  const { db, nowMs, getPreferredLanguage, pickL, l } = deps;
  const lang = getPreferredLanguage();
  const t = (en: string) => pickL(l([en]), lang);
  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.title AS task_title, t.project_id AS project_id, p.name AS project_name,
              t.project_path AS project_path, t.updated_at AS updated_at,
              (SELECT MAX(tl.created_at) FROM task_logs tl WHERE tl.task_id = t.id AND tl.message LIKE '%RUN TIMEOUT%') AS timeout_at
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'inbox'
         AND EXISTS (SELECT 1 FROM task_logs tl WHERE tl.task_id = t.id AND tl.message LIKE '%RUN TIMEOUT%')
       ORDER BY COALESCE(timeout_at, t.updated_at) DESC, t.updated_at DESC
       LIMIT 200`,
    )
    .all() as Array<{
    task_id: string;
    task_title: string;
    project_id: string | null;
    project_name: string | null;
    project_path: string | null;
    updated_at: number | null;
    timeout_at: number | null;
  }>;
  return rows.map((row) => ({
    id: `task-timeout-resume:${row.task_id}`,
    kind: "task_timeout_resume",
    created_at: row.timeout_at ?? row.updated_at ?? nowMs(),
    summary: t(`Task '${row.task_title}' moved to Inbox after timeout. Continue from where it left off?`),
    project_id: row.project_id,
    project_name: row.project_name,
    project_path: row.project_path,
    task_id: row.task_id,
    task_title: row.task_title,
    options: [
      { number: 1, action: "resume_timeout_task", label: t("Resume from where it stopped (recommended)") },
      { number: 2, action: "keep_inbox", label: t("Keep in Inbox") },
    ],
  }));
}

/** Reviews the VPs passed to the owner: accept as is, one more go, or drop. Recommendation first. */
export function buildReviewOwnerDecisionItems(deps: TextFns): ReviewOwnerDecisionItem[] {
  const { db, nowMs } = deps;
  let rows: Array<Record<string, any>> = [];
  try {
    rows = db
      .prepare(
        `SELECT t.id AS task_id, t.title AS task_title, t.project_id, p.name AS project_name, t.project_path, t.updated_at,
                (SELECT r.summary FROM task_reviews r WHERE r.task_id = t.id AND r.status = 'owner' ORDER BY r.created_at DESC LIMIT 1) AS reason,
                (SELECT r.created_at FROM task_reviews r WHERE r.task_id = t.id AND r.status = 'owner' ORDER BY r.created_at DESC LIMIT 1) AS asked_at
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'review' AND t.review_state = 'owner'
         ORDER BY t.updated_at DESC LIMIT 100`,
      )
      .all() as Array<Record<string, any>>;
  } catch {
    return []; // reviews not set up in this database yet
  }
  return rows.map((row) => ({
    id: `review-owner:${String(row.task_id)}`,
    kind: "review_owner",
    created_at: Number(row.asked_at ?? row.updated_at ?? nowMs()),
    summary: `"${String(row.task_title)}" is stuck in review. ${String(row.reason ?? "")}`.trim(),
    project_id: (row.project_id as string | null) ?? null,
    project_name: (row.project_name as string | null) ?? null,
    project_path: (row.project_path as string | null) ?? null,
    task_id: String(row.task_id),
    task_title: String(row.task_title),
    options: [
      { number: 1, action: "review_retry", label: "One more go with the review's list (recommended)" },
      { number: 2, action: "review_accept", label: "Accept it as is" },
      { number: 3, action: "review_drop", label: "Drop the task" },
    ],
  }));
}
