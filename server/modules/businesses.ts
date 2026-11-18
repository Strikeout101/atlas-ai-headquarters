import type { DatabaseSync } from "node:sqlite";

/**
 * The businesses ATLAS works for. This is the one place the list lives on the server.
 *
 * Who approves customer sends, record changes and code pushes is set per business by the owner
 * (business-policies.ts). Spending money is never covered by those settings; it always needs the owner.
 */
export const BUSINESS_KEYS = ["tech", "rental", "ventures"] as const;
export type BusinessKey = (typeof BUSINESS_KEYS)[number];
export type BusinessApprover = "owner" | "vp";

/** Labels only. Who approves what is an owner setting: see business-policies.ts. */
export const BUSINESSES: Record<BusinessKey, { label: string }> = {
  tech: { label: "Tech services business" },
  rental: { label: "Events and rentals business" },
  ventures: { label: "AI-run ventures (online products and services)" },
};

export function isBusinessKey(value: unknown): value is BusinessKey {
  return typeof value === "string" && (BUSINESS_KEYS as readonly string[]).includes(value);
}

/** `'tech','rental','ventures'`, for CHECK constraints in CREATE TABLE statements. */
export const BUSINESS_SQL_LIST = BUSINESS_KEYS.map((key) => `'${key}'`).join(",");

const BUSINESS_CHECK = /CHECK\s*\(\s*business\s+IN\s*\(([^)]*)\)\s*\)/i;

/**
 * Brings an existing table's `CHECK (business IN (...))` in line with the current list of businesses.
 *
 * SQLite cannot alter a CHECK, so the table is rebuilt: same columns, same rows, same indexes, new constraint.
 * Foreign keys are switched off for the rebuild, otherwise dropping the old table would run its ON DELETE actions
 * (clearing contact links on tickets, quotes and drafts). Does nothing when the table is missing or already current.
 */
export function syncBusinessCheck(db: DatabaseSync, table: string): boolean {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name: ${table}`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql?: string }
    | undefined;
  const createSql = row?.sql;
  if (!createSql) return false;
  const match = createSql.match(BUSINESS_CHECK);
  if (!match) return false;
  const existing = match[1].replace(/\s+/g, "");
  if (existing === BUSINESS_SQL_LIST) return false;

  const tableName = new RegExp(`^(CREATE\\s+TABLE\\s+)(["'\`\\[]?)${table}(["'\`\\]]?)`, "i");
  if (!tableName.test(createSql)) throw new Error(`cannot rebuild ${table}: unexpected definition`);
  const rebuildName = `${table}__rebuild`;
  const rebuildSql = createSql
    .replace(tableName, `$1"${rebuildName}"`)
    .replace(BUSINESS_CHECK, `CHECK (business IN (${BUSINESS_SQL_LIST}))`);
  const indexes = (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>
  ).map((index) => index.sql);
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

  const foreignKeysOn = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number })?.foreign_keys === 1;
  if (foreignKeysOn) db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`DROP TABLE IF EXISTS "${rebuildName}"`);
      db.exec(rebuildSql);
      db.exec(`INSERT INTO "${rebuildName}" SELECT * FROM "${table}"`);
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM "${rebuildName}"`).get() as { n: number }).n;
      if (after !== before) throw new Error(`rebuild of ${table} copied ${after} of ${before} rows`);
      db.exec(`DROP TABLE "${table}"`);
      db.exec(`ALTER TABLE "${rebuildName}" RENAME TO "${table}"`);
      for (const indexSql of indexes) db.exec(indexSql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (foreignKeysOn) db.exec("PRAGMA foreign_keys = ON");
  }
  return true;
}
