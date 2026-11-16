#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const runtimeDir = path.resolve(process.cwd(), ".tmp", "e2e-runtime");
const logsDir = path.join(runtimeDir, "logs");
const dbPath = path.join(runtimeDir, "claw-empire.e2e.sqlite");

fs.mkdirSync(runtimeDir, { recursive: true });

for (const suffix of ["", "-wal", "-shm"]) {
  const target = `${dbPath}${suffix}`;
  if (!fs.existsSync(target)) continue;
  fs.rmSync(target, { force: true });
}

fs.rmSync(logsDir, { recursive: true, force: true });
fs.mkdirSync(logsDir, { recursive: true });

// Prove the browser's API is using this disposable database before any test can mutate data.
const runtimeId = randomUUID();
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
db.prepare("INSERT INTO settings (key,value) VALUES ('__e2eRuntimeId',?)").run(JSON.stringify(runtimeId));
db.close();
fs.writeFileSync(path.join(runtimeDir, "runtime-id.txt"), runtimeId);

console.log(`[e2e] prepared isolated runtime`);
console.log(`[e2e] DB_PATH=${dbPath}`);
console.log(`[e2e] LOGS_DIR=${logsDir}`);
