import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createMeetingLeaderSelectionTools } from "./leader-selection.ts";

type AgentRow = {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
};

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      personality TEXT,
      status TEXT NOT NULL,
      department_id TEXT,
      current_task_id TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      cli_provider TEXT,
      oauth_account_id TEXT,
      api_provider_id TEXT,
      api_model TEXT,
      cli_model TEXT,
      cli_reasoning_level TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      project_id TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      target_department_id TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      assignment_mode TEXT NOT NULL DEFAULT 'auto'
    );

    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );
  `);

  return db;
}

function insertLeader(db: DatabaseSync, input: { id: string; dept: string; name?: string; status?: string }): void {
  db.prepare(
    `
      INSERT INTO agents (
        id, name, name_ko, role, personality, status, department_id, current_task_id,
        avatar_emoji, cli_provider, oauth_account_id, api_provider_id, api_model, cli_model, cli_reasoning_level, created_at
      ) VALUES (?, ?, ?, 'team_leader', NULL, ?, ?, NULL, '🤖', 'codex', NULL, NULL, NULL, NULL, NULL, 1)
    `,
  ).run(input.id, input.name ?? input.id, input.name ?? input.id, input.status ?? "idle", input.dept);
}

function buildFindTeamLeader(db: DatabaseSync) {
  return (departmentId: string, candidateAgentIds?: string[] | null): AgentRow | null => {
    if (!departmentId) return null;
    if (Array.isArray(candidateAgentIds)) {
      if (candidateAgentIds.length === 0) return null;
      const placeholders = candidateAgentIds.map(() => "?").join(",");
      return (
        (db
          .prepare(
            `
            SELECT *
            FROM agents
            WHERE department_id = ?
              AND role = 'team_leader'
              AND id IN (${placeholders})
            ORDER BY created_at ASC
            LIMIT 1
          `,
          )
          .get(departmentId, ...candidateAgentIds) as AgentRow | undefined) ?? null
      );
    }
    return (
      (db
        .prepare(
          `
          SELECT *
          FROM agents
          WHERE department_id = ? AND role = 'team_leader'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get(departmentId) as AgentRow | undefined) ?? null
    );
  };
}

describe("meeting leader selection", () => {
  it("includes related department leaders for a manual project even when only the planner is assigned", () => {
    const db = setupDb();
    try {
      db.prepare(
        "INSERT INTO departments (id, sort_order) VALUES ('planning', 1), ('dev', 2), ('design', 3), ('qa', 4)",
      ).run();
      insertLeader(db, { id: "planning-lead", dept: "planning" });
      insertLeader(db, { id: "dev-lead", dept: "dev" });
      insertLeader(db, { id: "design-lead", dept: "design" });
      insertLeader(db, { id: "qa-lead", dept: "qa" });

      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES (?, 'manual')").run("proj-manual");
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run("proj-manual", "planning-lead");
      db.prepare("INSERT INTO tasks (id, title, description, department_id, project_id) VALUES (?, ?, ?, ?, ?)").run(
        "task-manual",
        "Kickoff",
        "Needs design and dev input",
        "planning",
        "proj-manual",
      );

      const tools = createMeetingLeaderSelectionTools({
        db,
        findTeamLeader: buildFindTeamLeader(db),
        detectTargetDepartments: () => ["design", "dev"],
      });
      const leaderIds = tools
        .getTaskReviewLeaders("task-manual", "planning", { minLeaders: 2, includePlanning: true, fallbackAll: true })
        .map((leader) => leader.id);

      expect(leaderIds).toEqual(expect.arrayContaining(["planning-lead", "dev-lead", "design-lead"]));
      expect(leaderIds).not.toContain("qa-lead");
    } finally {
      db.close();
    }
  });
});
