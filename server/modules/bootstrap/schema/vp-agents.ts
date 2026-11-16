import type { DatabaseSync } from "node:sqlite";

/** Rebuild from the current schema so extension columns, indexes and references survive. */
export function ensureVpAgents(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get() as { sql: string };
  if (!row.sql.includes("'vp'")) {
    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name='agents' AND type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all() as { sql: string }[];
    const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      const sql = row.sql
        .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?agents["`\]]?/i, "CREATE TABLE agents_vp_upgrade")
        .replace(/role\s+IN\s*\(([^)]+)\)/i, "role IN ('vp',$1)");
      db.exec(sql);
      db.exec(
        "INSERT INTO agents_vp_upgrade SELECT * FROM agents; DROP TABLE agents; ALTER TABLE agents_vp_upgrade RENAME TO agents",
      );
      for (const index of indexes) db.exec(index.sql);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("vp_migration_foreign_key_check_failed");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec(`PRAGMA foreign_keys=${foreignKeys}`);
    }
  }
  const columns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "cli_fallback_provider")) {
    db.exec(
      "ALTER TABLE agents ADD COLUMN cli_fallback_provider TEXT NOT NULL DEFAULT 'codex' CHECK(cli_fallback_provider IN ('codex','claude'))",
    );
  }
  for (const provider of ["codex", "claude"]) {
    db.prepare(
      `INSERT OR IGNORE INTO agents (id,name,name_ko,name_ja,name_zh,department_id,role,cli_provider,avatar_emoji,personality)
      VALUES (?, ?, ?, ?, ?, NULL, 'vp', ?, '', ?)`,
    ).run(
      `atlas-vp-${provider}`,
      `${provider === "codex" ? "Codex" : "Claude"} VP`,
      `${provider} 부사장`,
      `${provider} 副社長`,
      `${provider} 副总裁`,
      provider,
      "Independently review approvals for the owner. Preserve spending, legal, customer-facing and default-department owner approval floors. Escalate uncertain decisions with a concrete reason.",
    );
  }
}
