import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  cleanRunResult,
  hasCliNoise,
  scrubCliNoise,
  scrubStoredRunResults,
  RESULTS_SCRUBBED_SETTING,
} from "./task-result.ts";

const RESULT_EVENT = JSON.stringify({
  type: "result",
  result: "I finished the scan and sent the handoff.",
  ttft_ms: 1300,
  model_usage_since_last_result: { "some-model": { inputTokens: 12, cacheReadInputTokens: 9, costUSD: 0.23 } },
  credential_expires_at: "2026-12-17T19:40:40.967Z",
});

describe("task results", () => {
  it("stores what the agent said, never usage, cost or credential data", () => {
    const log = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "I finished the scan and sent the handoff." }] },
      }),
      RESULT_EVENT,
    ].join("\n");
    const result = cleanRunResult(log) ?? "";
    expect(result).toContain("I finished the scan");
    expect(result).not.toMatch(/costUSD|credential_expires_at|Tokens|ttft_ms/);
    expect(hasCliNoise(result)).toBe(false);
  });

  it("keeps the sentence glued to the start of a raw result tail", () => {
    const raw = `The gaps are the same as before.","ttft_ms":1300,"type":"result","credential_expires_at":"2026-12-17T19:40:40.967Z"}`;
    expect(scrubCliNoise(raw)).toBe("The gaps are the same as before.");
  });

  it("cleans stored rows once: the hand-off summary replaces raw results and the old automatic reports are removed", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, result TEXT);
      CREATE TABLE task_handoffs (task_id TEXT PRIMARY KEY, summary TEXT);
      CREATE TABLE task_report_archives (id TEXT PRIMARY KEY, summary_markdown TEXT, source_snapshot_json TEXT);`);
    db.prepare("INSERT INTO tasks VALUES (?,?)").run("a", `wrapped up.",${RESULT_EVENT.slice(1)}`);
    db.prepare("INSERT INTO tasks VALUES (?,?)").run("b", `Plain text only.","ttft_ms":5,"costUSD":0.1}`);
    db.prepare("INSERT INTO tasks VALUES (?,?)").run("c", "A clean result.");
    db.prepare("INSERT INTO task_handoffs VALUES (?,?)").run("a", "Market scan done; see research/market.md.");
    db.prepare("INSERT INTO task_report_archives VALUES (?,?,?)").run("r1", `- Result snippet: x${RESULT_EVENT}`, "{}");
    db.prepare("INSERT INTO task_report_archives VALUES (?,?,?)").run("r2", "A clean report.", "{}");

    expect(scrubStoredRunResults(db)).toEqual({ results: 2, archives: 2 });
    const result = (id: string) =>
      (db.prepare("SELECT result FROM tasks WHERE id=?").get(id) as { result: string }).result;
    expect(result("a")).toBe("Market scan done; see research/market.md.");
    expect(result("b")).toBe("Plain text only.");
    expect(result("c")).toBe("A clean result.");
    expect(db.prepare("SELECT id FROM task_report_archives").all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM settings WHERE key=?").get(RESULTS_SCRUBBED_SETTING)).toBeTruthy();

    db.prepare("UPDATE tasks SET result=? WHERE id='c'").run(`late","costUSD":1}`);
    expect(scrubStoredRunResults(db)).toEqual({ results: 0, archives: 0 });
  });
});
