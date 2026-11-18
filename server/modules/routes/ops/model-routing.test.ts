import express from "express";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerModelRoutingRoutes } from "./model-routing.ts";
import { ensureModelRoutingSchema } from "../../model-routing.ts";

vi.mock("../../../security/auth.ts", () => ({
  shouldRequireCsrf: () => false,
  hasValidCsrfToken: () => true,
  requireOwnerSession: () => true,
}));
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));
async function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,cli_provider TEXT,status TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY);
    CREATE TABLE api_providers(id TEXT PRIMARY KEY,name TEXT,type TEXT,enabled INTEGER,models_cache TEXT);
    INSERT INTO agents VALUES ('tech','Technical lead','codex','idle'),('design','Design lead','claude','idle');
    INSERT INTO api_providers VALUES ('local','Precision','ollama',1,'["qwen"]');`);
  ensureModelRoutingSchema(db);
  const app = express();
  app.use(express.json());
  registerModelRoutingRoutes(app, db, async () => ({ text: "{}" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  cleanups.push(() => {
    server.close();
    db.close();
  });
  const payload = {
    directorAgentId: null,
    technicalDirectorAgentId: "tech",
    designDirectorAgentId: "design",
    candidates: { codex: ["small"] },
    localRouting: {
      enabled: true,
      apiProviderId: "local",
      model: "qwen",
      taskTypes: ["documentation"],
      contextWindowTokens: 4096,
    },
  };
  const url = `http://127.0.0.1:${address.port}/api/model-director`;
  return {
    db,
    payload,
    get: () => fetch(url),
    put: (body: unknown) =>
      fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

describe("model director settings", () => {
  it("saves separate directors and a discovered local route and reads back redacted metadata", async () => {
    const { payload, get, put } = await harness();
    expect((await put(payload)).status).toBe(200);
    const result = (await (await get()).json()) as { localProviders: Array<Record<string, unknown>> };
    expect(result).toMatchObject({
      technicalDirectorAgentId: "tech",
      designDirectorAgentId: "design",
      localRouting: payload.localRouting,
      localProviders: [{ id: "local", name: "Precision", models: ["qwen"], enabled: true }],
      performance: [],
    });
    expect(result.localProviders[0]).not.toHaveProperty("base_url");
    expect(result.localProviders[0]).not.toHaveProperty("api_key_enc");
  });
  it("rejects an unknown local model without saving partial settings", async () => {
    const { db, payload, put } = await harness();
    const response = await put({ ...payload, localRouting: { ...payload.localRouting, model: "invented" } });
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });
  it("rejects development kinds and non-director providers", async () => {
    const { db, payload, put } = await harness();
    expect(
      (await put({ ...payload, localRouting: { ...payload.localRouting, taskTypes: ["development"] } })).status,
    ).toBe(400);
    db.exec("INSERT INTO agents VALUES ('local-worker','Local worker','api','idle')");
    expect((await put({ ...payload, designDirectorAgentId: "local-worker" })).status).toBe(400);
  });
  it("keeps specialist and local settings when an older client updates legacy fields", async () => {
    const { payload, put, get } = await harness();
    await put(payload);
    expect((await put({ directorAgentId: "tech", candidates: {} })).status).toBe(200);
    expect(await (await get()).json()).toMatchObject({
      directorAgentId: "tech",
      technicalDirectorAgentId: "tech",
      designDirectorAgentId: "design",
      localRouting: payload.localRouting,
    });
  });
});
