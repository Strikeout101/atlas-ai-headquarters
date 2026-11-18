import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Automatic database backups. Once a day (and at startup when the last good backup is older than the latest daily
 * slot) the live database is copied with `VACUUM INTO` to `backups/auto/`, next to the database. Every copy is
 * restore-tested: opened read-only, integrity-checked, and its row counts compared with the live database. Good
 * copies are also copied to an owner-chosen folder off this PC (a NAS share, OneDrive, an external drive) when set.
 * Old automatic copies are pruned after `keep_days`, but the newest three are always kept and nothing is pruned
 * after a failed backup. Manual backups in `backups/` are never touched.
 */
export const AUTO_BACKUP_PATTERN = /^claw-empire-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite$/;
const ALWAYS_KEEP = 3;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const CHECKED_TABLES = ["tasks", "agents", "business_contacts", "deals", "ledger_entries", "projects"];

export interface BackupSettings {
  enabled: boolean;
  hour: number;
  keep_days: number;
  copy_dir: string | null;
  updated_at: number;
}

export interface BackupRun {
  id: string;
  trigger: "schedule" | "startup" | "manual";
  started_at: number;
  finished_at: number;
  status: "ok" | "failed";
  file: string | null;
  size_bytes: number | null;
  sha256: string | null;
  check_detail: string;
  copy_status: "none" | "ok" | "failed";
  copy_detail: string | null;
  pruned: number;
}

type Row = Record<string, unknown>;

export function ensureBackupSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS backup_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    hour INTEGER NOT NULL DEFAULT 3 CHECK(hour BETWEEN 0 AND 23),
    keep_days INTEGER NOT NULL DEFAULT 30 CHECK(keep_days BETWEEN 1 AND 3650),
    copy_dir TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO backup_settings(id) VALUES (1);
  CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL CHECK(trigger IN ('schedule','startup','manual')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok','failed')),
    file TEXT, size_bytes INTEGER, sha256 TEXT,
    check_detail TEXT NOT NULL DEFAULT '',
    copy_status TEXT NOT NULL DEFAULT 'none' CHECK(copy_status IN ('none','ok','failed')),
    copy_detail TEXT,
    pruned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_backup_runs_time ON backup_runs(started_at DESC);`);
}

export function getBackupSettings(db: DatabaseSync): BackupSettings {
  ensureBackupSchema(db);
  const row = db.prepare("SELECT * FROM backup_settings WHERE id=1").get() as Row;
  return {
    enabled: Number(row.enabled) === 1,
    hour: Number(row.hour),
    keep_days: Number(row.keep_days),
    copy_dir: (row.copy_dir as string | null) || null,
    updated_at: Number(row.updated_at),
  };
}

export function saveBackupSettings(db: DatabaseSync, input: unknown, now = Date.now()): BackupSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const body = input as Row;
  const allowed = ["enabled", "hour", "keep_days", "copy_dir"];
  if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key)))
    throw new Error("invalid_backup_field");
  const next = { ...getBackupSettings(db), ...body } as Row;
  if (typeof next.enabled !== "boolean") throw new Error("invalid_enabled");
  if (!Number.isInteger(next.hour) || (next.hour as number) < 0 || (next.hour as number) > 23)
    throw new Error("invalid_hour");
  if (!Number.isInteger(next.keep_days) || (next.keep_days as number) < 1 || (next.keep_days as number) > 3650)
    throw new Error("invalid_keep_days");
  let copyDir: string | null = null;
  if (next.copy_dir !== null && next.copy_dir !== undefined && next.copy_dir !== "") {
    if (typeof next.copy_dir !== "string" || next.copy_dir.length > 1000 || next.copy_dir.includes("\0"))
      throw new Error("invalid_copy_dir");
    copyDir = next.copy_dir.trim();
    if (!path.isAbsolute(copyDir)) throw new Error("copy_dir_must_be_absolute");
  }
  db.prepare("UPDATE backup_settings SET enabled=?,hour=?,keep_days=?,copy_dir=?,updated_at=? WHERE id=1").run(
    next.enabled ? 1 : 0,
    next.hour as number,
    next.keep_days as number,
    copyDir,
    now,
  );
  return getBackupSettings(db);
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");
export function backupFileName(now: number): string {
  const d = new Date(now);
  return `claw-empire-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.sqlite`;
}

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 20);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of CHECKED_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    counts[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
  }
  return counts;
}

/** Restore test: the copy opens on its own, passes integrity_check, and has the same row counts as the source. */
export function verifyBackup(file: string, expected: Record<string, number>): { ok: boolean; detail: string } {
  let copy: DatabaseSync | null = null;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
    const integrity = (copy.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>)
      .map((row) => row.integrity_check)
      .join("; ");
    if (integrity !== "ok") return { ok: false, detail: `integrity_check: ${integrity.slice(0, 300)}` };
    const actual = tableCounts(copy);
    const mismatch = Object.entries(expected).filter(([table, count]) => actual[table] !== count);
    if (mismatch.length)
      return {
        ok: false,
        detail: `row counts differ: ${mismatch.map(([t, c]) => `${t} ${actual[t] ?? "missing"} vs ${c}`).join(", ")}`,
      };
    return {
      ok: true,
      detail: `integrity ok; ${Object.entries(actual)
        .map(([t, c]) => `${t} ${c}`)
        .join(", ")}`,
    };
  } catch (error) {
    return { ok: false, detail: `could not open the copy: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    copy?.close();
  }
}

/**
 * Deletes automatic backups older than keepDays in one folder, always keeping the newest three. Only files named
 * like automatic backups are considered, so manual copies and anything else in the folder are left alone.
 */
export function pruneBackupFolder(dir: string, keepDays: number, now = Date.now()): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs
    .readdirSync(dir)
    .filter((name) => AUTO_BACKUP_PATTERN.test(name))
    .sort()
    .reverse();
  let removed = 0;
  for (const name of files.slice(ALWAYS_KEEP)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < now - keepDays * 86_400_000) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Writes and removes a probe file to check that a copy folder exists and is writable. */
export function testBackupFolder(dir: unknown): { ok: boolean; error: string | null } {
  if (typeof dir !== "string" || !dir.trim() || !path.isAbsolute(dir.trim()))
    return { ok: false, error: "Enter a full folder path, such as \\\\nas\\backups\\atlas or D:\\ATLAS backups." };
  const folder = dir.trim();
  try {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
      return { ok: false, error: "That folder does not exist or cannot be reached from this PC." };
    const probe = path.join(folder, `.atlas-write-test-${randomUUID()}`);
    fs.writeFileSync(probe, "ATLAS backup folder test");
    fs.rmSync(probe, { force: true });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `ATLAS cannot write there: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function backupDirFor(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), "backups", "auto");
}

/** One backup: copy, restore test, optional off-PC copy, then pruning (only after a good backup). */
export function runBackup(
  db: DatabaseSync,
  input: { dbPath: string; trigger: BackupRun["trigger"]; backupDir?: string; now?: number },
): BackupRun {
  ensureBackupSchema(db);
  const settings = getBackupSettings(db);
  const started = input.now ?? Date.now();
  const dir = input.backupDir ?? backupDirFor(input.dbPath);
  const run: BackupRun = {
    id: randomUUID(),
    trigger: input.trigger,
    started_at: started,
    finished_at: started,
    status: "failed",
    file: null,
    size_bytes: null,
    sha256: null,
    check_detail: "",
    copy_status: "none",
    copy_detail: null,
    pruned: 0,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, backupFileName(started));
    if (fs.existsSync(file)) file = file.replace(/\.sqlite$/, `-${randomUUID().slice(0, 6)}.sqlite`);
    const expected = tableCounts(db);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    run.file = file;
    run.size_bytes = fs.statSync(file).size;
    run.sha256 = sha256File(file);
    const check = verifyBackup(file, expected);
    run.check_detail = check.detail;
    if (check.ok) {
      run.status = "ok";
      if (settings.copy_dir) {
        try {
          const target = path.join(settings.copy_dir, path.basename(file));
          fs.copyFileSync(file, target);
          if (fs.statSync(target).size !== run.size_bytes || sha256File(target) !== run.sha256)
            throw new Error("the copy does not match the original");
          run.copy_status = "ok";
          run.copy_detail = target;
          run.pruned += pruneBackupFolder(settings.copy_dir, settings.keep_days, started);
        } catch (error) {
          run.copy_status = "failed";
          run.copy_detail = error instanceof Error ? error.message : String(error);
        }
      }
      run.pruned += pruneBackupFolder(dir, settings.keep_days, started);
    }
  } catch (error) {
    run.check_detail = `backup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  run.finished_at = Date.now();
  db.prepare(
    `INSERT INTO backup_runs (id,trigger,started_at,finished_at,status,file,size_bytes,sha256,check_detail,copy_status,copy_detail,pruned)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    run.id,
    run.trigger,
    run.started_at,
    run.finished_at,
    run.status,
    run.file,
    run.size_bytes,
    run.sha256,
    run.check_detail,
    run.copy_status,
    run.copy_detail,
    run.pruned,
  );
  db.prepare(
    "DELETE FROM backup_runs WHERE id NOT IN (SELECT id FROM backup_runs ORDER BY started_at DESC LIMIT 200)",
  ).run();
  return run;
}

export function listBackupRuns(db: DatabaseSync, limit = 20): BackupRun[] {
  ensureBackupSchema(db);
  return db.prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?").all(limit) as unknown as BackupRun[];
}

/** The most recent daily slot (hour:00 local time) at or before now. */
export function latestSlot(hour: number, now: number): number {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

export function nextSlot(hour: number, now: number): number {
  const slot = new Date(latestSlot(hour, now));
  slot.setDate(slot.getDate() + 1);
  return slot.getTime();
}

/**
 * A backup is due when there is no good backup since the latest daily slot. After a failure the next try waits an
 * hour, so a broken copy folder or a full disk does not retry every few minutes.
 */
export function backupDue(db: DatabaseSync, now = Date.now()): boolean {
  const settings = getBackupSettings(db);
  if (!settings.enabled) return false;
  const lastGood = db.prepare("SELECT MAX(started_at) AS t FROM backup_runs WHERE status='ok'").get() as {
    t: number | null;
  };
  if (lastGood.t && lastGood.t >= latestSlot(settings.hour, now)) return false;
  const lastFailed = db.prepare("SELECT MAX(started_at) AS t FROM backup_runs WHERE status='failed'").get() as {
    t: number | null;
  };
  return !(lastFailed.t && now - lastFailed.t < RETRY_AFTER_FAILURE_MS);
}

export function backupOverview(db: DatabaseSync, dbPath: string, now = Date.now()) {
  const settings = getBackupSettings(db);
  const dir = backupDirFor(dbPath);
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => AUTO_BACKUP_PATTERN.test(name))
        .sort()
        .reverse()
        .map((name) => {
          const stat = fs.statSync(path.join(dir, name));
          return { name, size_bytes: stat.size, modified_at: stat.mtimeMs };
        })
    : [];
  const lastGood = db
    .prepare("SELECT * FROM backup_runs WHERE status='ok' ORDER BY started_at DESC LIMIT 1")
    .get() as unknown as BackupRun | undefined;
  return {
    settings,
    folder: dir,
    next_run_at: settings.enabled ? (backupDue(db, now) ? now : nextSlot(settings.hour, now)) : null,
    last_good: lastGood ?? null,
    runs: listBackupRuns(db, 10),
    files,
  };
}

/** Checks every 10 minutes whether a backup is due; the first check runs a minute after startup. */
export function startBackupScheduler(
  db: DatabaseSync,
  dbPath: string,
  log: (message: string) => void = (message) => console.log(`[backup] ${message}`),
): () => void {
  let first = true;
  const tick = () => {
    try {
      if (!backupDue(db)) return;
      const run = runBackup(db, { dbPath, trigger: first ? "startup" : "schedule" });
      log(
        run.status === "ok"
          ? `saved ${run.file} (${run.check_detail}; copy ${run.copy_status})`
          : `failed: ${run.check_detail}`,
      );
    } catch (error) {
      log(`scheduler error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      first = false;
    }
  };
  const boot = setTimeout(tick, 60_000);
  const interval = setInterval(tick, 10 * 60_000);
  boot.unref?.();
  interval.unref?.();
  return () => {
    clearTimeout(boot);
    clearInterval(interval);
  };
}
