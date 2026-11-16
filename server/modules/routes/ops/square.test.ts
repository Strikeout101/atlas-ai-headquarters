import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureAutonomySchema } from "../../autonomy-store.ts";
import { registerSquareRoutes } from "./square.ts";
import { SESSION_COOKIE_NAME } from "../../../config/runtime.ts";
import { createSessionToken, __resetLoginStoreForTests } from "../../../security/login-sessions.ts";
import { getCsrfToken } from "../../../security/auth.ts";
vi.mock("../../../oauth/helpers.ts", () => ({
  encryptSecret: (s: string) => `sealed:${s}`,
  decryptSecret: (s: string) => s.replace(/^sealed:/, ""),
}));
const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  __resetLoginStoreForTests();
});
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureAutonomySchema(db);
  db.exec("CREATE TABLE business_contacts(id TEXT PRIMARY KEY)");
  const app = express();
  app.use(express.json());
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ locations: [{ id: "loc", name: "Ventures", currency: "USD", status: "ACTIVE" }] })),
  );
  registerSquareRoutes(app, db, { fetch: fetcher });
  return { app, db, fetcher };
}
function owner() {
  return {
    Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken("password"))}`,
    "x-csrf-token": getCsrfToken(),
  };
}
describe("owner-only Square settings and sync", () => {
  it.each(["local", "token"] as const)("refuses %s bootstrap sessions for every mutating operation", async (kind) => {
    const { app, fetcher } = harness();
    const headers = {
      Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(kind))}`,
      "x-csrf-token": getCsrfToken(),
    };
    await request(app).patch("/api/square").set(headers).send({ token: "secret" }).expect(403);
    await request(app).post("/api/square/test").set(headers).send({}).expect(403);
    await request(app).put("/api/square/mappings").set(headers).send({ mappings: [] }).expect(403);
    await request(app).post("/api/square/sync").set(headers).send({}).expect(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an agent token even alongside a password session and rejects missing CSRF", async () => {
    const { app, fetcher } = harness();
    await request(app)
      .post("/api/square/test")
      .set(owner())
      .set("x-agent-task-token", "worker-token")
      .send({})
      .expect(403);
    const headers = owner();
    await request(app).patch("/api/square").set("Cookie", headers.Cookie).send({ token: "secret" }).expect(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("lets the owner save and test without returning plaintext or encrypted secrets", async () => {
    const { app, db, fetcher } = harness();
    const saved = await request(app)
      .patch("/api/square")
      .set(owner())
      .send({ token: "secret-square-token" })
      .expect(200);
    expect(saved.body.connection.token_configured).toBe(true);
    expect(JSON.stringify(saved.body)).not.toMatch(/secret-square-token|sealed:/);
    const tested = await request(app).post("/api/square/test").set(owner()).send({}).expect(200);
    expect(tested.body.connection.locations).toEqual([
      { id: "loc", name: "Ventures", currency: "USD", status: "ACTIVE" },
    ]);
    await request(app)
      .put("/api/square/mappings")
      .set(owner())
      .send({ mappings: [{ business: "ventures", location_id: "loc" }] })
      .expect(200);
    const read = await request(app).get("/api/square").expect(200);
    expect(JSON.stringify(read.body)).not.toMatch(/secret-square-token|sealed:/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT token_enc FROM square_connection").get()).toMatchObject({
      token_enc: "sealed:secret-square-token",
    });
  });
  it("returns only curated provider errors, never credential-bearing provider messages", async () => {
    const { app, fetcher } = harness();
    await request(app).patch("/api/square").set(owner()).send({ token: "secret" }).expect(200);
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ detail: "Bearer secret" }] }), { status: 401 }),
    );
    const response = await request(app).post("/api/square/test").set(owner()).send({}).expect(502);
    expect(response.body).toEqual({ error: "square_http_401" });
  });
});
