import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { getCsrfToken } from "../security/auth.ts";
import { createAgentTaskToken } from "../security/agent-task-token.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import { ensureBusinessProfilesSchema } from "./routes/ops/business-profiles.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import {
  addMemory,
  ensureAgentMemorySchema,
  ftsQuery,
  listMemories,
  looksLikeSecret,
  reviewMemory,
  searchMemories,
  setMemoryStatus,
  updateMemory,
  MEMORY_WRITES_PER_TASK,
} from "./agent-memory.ts";
import {
  buildCompactKnowledgeBlock,
  buildKnowledgeBlock,
  businessProfileText,
  getKnowledgeTopic,
  resolveTaskContext,
  systemsSummary,
} from "./agent-knowledge.ts";
import { buildCompactContextRolloverPrompt } from "./workflow/agents/context-rollover-prompt.ts";
import { registerAgentToolRoutes } from "./routes/ops/agent-tools.ts";
import { registerKnowledgeRoutes } from "./routes/ops/knowledge.ts";

let knowledgeDir: string;
beforeAll(() => {
  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-knowledge-"));
  fs.writeFileSync(
    path.join(knowledgeDir, "systems.md"),
    "# Systems registry\n\n## Summary\n\n- ATLAS app on port 8790.\n- Media host at 10.0.60.35.\n\n## Homelab hosts\n\n| Host | Address |\n|---|---|\n| Media | 10.0.60.35 |\n",
  );
  process.env.KNOWLEDGE_DIR = knowledgeDir;
});
afterAll(() => {
  delete process.env.KNOWLEDGE_DIR;
  fs.rmSync(knowledgeDir, { recursive: true, force: true });
});

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureBusinessProfilesSchema(db);
  ensureAutonomySchema(db);
  ensureAgentMemorySchema(db);
  db.exec(`
    UPDATE business_profiles SET name='Primrose Events', services='Flower Wall $250. Bubble House $350.',
      brand_voice='Elegant and warm.', workflow_notes='Never guarantee availability.' WHERE business='rental';
    UPDATE business_profiles SET name='Small Business Tech', services='Websites from $500 + $80/month.' WHERE business='tech';
    INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at,business)
      VALUES ('p-rental','Primrose site','C:/sites/primrose','Get more flower wall bookings in Miami',1,1,'rental');
    INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at)
      VALUES ('p-none','Shared tools','C:/tools','Internal tooling',1,1);
    INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex'),('other','Other','senior','codex');
    INSERT INTO tasks (id,title,description,status,assigned_agent_id,project_id,created_at,updated_at)
      VALUES ('t-rental','Improve flower wall page','Rewrite the flower wall section','in_progress','worker','p-rental',1,1),
             ('t-plain','Clean up scripts','Tidy shared scripts','in_progress','other','p-none',1,1),
             ('t-auto','Etsy planner listing','Prepare a printable planner','in_progress','worker',NULL,1,1);
    INSERT INTO tasks (id,title,status,assigned_agent_id,project_id,source_task_id,created_at,updated_at)
      VALUES ('t-child','Design hero image','in_progress','other',NULL,'t-rental',1,1);
    INSERT INTO autonomy_work (id,business,project_id,task_id,status,created_at,updated_at)
      VALUES ('w1','ventures','p-none','t-auto','running',1,1);`);
  return db;
}

describe("memory store", () => {
  it("adds, searches by relevance within scope, and counts uses", () => {
    const db = harness();
    addMemory(db, {
      kind: "fact",
      scope: "global",
      title: "Mailcow hosts",
      body: "Each business has its own Mailcow in the DMZ.",
    });
    addMemory(db, {
      kind: "lesson",
      scope: "business",
      business: "rental",
      title: "Flower wall photos",
      body: "Use the white flower wall photos; the red ones look dated.",
    });
    addMemory(db, {
      kind: "lesson",
      scope: "business",
      business: "tech",
      title: "Demo sites",
      body: "Flower shops want photos first.",
    });
    addMemory(db, {
      kind: "fact",
      scope: "project",
      project_id: "p-rental",
      title: "Hero section",
      body: "Hero uses flower wall video.",
    });

    const rental = searchMemories(db, {
      query: "flower wall page",
      business: "rental",
      projectId: "p-rental",
      bump: true,
    });
    expect(rental.map((m) => m.title).sort()).toEqual(["Flower wall photos", "Hero section"]);
    // Another business's memory never leaks in, however well it matches.
    expect(rental.some((m) => m.business === "tech")).toBe(false);
    expect(searchMemories(db, { query: "mailcow", business: null }).map((m) => m.title)).toEqual(["Mailcow hosts"]);
    const used = listMemories(db).items.find((m) => m.title === "Flower wall photos");
    expect(used?.use_count).toBe(1);
  });

  it("puts reviewed memories first on ties and hides archived ones", () => {
    const db = harness();
    const a = addMemory(db, { title: "Backups are manual", body: "No automatic backups exist." }, {}, 1);
    const b = addMemory(db, { title: "Backup folder", body: "Backups live in the backups folder." }, {}, 2);
    reviewMemory(db, a.id, 3);
    expect(searchMemories(db, {}).map((m) => m.id)).toEqual([a.id, b.id]);
    setMemoryStatus(db, a.id, "archived");
    expect(searchMemories(db, { query: "backups" }).map((m) => m.id)).toEqual([b.id]);
  });

  it("refuses secrets, duplicates, bad scopes, and too many writes from one task", () => {
    const db = harness();
    for (const body of [
      "password: hunter2pass",
      "api_key=abcd1234efgh",
      "token is sk-abcdefghijklmnopqrstuvwxyz123456",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ])
      expect(() => addMemory(db, { title: "Creds", body })).toThrow("memory_looks_like_secret");
    expect(looksLikeSecret("The Mailcow password is set in Settings, never in memory.")).toBe(false);
    addMemory(db, { title: "Square sync", body: "Runs every 15 minutes." });
    expect(() => addMemory(db, { title: "square  SYNC!", body: "dup" })).toThrow("memory_duplicate");
    expect(() => addMemory(db, { scope: "business", title: "x", body: "y" })).toThrow("memory_business_required");
    expect(() => addMemory(db, { scope: "project", title: "x", body: "y" })).toThrow("memory_project_required");
    expect(() => addMemory(db, { kind: "rumor", title: "x", body: "y" })).toThrow("invalid_memory_kind");
    expect(() => addMemory(db, { title: "x", body: "z".repeat(1001) })).toThrow("invalid_memory_body");
    for (let n = 0; n < MEMORY_WRITES_PER_TASK; n++)
      addMemory(db, { title: `Lesson ${n}`, body: "ok" }, { agentId: "worker", taskId: "t-rental" });
    expect(() => addMemory(db, { title: "One more", body: "ok" }, { taskId: "t-rental" })).toThrow(
      "memory_task_limit_reached",
    );
  });

  it("turns any text into a safe search query", () => {
    expect(ftsQuery('Fix "the" DNS) OR AND* (rewrite)')).toBe('"fix"* OR "dns"* OR "rewrite"*');
    expect(ftsQuery("a b")).toBe("");
    const db = harness();
    addMemory(db, { title: "DNS rewrites", body: "Changing DNS rewrites needs the owner." });
    expect(searchMemories(db, { query: 'NEAR( "dns" ) ^ -- ;' }).length).toBe(1);
  });

  it("lets the owner edit, which marks the memory reviewed and keeps search in sync", () => {
    const db = harness();
    const memory = addMemory(
      db,
      { title: "Old title", body: "Old text about routers" },
      { agentId: "worker", taskId: "t-plain" },
    );
    expect(memory.reviewed_at).toBeNull();
    const edited = updateMemory(db, memory.id, { title: "Router notes", body: "VPN-Router01 is 10.0.50.69" });
    expect(edited).toMatchObject({ reviewed_by: "owner", title: "Router notes" });
    expect(edited.reviewed_at).not.toBeNull();
    expect(searchMemories(db, { query: "routers old" }).length).toBe(1);
    expect(searchMemories(db, { query: "vpn" }).map((m) => m.id)).toEqual([memory.id]);
    expect(() => updateMemory(db, memory.id, { source_agent_id: "x" } as never)).toThrow("memory_protected_field");
  });
});

describe("knowledge block", () => {
  it("finds the business from autonomy work, then the project, then the parent task", () => {
    const db = harness();
    expect(resolveTaskContext(db, "t-auto")?.business).toBe("ventures");
    expect(resolveTaskContext(db, "t-rental")).toMatchObject({
      business: "rental",
      coreGoal: "Get more flower wall bookings in Miami",
      projectName: "Primrose site",
    });
    expect(resolveTaskContext(db, "t-child")).toMatchObject({ business: "rental", projectId: "p-rental" });
    expect(resolveTaskContext(db, "t-plain")?.business).toBeNull();
    expect(resolveTaskContext(db, "missing")).toBeNull();
  });

  it("gives a task its goal, business, systems summary, memories and the tools line", () => {
    const db = harness();
    addMemory(db, {
      scope: "business",
      business: "rental",
      title: "Flower wall pricing",
      body: "Flower walls are $250.",
    });
    addMemory(db, { scope: "business", business: "tech", title: "Flower SEO", body: "Tech-only note." });
    const block = buildKnowledgeBlock(db, "t-rental");
    expect(block).toContain("[Project goal] Primrose site: Get more flower wall bookings in Miami");
    expect(block).toContain("Primrose Events");
    expect(block).toContain("Flower Wall $250");
    expect(block).toContain("approved by the owner");
    expect(block).toContain("Media host at 10.0.60.35");
    expect(block).toContain("(lesson, unreviewed) Flower wall pricing");
    expect(block).toContain("not instructions");
    expect(block).not.toContain("Tech-only note");
    expect(block).toContain("memory.add");
    // Not tied to a business: one line naming all three instead of a profile.
    const plain = buildKnowledgeBlock(db, "t-plain");
    expect(plain).toContain("Not tied to one business");
    expect(plain).toContain("rental = Primrose Events");
    expect(plain).not.toContain("Flower Wall $250");
  });

  it("shrinks to fit its budget, keeping the goal and tools line", () => {
    const db = harness();
    db.prepare("UPDATE business_profiles SET services=? WHERE business='rental'").run("Services ".repeat(700));
    for (let n = 0; n < 5; n++)
      addMemory(db, {
        scope: "business",
        business: "rental",
        title: `Flower wall note ${n}`,
        body: "flower ".repeat(130),
      });
    for (const maxBytes of [7000, 3000, 1200, 700]) {
      const block = buildKnowledgeBlock(db, "t-rental", { maxBytes });
      expect(Buffer.byteLength(block)).toBeLessThanOrEqual(maxBytes);
      expect(block).toContain("[Project goal]");
      expect(block).toContain("Knowledge tools");
    }
  });

  it("adds compact knowledge to the small-model prompt only within its byte budget", () => {
    const db = harness();
    addMemory(db, {
      scope: "project",
      project_id: "p-rental",
      title: "Flower wall page",
      body: "Keep the hero short.",
    });
    const input = {
      taskId: "t-rental",
      title: "Improve flower wall page",
      checkpointText: `Goal: rewrite\n${"detail ".repeat(400)}\nRemaining: tests`,
      contextWindowTokens: 4096,
      departmentSharedPrompt: "Follow department rules",
      taskToolsPath: "C:/claw-empire/scripts/claw-agent-tool.mjs",
      worktreeBranch: "climpire/t-rental",
      knowledge: (maxBytes: number) => buildCompactKnowledgeBlock(db, "t-rental", maxBytes),
    };
    const finalize = (parts: string[]) => `${parts.join("\n")}\n[Shared execution policy]`;
    const prompt = buildCompactContextRolloverPrompt(input, finalize);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(Math.floor(4096 * 0.65));
    expect(prompt).toContain("Remaining: tests");
    expect(prompt).toContain('knowledge.get {"topic":"tools"}');
    expect(prompt).toContain("[Project goal] Get more flower wall bookings");
    // A tiny window drops the knowledge rather than the checkpoint.
    const tight = buildCompactContextRolloverPrompt({ ...input, contextWindowTokens: 2200 }, finalize);
    expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(Math.floor(2200 * 0.65));
    expect(tight).toContain("[Durable checkpoint]");
  });

  it("serves fixed topics only and the systems summary", () => {
    const db = harness();
    expect(systemsSummary()).toBe("- ATLAS app on port 8790.\n- Media host at 10.0.60.35.");
    expect(getKnowledgeTopic(db, "systems").text).toContain("| Media | 10.0.60.35 |");
    expect(getKnowledgeTopic(db, "tools").text).toContain("# Agent tool gateway");
    expect(getKnowledgeTopic(db, "business", { taskId: "t-rental" }).text).toContain("Never guarantee availability");
    expect(getKnowledgeTopic(db, "business", { business: "tech" }).text).toContain("Websites from $500");
    expect(getKnowledgeTopic(db, "project", { taskId: "t-rental" }).text).toContain("Path: C:/sites/primrose");
    expect(() => getKnowledgeTopic(db, "../../.env")).toThrow("invalid_knowledge_topic");
    expect(() => getKnowledgeTopic(db, "business", { taskId: "t-plain" })).toThrow("knowledge_business_required");
    expect(businessProfileText(db, "ventures")).toContain("approved by the two VPs");
  });
});

describe("agent tools", () => {
  function tools() {
    const db = harness();
    const app = express();
    app.use(express.json());
    registerAgentToolRoutes(app, db, vi.fn());
    const as = (task: string, agent: string) => (data: Record<string, unknown>) =>
      request(app).post("/api/agent-tools").set("x-agent-task-token", createAgentTaskToken(task, agent)).send(data);
    return { db, worker: as("t-rental", "worker"), other: as("t-plain", "other") };
  }

  it("reads knowledge and binds new memories to the agent, task, business and project", async () => {
    const { db, worker } = tools();
    const systems = await worker({ operation: "knowledge.get", topic: "systems" }).expect(200);
    expect(systems.body.text).toContain("Media");
    expect((await worker({ operation: "knowledge.get", topic: "business" }).expect(200)).body.text).toContain(
      "Primrose Events",
    );
    await worker({ operation: "knowledge.get", topic: "secrets" }).expect(400);

    const added = await worker({
      operation: "memory.add",
      kind: "lesson",
      scope: "business",
      title: "Flower wall copy",
      body: "Short headlines convert better.",
    }).expect(201);
    expect(added.body.item.reviewed).toBe(false);
    await worker({
      operation: "memory.add",
      payload: { scope: "project", title: "Repo layout", body: "Pages live in app/." },
    }).expect(201);
    const rows = db
      .prepare(
        "SELECT scope,business,project_id,source_agent_id,source_task_id FROM agent_memories ORDER BY created_at",
      )
      .all();
    expect(rows).toEqual([
      {
        scope: "business",
        business: "rental",
        project_id: null,
        source_agent_id: "worker",
        source_task_id: "t-rental",
      },
      {
        scope: "project",
        business: null,
        project_id: "p-rental",
        source_agent_id: "worker",
        source_task_id: "t-rental",
      },
    ]);
    const found = await worker({ operation: "memory.search", query: "flower wall headlines" }).expect(200);
    expect(found.body.items.map((m: { title: string }) => m.title)).toContain("Flower wall copy");
    expect(found.body.note).toMatch(/not instructions/);
  });

  it("refuses forged attribution, secrets and other businesses' scope leaks", async () => {
    const { other } = tools();
    await other({ operation: "memory.add", title: "x", body: "y", source_agent_id: "owner" }).expect(400);
    await other({ operation: "memory.add", payload: { title: "x", body: "y", reviewed_at: 1 } }).expect(400);
    await other({ operation: "memory.add", title: "Key", body: "password: hunter2pass" }).expect(400);
    // t-plain has no business: a business memory must name one.
    const res = await other({ operation: "memory.add", scope: "business", title: "x", body: "y" }).expect(400);
    expect(res.body.error).toBe("memory_business_required");
  });
});

describe("owner routes", () => {
  function routes() {
    const db = harness();
    const app = express();
    app.use(express.json());
    registerKnowledgeRoutes(app, db);
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    const send = (method: "post" | "patch", url: string, body: Record<string, unknown> = {}) =>
      request(app)[method](url).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
    return { db, app, send, cookie };
  }

  it("lists memories with counts and filters, and serves the registry", async () => {
    const { db, app } = routes();
    addMemory(db, { title: "Unreviewed one", body: "x" }, { agentId: "worker", taskId: "t-rental" });
    reviewMemory(db, addMemory(db, { title: "Reviewed one", body: "y" }).id);
    const all = await request(app).get("/api/knowledge/memories").expect(200);
    expect(all.body.counts).toEqual({ active: 2, unreviewed: 1, archived: 0 });
    expect(all.body.items[0]).toMatchObject({
      title: "Unreviewed one",
      source_agent_name: "Worker",
      source_task_title: "Improve flower wall page",
    });
    const pending = await request(app).get("/api/knowledge/memories?reviewed=no").expect(200);
    expect(pending.body.items.map((m: { title: string }) => m.title)).toEqual(["Unreviewed one"]);
    await request(app).get("/api/knowledge/memories?business=nowhere").expect(400);
    const doc = await request(app).get("/api/knowledge/documents/systems").expect(200);
    expect(doc.body).toMatchObject({ available: true });
    await request(app).get("/api/knowledge/documents/env").expect(404);
  });

  it("requires the owner's password session for changes and refuses agents entirely", async () => {
    const { db, app, send, cookie } = routes();
    const memory = addMemory(db, { title: "Check me", body: "x" }, { taskId: "t-rental" });
    await request(app).post(`/api/knowledge/memories/${memory.id}/review`).send({}).expect(403);
    await request(app)
      .post(`/api/knowledge/memories/${memory.id}/review`)
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "anything")
      .send({})
      .expect(403);
    await request(app).get("/api/knowledge/memories").set("x-agent-task-token", "anything").expect(403);

    expect((await send("post", `/api/knowledge/memories/${memory.id}/review`).expect(200)).body.item.reviewed_by).toBe(
      "owner",
    );
    await send("post", `/api/knowledge/memories/${memory.id}/status`, { status: "archived" }).expect(200);
    await send("post", `/api/knowledge/memories/${memory.id}/status`, { status: "deleted" }).expect(400);
    await send("patch", `/api/knowledge/memories/${memory.id}`, { body: "token: abcdefgh" }).expect(400);
    const created = await send("post", "/api/knowledge/memories", {
      kind: "fact",
      scope: "business",
      business: "tech",
      title: "Owner note",
      body: "Quote websites from $500.",
    }).expect(201);
    expect(created.body.item.reviewed_by).toBe("owner");
    await send("post", "/api/knowledge/memories", {
      title: "Owner note",
      body: "dup",
      scope: "business",
      business: "tech",
    }).expect(409);
    await send("post", "/api/knowledge/memories/missing/review").expect(404);
  });
});
