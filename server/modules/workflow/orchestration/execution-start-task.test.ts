import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "../../bootstrap/schema/work-model-migration.ts";
import { ensureModelRoutingSchema } from "../../model-routing.ts";
import { resetControlStateForTests } from "../../control-state.ts";
import { createProjectContextTools } from "../core/project-context-tools.ts";
import { createExecutionStartTaskTools } from "./execution-start-task.ts";

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  resetControlStateForTests();
});

function setup() {
  resetControlStateForTests();
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureModelRoutingSchema(db);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-start-"));
  dirs.push(project);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('dev','Development','','','','','#000',2);
    INSERT INTO agents (id,name,role,department_id,cli_provider) VALUES
      ('lead','Charlotte','team_leader','planning','codex'),('senior','Amelia','senior','planning',NULL),
      ('dev-lead','Marcus','team_leader','dev','codex');
  `);
  db.prepare(
    "INSERT INTO projects (id,name,project_path,core_goal,business) VALUES ('p1','Etsy Shop',?,'Sell','ventures')",
  ).run(project);
  db.exec(`
    INSERT INTO tasks (id,title,description,department_id,project_id,status) VALUES
      ('research','Strategy: how to reach the Etsy goal','Find the best products','planning','p1','planned'),
      ('code','Fix the website build','The deploy fails','dev','p1','planned'),
      ('nomodel','Compare competitor prices','Five shops','planning','p1','planned');
  `);
  const spawned: Array<{ taskId: string; provider: string; prompt: string; cwd: string }> = [];
  const createWorktree = vi.fn((_projectPath: string, taskId: string) => {
    const dir = path.join(project, ".climpire-worktrees", taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  const { buildTaskExecutionPrompt } = createProjectContextTools({
    db: db as never,
    isGitRepo: () => false,
    taskWorktrees: new Map(),
  });
  const noop = () => "";
  const tools = createExecutionStartTaskTools({
    nowMs: () => 1_000,
    db: db as never,
    logsDir: project,
    appendTaskLog: () => {},
    broadcast: () => {},
    ensureTaskExecutionSession: (_taskId: string, agentId: string, provider: string) => ({
      sessionId: "s1",
      agentId,
      provider,
    }),
    resolveLang: () => "en",
    notifyTaskStatus: () => {},
    resolveProjectPath: () => project,
    createWorktree,
    getDeptRoleConstraint: noop,
    getRecentConversationContext: noop,
    getTaskContinuationContext: noop,
    getRecentChanges: noop,
    ensureClaudeMd: () => {},
    pickL: (value: unknown) => (Array.isArray(value) ? String(value[0]) : String(value)),
    l: (value: unknown) => value,
    buildAvailableSkillsPromptBlock: noop,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest: () => false,
    getNextHttpAgentPid: () => 1,
    launchApiProviderAgent: () => {},
    launchHttpAgent: () => {},
    getProviderModelConfig: () => ({}),
    spawnCliAgent: (taskId: string, provider: string, prompt: string, cwd: string) => {
      spawned.push({ taskId, provider, prompt, cwd });
      return Object.assign(new EventEmitter(), { pid: 4242 });
    },
    handleTaskRunComplete: () => {},
    notifyCeo: () => {},
    startProgressTimer: () => {},
    runAgentOneShot: vi.fn(async () => ({ text: "{}" })),
  } as never);
  const agent = (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return { db, project, tools, spawned, createWorktree, agent };
}

describe("one start path for every task (work restructure, phase 2)", () => {
  it("runs research in a plain folder with research instructions and no git rules", async () => {
    const { db, project, tools, spawned, createWorktree, agent } = setup();
    const result = await tools.startTaskExecutionForAgent("research", agent("lead"), "planning", "Planning");
    const folder = path.join(project, "operations");
    expect(result).toEqual({
      ok: true,
      cwd: folder,
      worktree: false,
      pid: 4242,
      logPath: path.join(project, "research.log"),
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(folder, ".git"))).toBe(false);
    expect(spawned[0]).toMatchObject({ taskId: "research", provider: "codex", cwd: folder });
    expect(spawned[0].prompt).toContain("[Work type: research]");
    expect(spawned[0].prompt).toContain("task.handoff");
    expect(spawned[0].prompt).not.toContain("Git Workflow Guardrail");
    expect(spawned[0].prompt).not.toContain("MVP Code Review Policy");
    expect(
      db.prepare("SELECT status, work_type, importance, business, work_folder FROM tasks WHERE id='research'").get(),
    ).toEqual({
      status: "in_progress",
      work_type: "research",
      importance: "important",
      business: "ventures",
      work_folder: folder,
    });
  });

  it("gives code work a git worktree and the code rules", async () => {
    const { tools, spawned, createWorktree, agent } = setup();
    const result = await tools.startTaskExecutionForAgent("code", agent("dev-lead"), "dev", "Development");
    expect(result).toMatchObject({ ok: true, worktree: true });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(spawned[0].prompt).toContain("[Work type: code]");
    expect(spawned[0].prompt).toContain("Git Workflow Guardrail");
  });

  it("starts an agent that has no model, after the VPs give it one", async () => {
    const { db, tools, spawned, agent } = setup();
    const result = await tools.startTaskExecutionForAgent("nomodel", agent("senior"), "planning", "Planning");
    expect(result.ok).toBe(true);
    expect(spawned[0].provider).toBe("codex");
    expect(db.prepare("SELECT cli_provider FROM agents WHERE id='senior'").get()).toEqual({ cli_provider: "codex" });
  });

  it("reports why it did not start", async () => {
    const { db, tools, spawned, agent } = setup();
    const { ensureControlStateSchema, setControlMode } = await import("../../control-state.ts");
    ensureControlStateSchema(db as never);
    setControlMode(db as never, "stopped", 1);
    const result = await tools.startTaskExecutionForAgent("research", agent("lead"), "planning", "Planning");
    expect(result).toEqual({ ok: false, error: "the owner stopped everything" });
    expect(spawned).toEqual([]);
  });
});
