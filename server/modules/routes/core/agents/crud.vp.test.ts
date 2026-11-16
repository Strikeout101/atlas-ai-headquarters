import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../bootstrap/schema/base-schema.ts";
import { ensureVpAgents } from "../../../bootstrap/schema/vp-agents.ts";
import { registerAgentCrudRoutes } from "./crud.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureVpAgents(db);
  const app = express();
  app.use(express.json());
  registerAgentCrudRoutes({
    app,
    db,
    broadcast: vi.fn(),
    runInTransaction: (fn: () => unknown) => fn(),
    nowMs: Date.now,
  } as unknown as RuntimeContext);
  return { app, db };
}
describe("VP identity locks", () => {
  it("rejects changing provider, department, or role even through the API", async () => {
    const { app } = harness();
    for (const body of [{ cli_provider: "claude" }, { department_id: "dev" }, { role: "junior" }]) {
      const response = await request(app).patch("/api/agents/atlas-vp-codex").send(body).expect(400);
      expect(response.body.error).toBe("vp_identity_locked");
    }
    await request(app).patch("/api/agents/atlas-vp-codex").send({ name: "Operations VP" }).expect(200);
  });
  it("validates CLI fallback choices and persists an owner-selected fallback", async () => {
    const { app, db } = harness();
    await request(app).patch("/api/agents/atlas-vp-codex").send({ cli_fallback_provider: "gemini" }).expect(400);
    await request(app).patch("/api/agents/atlas-vp-codex").send({ cli_fallback_provider: "claude" }).expect(200);
    expect(db.prepare("SELECT cli_fallback_provider FROM agents WHERE id='atlas-vp-codex'").get()).toMatchObject({
      cli_fallback_provider: "claude",
    });
  });
});
