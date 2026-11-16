import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "prepare" | "exec">;

/**
 * Office packs (novel, report, video, research, roleplay offices) were removed on 2026-11-16.
 * This one-way cleanup deletes everything they left behind: agents and tasks that belonged to another pack,
 * per-pack departments, the pack catalog and the office-pack settings. Safe to run on every start.
 */
const PACK_SETTING_KEYS = [
  "officeWorkflowPack",
  "officePackProfiles",
  "officePackHydratedPacks",
  "officePackSeedAgentsInitialized",
];

/** Agent columns that are not foreign keys but only make sense while the agent exists. */
const AGENT_OWNED_ROWS: Array<[table: string, column: string]> = [
  ["homelab_ssh_grants", "agent_id"],
  ["agent_task_proposals", "agent_id"],
  ["agent_autonomy_state", "agent_id"],
];

export type OfficePackCleanupResult = { agents: number; tasks: number; droppedTables: string[] };

function tableExists(db: DbLike, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(db: DbLike, table: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number }>;
}

function hasColumn(db: DbLike, table: string, column: string): boolean {
  return tableExists(db, table) && columns(db, table).some((c) => c.name === column);
}

/** Every (table, column) with a foreign key to `target`, and whether that column may be null. */
function referencesTo(db: DbLike, target: string): Array<{ table: string; column: string; nullable: boolean }> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const out: Array<{ table: string; column: string; nullable: boolean }> = [];
  for (const { name } of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{ table: string; from: string }>;
    for (const fk of fks) {
      if (fk.table !== target) continue;
      const col = columns(db, name).find((c) => c.name === fk.from);
      out.push({ table: name, column: fk.from, nullable: !col?.notnull });
    }
  }
  return out;
}

function inList(ids: string[]): { sql: string; params: SQLInputValue[] } {
  return { sql: `(${ids.map(() => "?").join(", ")})`, params: ids };
}

function deleteTasks(db: DbLike, ids: string[]): void {
  if (!ids.length) return;
  const list = inList(ids);
  if (hasColumn(db, "tasks", "source_task_id")) {
    db.prepare(`UPDATE tasks SET source_task_id = NULL WHERE source_task_id IN ${list.sql}`).run(...list.params);
  }
  for (const ref of referencesTo(db, "tasks")) {
    if (ref.table === "tasks") continue;
    db.prepare(`DELETE FROM "${ref.table}" WHERE "${ref.column}" IN ${list.sql}`).run(...list.params);
  }
  db.prepare(`DELETE FROM tasks WHERE id IN ${list.sql}`).run(...list.params);
}

function deleteAgents(db: DbLike, ids: string[]): void {
  if (!ids.length) return;
  const list = inList(ids);
  for (const ref of referencesTo(db, "agents")) {
    const sql = ref.nullable
      ? `UPDATE "${ref.table}" SET "${ref.column}" = NULL WHERE "${ref.column}" IN ${list.sql}`
      : `DELETE FROM "${ref.table}" WHERE "${ref.column}" IN ${list.sql}`;
    db.prepare(sql).run(...list.params);
  }
  for (const [table, column] of AGENT_OWNED_ROWS) {
    if (hasColumn(db, table, column)) {
      db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN ${list.sql}`).run(...list.params);
    }
  }
  db.prepare(`DELETE FROM agents WHERE id IN ${list.sql}`).run(...list.params);
}

export function removeOfficePacks(db: DbLike): OfficePackCleanupResult {
  const result: OfficePackCleanupResult = { agents: 0, tasks: 0, droppedTables: [] };
  const packColumnFilter = "COALESCE(NULLIF(workflow_pack_key, ''), 'development') != 'development'";

  const taskIds = hasColumn(db, "tasks", "workflow_pack_key")
    ? (db.prepare(`SELECT id FROM tasks WHERE ${packColumnFilter}`).all() as Array<{ id: string }>).map((r) => r.id)
    : [];
  const agentIds = tableExists(db, "agents")
    ? (
        db
          .prepare(
            `SELECT id FROM agents WHERE id LIKE '%-seed-%'${
              hasColumn(db, "agents", "workflow_pack_key") ? ` OR ${packColumnFilter}` : ""
            }`,
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    : [];

  db.exec("BEGIN");
  try {
    deleteTasks(db, taskIds);
    deleteAgents(db, agentIds);
    for (const table of ["office_pack_departments", "workflow_packs"]) {
      if (tableExists(db, table)) {
        db.exec(`DROP TABLE "${table}"`);
        result.droppedTables.push(table);
      }
    }
    if (tableExists(db, "settings")) {
      const list = inList(PACK_SETTING_KEYS);
      db.prepare(`DELETE FROM settings WHERE key IN ${list.sql}`).run(...list.params);
    }
    if (hasColumn(db, "projects", "default_pack_key")) {
      db.prepare("UPDATE projects SET default_pack_key = 'development' WHERE default_pack_key != 'development'").run();
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  result.agents = agentIds.length;
  result.tasks = taskIds.length;
  return result;
}
