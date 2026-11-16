import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { removeOfficePacks } from "./remove-office-packs.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, default_pack_key TEXT NOT NULL DEFAULT 'development');
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, workflow_pack_key TEXT NOT NULL DEFAULT 'development');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, assigned_agent_id TEXT REFERENCES agents(id),
      source_task_id TEXT, workflow_pack_key TEXT NOT NULL DEFAULT 'development');
    CREATE TABLE subtasks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      assigned_agent_id TEXT REFERENCES agents(id));
    CREATE TABLE task_logs (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), message TEXT);
    CREATE TABLE project_agents (project_id TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE);
    CREATE TABLE homelab_ssh_grants (target_id TEXT, agent_id TEXT);
    CREATE TABLE office_pack_departments (workflow_pack_key TEXT, department_id TEXT);
    CREATE TABLE workflow_packs (key TEXT PRIMARY KEY);

    INSERT INTO settings VALUES ('officeWorkflowPack', '"novel"'), ('officePackProfiles', '{}'),
      ('officePackHydratedPacks', '["novel"]'), ('officePackSeedAgentsInitialized', 'true'), ('language', '"en"');
    INSERT INTO projects VALUES ('p-dev', 'development'), ('p-novel', 'novel');
    INSERT INTO agents VALUES ('marcus', 'Marcus', 'development'), ('novel-seed-1', 'Yuna', 'novel'),
      ('report-seed-2', 'Aria', 'development');
    INSERT INTO tasks VALUES ('t-dev', 'Fix build', 'marcus', NULL, 'development'),
      ('t-dev-by-pack-agent', 'Shared work', 'novel-seed-1', NULL, 'development'),
      ('t-novel', 'Chapter one', 'novel-seed-1', NULL, 'novel'),
      ('t-child', 'Follow-up', 'marcus', 't-novel', 'development');
    INSERT INTO subtasks VALUES ('s-dev', 't-dev', 'novel-seed-1'), ('s-novel', 't-novel', 'novel-seed-1');
    INSERT INTO task_logs (task_id, message) VALUES ('t-dev', 'kept'), ('t-novel', 'gone');
    INSERT INTO project_agents VALUES ('p-dev', 'marcus'), ('p-dev', 'report-seed-2');
    INSERT INTO homelab_ssh_grants VALUES ('host', 'novel-seed-1'), ('host', 'marcus');`);
  return db;
}

const ids = (db: DatabaseSync, sql: string) => (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);

describe("removeOfficePacks", () => {
  it("deletes pack agents and pack tasks, keeps main-office work, and leaves no broken references", () => {
    const db = harness();
    expect(removeOfficePacks(db)).toEqual({
      agents: 2,
      tasks: 1,
      droppedTables: ["office_pack_departments", "workflow_packs"],
    });

    expect(ids(db, "SELECT id FROM agents")).toEqual(["marcus"]);
    expect(ids(db, "SELECT id FROM tasks ORDER BY id")).toEqual(["t-child", "t-dev", "t-dev-by-pack-agent"]);
    expect(db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = 't-dev-by-pack-agent'").get()).toEqual({
      assigned_agent_id: null,
    });
    expect(db.prepare("SELECT source_task_id FROM tasks WHERE id = 't-child'").get()).toEqual({ source_task_id: null });
    expect(db.prepare("SELECT id, assigned_agent_id FROM subtasks").all()).toEqual([
      { id: "s-dev", assigned_agent_id: null },
    ]);
    expect(db.prepare("SELECT message FROM task_logs").all()).toEqual([{ message: "kept" }]);
    expect(db.prepare("SELECT agent_id FROM project_agents").all()).toEqual([{ agent_id: "marcus" }]);
    expect(db.prepare("SELECT agent_id FROM homelab_ssh_grants").all()).toEqual([{ agent_id: "marcus" }]);
    expect(db.prepare("SELECT key FROM settings").all()).toEqual([{ key: "language" }]);
    expect(db.prepare("SELECT DISTINCT default_pack_key FROM projects").all()).toEqual([
      { default_pack_key: "development" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does nothing the second time", () => {
    const db = harness();
    removeOfficePacks(db);
    expect(removeOfficePacks(db)).toEqual({ agents: 0, tasks: 0, droppedTables: [] });
  });
});
