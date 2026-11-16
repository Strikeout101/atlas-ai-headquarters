import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { ensureVpAgents } from "./vp-agents.ts";

describe("VP agents migration", () => {
  it("preserves agents, extension columns, task foreign keys and indexes and seeds once", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyBaseSchema(db);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='agents'").get() as { sql: string }).sql;
      db.exec("DROP TABLE agents");
      db.exec(sql.replace("'vp',", ""));
      db.exec(
        "PRAGMA foreign_keys=ON; ALTER TABLE agents ADD COLUMN extension TEXT; CREATE INDEX agent_extension ON agents(extension); INSERT INTO agents(id,name,role,cli_provider,extension) VALUES ('worker','Worker','senior','codex','preserve'); INSERT INTO tasks(id,title,assigned_agent_id) VALUES ('task','Task','worker')",
      );
      ensureVpAgents(db);
      ensureVpAgents(db);
      expect(db.prepare("SELECT extension FROM agents WHERE id='worker'").get()).toMatchObject({
        extension: "preserve",
      });
      expect(
        db.prepare("SELECT role,cli_provider,department_id FROM agents WHERE role='vp' ORDER BY cli_provider").all(),
      ).toEqual([
        { role: "vp", cli_provider: "claude", department_id: null },
        { role: "vp", cli_provider: "codex", department_id: null },
      ]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_extension'").get()).toBeTruthy();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });
});
