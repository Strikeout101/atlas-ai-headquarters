import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type Db = { prepare: (sql: string) => { all: (...args: any[]) => unknown } };

type CheckpointInput = {
  db: Db;
  taskId: string;
  title: string;
  description: string | null;
  worktreePath: string;
  logPath: string;
  reason: string;
};

function git(worktreePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function latestRunOutput(logPath: string): string {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const marker = raw.lastIndexOf("===== task run start ");
    return (marker < 0 ? raw : raw.slice(marker)).slice(-8_000);
  } catch {
    return "";
  }
}

export function buildContextRolloverCheckpoint(input: CheckpointInput): {
  checkpointText: string;
  progressFingerprint: string;
} {
  const worktreePath = fs.realpathSync.native(input.worktreePath);
  const root = git(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (fs.realpathSync.native(root).toLowerCase() !== worktreePath.toLowerCase()) {
    throw new Error("context_rollover_worktree_invalid");
  }

  const diffStat = git(worktreePath, ["diff", "HEAD", "--stat"]);
  const status = git(worktreePath, ["status", "--short", "--untracked-files=normal"]);
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], {
    cwd: worktreePath,
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const fingerprint = createHash("sha256").update(diff);
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relative of untracked) {
    const full = path.resolve(worktreePath, relative);
    if (!full.startsWith(`${worktreePath}${path.sep}`)) continue;
    fingerprint.update(relative);
    const stat = fs.lstatSync(full);
    fingerprint.update(String(stat.size));
    if (stat.isFile() && stat.size <= 10 * 1024 * 1024) fingerprint.update(fs.readFileSync(full));
  }

  const subtasks = input.db
    .prepare("SELECT id, title, status FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC")
    .all(input.taskId) as Array<{ id: string; title: string; status: string }>;
  const done = subtasks.filter((item) => item.status === "done");
  const remaining = subtasks.filter((item) => item.status !== "done");
  fingerprint.update(done.map((item) => item.id).join("\n"));
  const output = latestRunOutput(input.logPath);
  const testLines = output
    .split(/\r?\n/)
    .filter((line) => /(?:\btests?\b|\bpassed\b|\bfailed\b|\bvitest\b|\bpnpm (?:run )?test\b)/i.test(line))
    .slice(-12)
    .map((line) => line.slice(0, 250));
  const checkpointText = [
    `[Context rollover: ${input.reason}]`,
    `Task: ${input.title}`,
    input.description ? `Goal and requirements:\n${input.description.slice(0, 3_500)}` : "",
    `Worktree changes:\n${(diffStat || status || "No tracked changes yet").slice(0, 1_500)}`,
    status && diffStat ? `Working tree status:\n${status.slice(0, 1_500)}` : "",
    `Completed subtasks:\n${
      done.length
        ? done
            .map((item) => `- ${item.title}`)
            .join("\n")
            .slice(0, 1_000)
        : "None recorded"
    }`,
    `Remaining steps:\n${
      remaining.length
        ? remaining
            .map((item) => `- ${item.title}`)
            .join("\n")
            .slice(0, 1_000)
        : "Inspect the worktree, finish the task requirements, and run relevant tests."
    }`,
    `Test evidence from this run:\n${testLines.length ? testLines.join("\n").slice(0, 1_500) : "No test result recorded"}`,
    output ? `Last run output excerpt:\n${output.slice(-1_500)}` : "",
    "Continue from the existing files. Verify what is already complete before editing. Do not commit.",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
  return { checkpointText, progressFingerprint: fingerprint.digest("hex") };
}
