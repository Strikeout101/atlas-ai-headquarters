import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_DB_PATH,
  DEFAULT_LOGS_DIR,
  LEGACY_DB_PATH,
  PREVIOUS_DB_PATH,
  resolveDbPath,
} from "../config/runtime.ts";

export function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export const SQLITE_BUSY_TIMEOUT_MS = readNonNegativeIntEnv("SQLITE_BUSY_TIMEOUT_MS", 5000);
export const SQLITE_BUSY_RETRY_MAX_ATTEMPTS = Math.min(readNonNegativeIntEnv("SQLITE_BUSY_RETRY_MAX_ATTEMPTS", 4), 20);
export const SQLITE_BUSY_RETRY_BASE_DELAY_MS = readNonNegativeIntEnv("SQLITE_BUSY_RETRY_BASE_DELAY_MS", 40);
export const SQLITE_BUSY_RETRY_MAX_DELAY_MS = Math.max(
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  readNonNegativeIntEnv("SQLITE_BUSY_RETRY_MAX_DELAY_MS", 400),
);
export const SQLITE_BUSY_RETRY_JITTER_MS = readNonNegativeIntEnv("SQLITE_BUSY_RETRY_JITTER_MS", 20);
// Meeting minutes keep at most this many action items (the `$` directive kickoff meeting).
export const REVIEW_MAX_MEMO_ITEMS_PER_DEPT = Math.max(
  1,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_MEMO_ITEMS_PER_DEPT", 2), 8),
);
export const REVIEW_MAX_MEMO_ITEMS_PER_ROUND = Math.max(
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  Math.min(readNonNegativeIntEnv("REVIEW_MAX_MEMO_ITEMS_PER_ROUND", 8), 24),
);
export const IN_PROGRESS_ORPHAN_GRACE_MS = Math.max(
  30_000,
  readNonNegativeIntEnv("IN_PROGRESS_ORPHAN_GRACE_MS", 600_000),
);
export const IN_PROGRESS_ORPHAN_SWEEP_MS = Math.max(
  10_000,
  readNonNegativeIntEnv("IN_PROGRESS_ORPHAN_SWEEP_MS", 30_000),
);
export const SUBTASK_DELEGATION_SWEEP_MS = Math.max(
  5_000,
  readNonNegativeIntEnv("SUBTASK_DELEGATION_SWEEP_MS", 15_000),
);
export const CLI_OUTPUT_DEDUP_WINDOW_MS = Math.max(0, readNonNegativeIntEnv("CLI_OUTPUT_DEDUP_WINDOW_MS", 1500));

export function initializeDatabaseRuntime(): {
  dbPath: string;
  db: DatabaseSync;
  logsDir: string;
} {
  // A very old install (climpire.sqlite) with neither newer name: move it to atlas.sqlite once.
  if (
    !process.env.DB_PATH &&
    !fs.existsSync(DEFAULT_DB_PATH) &&
    !fs.existsSync(PREVIOUS_DB_PATH) &&
    fs.existsSync(LEGACY_DB_PATH)
  ) {
    fs.renameSync(LEGACY_DB_PATH, DEFAULT_DB_PATH);
    for (const suffix of ["-wal", "-shm"]) {
      const src = LEGACY_DB_PATH + suffix;
      if (fs.existsSync(src)) fs.renameSync(src, DEFAULT_DB_PATH + suffix);
    }
    console.log("[ATLAS] Migrated database: climpire.sqlite -> atlas.sqlite");
  }

  const dbPath = resolveDbPath((file) => fs.existsSync(file));
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  console.log(
    `[ATLAS] SQLite write resilience: busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}ms, ` +
      `retries=${SQLITE_BUSY_RETRY_MAX_ATTEMPTS}, ` +
      `backoff=${SQLITE_BUSY_RETRY_BASE_DELAY_MS}-${SQLITE_BUSY_RETRY_MAX_DELAY_MS}ms, ` +
      `jitter<=${SQLITE_BUSY_RETRY_JITTER_MS}ms`,
  );
  console.log(
    `[ATLAS] In-progress watchdog: grace=${IN_PROGRESS_ORPHAN_GRACE_MS}ms, ` + `sweep=${IN_PROGRESS_ORPHAN_SWEEP_MS}ms`,
  );
  console.log(`[ATLAS] Subtask delegation sweep: interval=${SUBTASK_DELEGATION_SWEEP_MS}ms`);

  const logsDir = process.env.LOGS_DIR ?? DEFAULT_LOGS_DIR;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // ignore
  }

  return { dbPath, db, logsDir };
}
