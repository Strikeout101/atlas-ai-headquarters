import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeModelUpgradeMarker, createModelUpgradeRequest, decideModelUpgrade,
  ensureModelRoutingSchema, getTaskModelRoute, routeTaskModel,
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
    CREATE TABLE api_providers (id TEXT PRIMARY KEY,models_cache TEXT);
    INSERT INTO agents VALUES ('director','Director','codex','strong',NULL,NULL,NULL,'idle');
    INSERT INTO agents VALUES ('worker','Worker','codex','small',NULL,NULL,NULL,'idle');
    INSERT INTO tasks VALUES ('task-1','Repair a difficult bug','Investigate and patch it','worker','planned');
    INSERT INTO settings VALUES ('modelDirectorAgentId','"director"');
    INSERT INTO settings VALUES ('modelRoutingCandidates','{"codex":["small","strong"]}');
  `);
  ensureModelRoutingSchema(db);
  return db;
}

describe("model director routing", () => {
  it("uses only a director-selected configured model and persists it per task", async () => {
    const db = database();
    const run = vi.fn(async () => ({ text: '{"model":"strong","reason":"Complex debugging"}' }));
    const route = await routeTaskModel(db, "task-1", run);
    expect(route).toMatchObject({ agent_id: "worker", model: "strong", source: "director", director_agent_id: "director" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "director" }), expect.any(String), { noTools: true, rawOutput: true, timeoutMs: 60_000 });
    await routeTaskModel(db, "task-1", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("falls back to a configured model if the director returns an unknown ID", async () => {
    const db = database();
    const route = await routeTaskModel(db, "task-1", async () => ({ text: '{"model":"made-up"}' }));
    expect(route).toMatchObject({ model: "small", source: "default" });
  });

  it("lets the director approve or deny a worker upgrade", async () => {
    const db = database();
    await routeTaskModel(db, "task-1", async () => ({ text: '{"model":"small"}' }));
    const approved = createModelUpgradeRequest(db, "task-1", "The smaller model cannot resolve the bug", "strong");
    const result = await decideModelUpgrade(db, String(approved.id), null, "", async () => ({ text: '{"approve":true,"reason":"Needs deeper reasoning"}' }));
    expect(result.status).toBe("approved");
    expect(getTaskModelRoute(db, "task-1")?.model).toBe("strong");

    const denied = createModelUpgradeRequest(db, "task-1", "I want to switch to a smaller model", "small");
    const rejection = await decideModelUpgrade(db, String(denied.id), false, "Keep the current model");
    expect(rejection.status).toBe("denied");
    expect(getTaskModelRoute(db, "task-1")?.model).toBe("strong");
  });

  it("accepts a request marker from the worktree and removes only that marker", () => {
    const db = database();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-model-request-"));
    dirs.push(dir);
    const marker = path.join(dir, ".climpire-model-upgrade.json");
    fs.writeFileSync(marker, JSON.stringify({ reason: "The task needs a stronger model", model: "strong" }));
    const request = consumeModelUpgradeMarker(db, "task-1", dir);
    expect(request?.status).toBe("pending");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
