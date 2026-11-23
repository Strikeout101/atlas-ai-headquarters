import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeModelUpgradeMarker,
  configuredLocalTaskProvider,
  createModelUpgradeRequest,
  decideModelUpgrade,
  ensureModelRoutingSchema,
  getTaskModelRoute,
  routeTaskModel,
  ensureRunnableAgent,
} from "./model-routing.ts";

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function database() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY,name TEXT,cli_provider TEXT,cli_model TEXT,api_model TEXT,api_provider_id TEXT,cli_reasoning_level TEXT,status TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,description TEXT,assigned_agent_id TEXT,status TEXT);
    CREATE TABLE api_providers (id TEXT PRIMARY KEY,models_cache TEXT,type TEXT DEFAULT 'ollama',enabled INTEGER DEFAULT 1);
    INSERT INTO agents VALUES ('director','Director','codex','strong',NULL,NULL,NULL,'idle');
    INSERT INTO agents VALUES ('worker','Worker','codex','small',NULL,NULL,NULL,'idle');
    INSERT INTO tasks VALUES ('task-1','Repair a difficult bug','Investigate and patch it','worker','planned');
    INSERT INTO settings VALUES ('modelDirectorAgentId','"director"');
    INSERT INTO settings VALUES ('modelRoutingCandidates','{"codex":["small","strong"]}');
  `);
  db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'general'");
  ensureModelRoutingSchema(db);
  return db;
}

describe("model director routing", () => {
  it("uses only a director-selected configured model and persists it per task", async () => {
    const db = database();
    const run = vi.fn(async () => ({ text: '{"model":"strong","reason":"Complex debugging"}' }));
    const route = await routeTaskModel(db, "task-1", run);
    expect(route).toMatchObject({
      agent_id: "worker",
      model: "strong",
      source: "director",
      director_agent_id: "director",
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "director" }), expect.any(String), {
      noTools: true,
      rawOutput: true,
      timeoutMs: 60_000,
    });
    await routeTaskModel(db, "task-1", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to a configured model if the director returns an unknown ID", async () => {
    const db = database();
    const route = await routeTaskModel(db, "task-1", async () => ({ text: '{"model":"made-up"}' }));
    expect(route).toMatchObject({ model: "small", source: "default" });
  });

  it("uses the design director only for design work, with a legacy fallback", async () => {
    const db = database();
    db.exec("INSERT INTO agents VALUES ('designer','Design Director','claude','sonnet',NULL,NULL,NULL,'idle')");
    db.prepare("INSERT INTO settings VALUES (?,?)").run("designDirectorAgentId", JSON.stringify("designer"));
    db.exec("UPDATE tasks SET task_type='design'");
    const run = vi.fn(async () => ({ text: '{"model":"small"}' }));
    await routeTaskModel(db, "task-1", run);
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "designer" }),
      expect.stringContaining("design model director"),
      expect.any(Object),
    );
    db.exec("UPDATE tasks SET task_type='development'");
    await routeTaskModel(db, "task-1", run, true);
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "director" }),
      expect.stringContaining("technical model director"),
      expect.any(Object),
    );
  });

  it("routes only selected routine kinds to the enabled discovered Ollama model without changing the worker", async () => {
    const db = database();
    db.prepare("INSERT INTO api_providers(id,models_cache) VALUES (?,?)").run(
      "local-host",
      JSON.stringify(["qwen-local"]),
    );
    db.prepare("INSERT INTO settings VALUES (?,?)").run(
      "localModelRouting",
      JSON.stringify({
        enabled: true,
        apiProviderId: "local-host",
        model: "qwen-local",
        taskTypes: ["documentation"],
        contextWindowTokens: 4096,
      }),
    );
    db.exec("UPDATE tasks SET task_type='documentation'");
    const run = vi.fn(async () => ({ text: '{"model":"strong"}' }));
    expect(await routeTaskModel(db, "task-1", run)).toMatchObject({
      provider: "api",
      model: "qwen-local",
      api_provider_id: "local-host",
      context_window_tokens: 4096,
    });
    expect(run).not.toHaveBeenCalled();
    expect(configuredLocalTaskProvider(db, "task-1")).toBe("api");
    expect(db.prepare("SELECT cli_provider,api_provider_id FROM agents WHERE id='worker'").get()).toMatchObject({
      cli_provider: "codex",
      api_provider_id: null,
    });
    expect(await routeTaskModel(db, "task-1", run, true, true)).toMatchObject({
      provider: "codex",
      model: "strong",
      api_provider_id: null,
    });
    await routeTaskModel(db, "task-1", run, true);
    const upgrade = createModelUpgradeRequest(
      db,
      "task-1",
      "Local model cannot complete this documentation task",
      "strong",
    );
    expect(upgrade).toMatchObject({ requested_provider: "codex", requested_model: "strong" });
    await decideModelUpgrade(db, String(upgrade.id), true, "Approved by owner");
    expect(await routeTaskModel(db, "task-1", run)).toMatchObject({
      provider: "codex",
      source: "upgrade",
      api_provider_id: null,
    });
    db.exec("UPDATE tasks SET task_type='development'");
    expect(await routeTaskModel(db, "task-1", run, true)).toMatchObject({
      provider: "codex",
      model: "strong",
      api_provider_id: null,
    });
  });

  it.each(["disabled", "undiscovered", "wrong-provider"])(
    "falls back safely when the local host is %s",
    async (kind) => {
      const db = database();
      db.prepare("INSERT INTO api_providers(id,models_cache,type,enabled) VALUES (?,?,?,?)").run(
        "host",
        JSON.stringify(kind === "undiscovered" ? [] : ["qwen"]),
        kind === "wrong-provider" ? "openai" : "ollama",
        kind === "disabled" ? 0 : 1,
      );
      db.prepare("INSERT INTO settings VALUES (?,?)").run(
        "localModelRouting",
        JSON.stringify({ enabled: true, apiProviderId: "host", model: "qwen", taskTypes: ["documentation"] }),
      );
      db.exec("UPDATE tasks SET task_type='documentation'");
      expect(await routeTaskModel(db, "task-1", async () => ({ text: '{"model":"small"}' }))).toMatchObject({
        provider: "codex",
        model: "small",
      });
      ensureModelRoutingSchema(db);
      expect(getTaskModelRoute(db, "task-1")?.model).toBe("small");
    },
  );

  it("requires explicit VP or owner approval for a worker upgrade", async () => {
    const db = database();
    await routeTaskModel(db, "task-1", async () => ({ text: '{"model":"small"}' }));
    const approved = createModelUpgradeRequest(db, "task-1", "The smaller model cannot resolve the bug", "strong");
    const run = vi.fn(async () => ({ text: '{"approve":true}' }));
    expect((await decideModelUpgrade(db, String(approved.id), null, "", run)).status).toBe("pending");
    expect(run).not.toHaveBeenCalled();
    const result = await decideModelUpgrade(
      db,
      String(approved.id),
      true,
      "Needs deeper reasoning",
      undefined,
      "vp:codex,claude",
    );
    expect(result.decided_by).toBe("vp:codex,claude");
    expect(result.status).toBe("approved");
    expect(getTaskModelRoute(db, "task-1")?.model).toBe("strong");

    const denied = createModelUpgradeRequest(db, "task-1", "I want to switch to a smaller model", "small");
    const rejection = await decideModelUpgrade(db, String(denied.id), false, "Keep the current model");
    expect(rejection.status).toBe("denied");
    expect(getTaskModelRoute(db, "task-1")?.model).toBe("strong");
  });

  it("keeps a local worker on its local model until the fallback provider upgrade is approved", async () => {
    const db = database();
    db.exec("ALTER TABLE agents ADD COLUMN cli_fallback_provider TEXT");
    db.exec(
      "UPDATE agents SET cli_provider='api',api_model='qwen-local',cli_fallback_provider='claude' WHERE id='worker'",
    );
    db.prepare("UPDATE settings SET value=? WHERE key='providerModelConfig'").run("{}");
    db.prepare("INSERT INTO settings VALUES ('providerModelConfig',?)").run(
      JSON.stringify({ claude: { model: "sonnet" } }),
    );
    const run = vi.fn(async () => ({ text: "{}" }));
    const local = await routeTaskModel(db, "task-1", run);
    expect(local).toMatchObject({ provider: "api", model: "qwen-local" });
    const request = createModelUpgradeRequest(db, "task-1", "Local model cannot solve the dependency conflict");
    expect(request).toMatchObject({ requested_provider: "claude", requested_model: "sonnet", status: "pending" });
    expect(getTaskModelRoute(db, "task-1")?.provider).toBe("api");
    await decideModelUpgrade(db, String(request.id), true, "Both VPs approved", undefined, "vp:one,two");
    expect(await routeTaskModel(db, "task-1", run)).toMatchObject({
      provider: "claude",
      model: "sonnet",
      source: "upgrade",
    });
    expect(db.prepare("SELECT cli_provider FROM agents WHERE id='worker'").get()).toMatchObject({
      cli_provider: "api",
    });
    await expect(decideModelUpgrade(db, String(request.id), true, "duplicate")).rejects.toThrow(
      "request_already_decided",
    );
  });

  it("rejects unconfigured cross-provider targets and lets denial close a stale request", async () => {
    const db = database();
    expect(() => createModelUpgradeRequest(db, "task-1", "Need a more powerful model", null, null, "gemini")).toThrow(
      "invalid_upgrade_provider",
    );
    const req = createModelUpgradeRequest(db, "task-1", "Need a more powerful model", "strong");
    db.prepare("UPDATE settings SET value='{}' WHERE key='modelRoutingCandidates'").run();
    expect((await decideModelUpgrade(db, String(req.id), false, "No upgrade necessary")).status).toBe("denied");
  });

  it("accepts a request marker from the worktree and removes only that marker", () => {
    const db = database();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-model-request-"));
    dirs.push(dir);
    const marker = path.join(dir, ".atlas-model-upgrade.json");
    fs.writeFileSync(marker, JSON.stringify({ reason: "The task needs a stronger model", model: "strong" }));
    const request = consumeModelUpgradeMarker(db, "task-1", dir);
    expect(request?.status).toBe("pending");
    expect(fs.existsSync(marker)).toBe(false);
  });
});

type OrgAgent = { id: string; name: string; cli_provider: string | null; department_id: string | null };

describe("VPs keep every agent runnable (work restructure)", () => {
  function org() {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY,name TEXT,role TEXT,department_id TEXT,cli_provider TEXT,cli_model TEXT,
        api_model TEXT,api_provider_id TEXT,cli_reasoning_level TEXT,status TEXT DEFAULT 'idle');
      CREATE TABLE tasks (id TEXT PRIMARY KEY,title TEXT,description TEXT,assigned_agent_id TEXT,status TEXT,task_type TEXT DEFAULT 'general');
      CREATE TABLE api_providers (id TEXT PRIMARY KEY,models_cache TEXT,type TEXT DEFAULT 'ollama',enabled INTEGER DEFAULT 1);
      CREATE TABLE autonomy_ledger (id INTEGER PRIMARY KEY,event TEXT,business TEXT,source_id TEXT,task_id TEXT,message TEXT,created_at INTEGER);
      INSERT INTO agents (id,name,role,department_id,cli_provider,cli_model) VALUES
        ('vp-claude','Claude VP','vp',NULL,'claude',NULL),
        ('lead','Iris','team_leader','design','codex','small'),
        ('senior','Bobby','senior','design',NULL,NULL),
        ('odd','Nova','senior','qa','made-up-cli',NULL);
      INSERT INTO tasks VALUES ('task-1','Make mockups','Three images','lead','planned','general');
      INSERT INTO settings VALUES ('modelRoutingCandidates','{"codex":["small","strong"]}');
    `);
    ensureModelRoutingSchema(db);
    return db;
  }

  it("gives an agent with no model its department partner's provider and logs what the VPs did", () => {
    const db = org();
    const agent = db.prepare("SELECT * FROM agents WHERE id='senior'").get() as OrgAgent;
    const result = ensureRunnableAgent(db, agent, 5);
    expect(result.agent).toMatchObject({ cli_provider: "codex", cli_model: null });
    expect(result.fixed).toBe("VPs set Bobby to codex (from the department partner); it had no model.");
    expect(db.prepare("SELECT cli_provider FROM agents WHERE id='senior'").get()).toEqual({ cli_provider: "codex" });
    expect(db.prepare("SELECT event, source_id, message FROM autonomy_ledger").get()).toEqual({
      event: "vp_model_fix",
      source_id: "senior",
      message: result.fixed,
    });
  });

  it("replaces a provider ATLAS cannot run with a VP's, and leaves working agents alone", () => {
    const db = org();
    const odd = ensureRunnableAgent(db, db.prepare("SELECT * FROM agents WHERE id='odd'").get() as OrgAgent);
    expect(odd.agent.cli_provider).toBe("claude");
    expect(odd.fixed).toContain("from a VP");
    expect(odd.fixed).toContain("'made-up-cli', which can't run");
    const lead = db.prepare("SELECT * FROM agents WHERE id='lead'").get() as OrgAgent;
    expect(ensureRunnableAgent(db, lead)).toEqual({ agent: lead, fixed: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger").get()).toEqual({ n: 1 });
  });

  it("asks a VP to pick the model when no director is configured", async () => {
    const db = org();
    const run = vi.fn(async () => ({ text: '{"model":"strong","reason":"Images need care"}' }));
    const route = await routeTaskModel(db, "task-1", run);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe("vp-claude");
    expect(route).toMatchObject({ model: "strong", source: "director" });
  });
});
