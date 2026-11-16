import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveDirectiveLeaderCandidateScope } from "./directive-leader-scope.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      assignment_mode TEXT NOT NULL DEFAULT 'auto'
    );
    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT
    );
  `);
  return db;
}

function sorted(values: string[] | null): string[] {
  return [...(values ?? [])].sort((a, b) => a.localeCompare(b));
}

describe("resolveDirectiveLeaderCandidateScope", () => {
  it("limits a manual project's directives to its assigned agents in the requested department", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES ('proj-1', 'manual')").run();
      for (const [id, dept] of [
        ["planner-a", "planning"],
        ["planner-b", "planning"],
        ["dev-a", "dev"],
      ]) {
        db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run(id, dept);
      }
      db.prepare(
        "INSERT INTO project_agents (project_id, agent_id) VALUES ('proj-1', 'planner-a'), ('proj-1', 'dev-a')",
      ).run();

      expect(sorted(resolveDirectiveLeaderCandidateScope(db, "proj-1"))).toEqual(["planner-a"]);
      expect(sorted(resolveDirectiveLeaderCandidateScope(db, "proj-1", "dev"))).toEqual(["dev-a"]);
    } finally {
      db.close();
    }
  });

  it("returns null (anyone) when there is no manual project scope", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES ('proj-2', 'auto')").run();
      expect(resolveDirectiveLeaderCandidateScope(db, null)).toBeNull();
      expect(resolveDirectiveLeaderCandidateScope(db, "proj-2")).toBeNull();
    } finally {
      db.close();
    }
  });
});
