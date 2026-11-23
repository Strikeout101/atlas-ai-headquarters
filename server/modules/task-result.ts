import type { DatabaseSync } from "node:sqlite";
import { prettyStreamJson } from "./routes/ops/terminal/pretty-stream-json.ts";

/**
 * A task's stored result and report text must be what the agent said, never raw CLI events. The CLIs end their
 * stream with a JSON summary (token counts, cost, the login credential's expiry time); before 2026-11-23 the last
 * 2,000 raw characters were stored as the result and that leaked into task reports.
 */
const NOISE = [
  /"type"\s*:\s*"result"/,
  /"model_usage(_since_last_result)?"/,
  /"credential_expires_at"/,
  /"costUSD"/,
  /"cacheReadInputTokens"/,
  /"ttft_ms"/,
  /"type"\s*:\s*"item\.(completed|started)"/,
  /"session_id"\s*:/,
];
const RESULT_LIMIT = 2000;

/** Drops CLI event and usage noise from text, keeping the readable lines. */
export function scrubCliNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      // A readable sentence glued to the start of a JSON summary: keep the sentence, drop the JSON.
      const glued = line.search(/",\s*"(ttft_ms|type|duration_ms|uuid|session_id|usage|model_usage[a-z_]*)"\s*:/);
      return glued > 0 && NOISE.some((pattern) => pattern.test(line)) ? line.slice(0, glued) : line;
    })
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    .join("\n")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The result to store for a finished run: the agent's readable output (its last ~2,000 characters). */
export function cleanRunResult(rawLog: string): string | null {
  if (!rawLog) return null;
  const readable = scrubCliNoise(prettyStreamJson(rawLog.slice(-200_000)));
  if (!readable) return null;
  return readable.length > RESULT_LIMIT ? readable.slice(-RESULT_LIMIT) : readable;
}

export function hasCliNoise(text: string | null | undefined): boolean {
  return Boolean(text) && NOISE.some((pattern) => pattern.test(String(text)));
}

export const RESULTS_SCRUBBED_SETTING = "taskResultsScrubbedAt";

/**
 * One time: rewrite stored results that still hold raw CLI events (the hand-off summary when there is one, else the
 * scrubbed text) and delete the old automatic consolidated reports. Guarded by a setting.
 */
export function scrubStoredRunResults(db: DatabaseSync, now = Date.now()): { results: number; archives: number } {
  const has = (table: string) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  if (!has("settings") || !has("tasks")) return { results: 0, archives: 0 };
  if (db.prepare("SELECT 1 FROM settings WHERE key=?").get(RESULTS_SCRUBBED_SETTING))
    return { results: 0, archives: 0 };
  let results = 0;
  let archives = 0;
  const rows = db.prepare("SELECT id, result FROM tasks WHERE result IS NOT NULL").all() as Array<{
    id: string;
    result: string;
  }>;
  const handoff = has("task_handoffs") ? db.prepare("SELECT summary FROM task_handoffs WHERE task_id=?") : null;
  for (const row of rows) {
    if (!hasCliNoise(row.result)) continue;
    const summary = (handoff?.get(row.id) as { summary?: string } | undefined)?.summary;
    db.prepare("UPDATE tasks SET result=? WHERE id=?").run(summary || scrubCliNoise(row.result) || null, row.id);
    results++;
  }
  // Every archived report before this fix came from the automatic consolidated report, built from raw results.
  // They are removed; the manual "Refresh Consolidation" rebuilds a clean one from the hand-offs.
  if (has("task_report_archives")) archives = Number(db.prepare("DELETE FROM task_report_archives").run().changes);
  db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run(
    RESULTS_SCRUBBED_SETTING,
    JSON.stringify({ at: now, results, archives }),
  );
  return { results, archives };
}
