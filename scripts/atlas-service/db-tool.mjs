#!/usr/bin/env node
/**
 * Small database helper for the service scripts.
 *   node db-tool.mjs check <file>            exit 0 when SQLite's integrity check passes
 *   node db-tool.mjs snapshot <db> <target>  consistent copy of a live database (VACUUM INTO)
 */
import { DatabaseSync } from "node:sqlite";

const [command, source, target] = process.argv.slice(2);
try {
  if (command === "check") {
    const db = new DatabaseSync(source, { readOnly: true });
    const result = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check)
      .join("; ");
    db.close();
    if (result !== "ok") {
      console.error(result);
      process.exit(1);
    }
    console.log("ok");
  } else if (command === "snapshot") {
    const db = new DatabaseSync(source);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    db.close();
    console.log(target);
  } else {
    console.error("usage: db-tool.mjs check <file> | snapshot <db> <target>");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
