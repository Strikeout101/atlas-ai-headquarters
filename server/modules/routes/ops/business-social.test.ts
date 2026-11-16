import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCsrfToken } from "../../../security/auth.ts";
import {
  ensureBusinessSocialSchema,
  listSocialAccountsForAgent,
  listInstagramMediaForAgent,
  registerBusinessSocialRoutes,
} from "./business-social.ts";

vi.mock("../../../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => `encrypted:${Buffer.from(value).toString("base64")}`,
  decryptSecret: (value: string) => {
    if (value === "broken") throw new Error("secret-credential-error");
    return Buffer.from(value.replace(/^encrypted:/, ""), "base64").toString();
  },
}));
const fetchMock = vi.fn();
const databases: DatabaseSync[] = [];
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  ensureBusinessSocialSchema(db);
  ensureBusinessSocialSchema(db);
  const app = express();
  app.use(express.json());
  registerBusinessSocialRoutes(app, db);
  return { app, db };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllGlobals();
});
function create(app: express.Express, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/business/social-accounts")
    .set("x-csrf-token", getCsrfToken())
    .send({ business: "rental", platform: "instagram", username: "@PrimroseEvents_", ...body });
}
const testAccount = (app: express.Express, id: string) =>
  request(app).post(`/api/business/social-accounts/${id}/test`).set("x-csrf-token", getCsrfToken());

describe("business social accounts", () => {
  it("stores manual profiles honestly and never contacts a provider without a token", async () => {
    const { app, db } = harness();
    const saved = await create(app).expect(201);
    expect(saved.body.item).toMatchObject({
      username: "primroseevents_",
      has_access_token: false,
      connection_status: "not_connected",
      profile_url: "https://www.instagram.com/primroseevents_/",
    });
    const listed = await request(app).get("/api/business/social-accounts").expect(200);
    expect(listed.body.items).toHaveLength(1);
    await testAccount(app, saved.body.item.id).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSocialAccountsForAgent(db)).toEqual([
      expect.objectContaining({ username: "primroseevents_", connection_status: "not_connected" }),
    ]);
  });
  it("encrypts tokens, preserves them on blank edits, and verifies the exact Instagram username", async () => {
    const { app, db } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    const id = saved.body.item.id;
    expect(saved.body.item.connection_status).toBe("configured");
    expect(JSON.stringify(saved.body)).not.toContain("private-social-token");
    const stored = db.prepare("SELECT token_enc FROM business_social_accounts WHERE id=?").get(id) as {
      token_enc: string;
    };
    expect(stored.token_enc).not.toContain("private-social-token");
    await request(app)
      .patch(`/api/business/social-accounts/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ access_token: "" })
      .expect(200);
    expect(
      (db.prepare("SELECT token_enc FROM business_social_accounts WHERE id=?").get(id) as { token_enc: string })
        .token_enc,
    ).toBe(stored.token_enc);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user_id: "12345", username: "primroseevents_" }),
    });
    const tested = await testAccount(app, id).expect(200);
    expect(tested.body).toMatchObject({
      ok: true,
      item: { connection_status: "verified", provider_user_id: "12345", last_test_ok: true },
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/v27.0/me");
    expect(url.searchParams.get("fields")).toBe("user_id,username");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(options.headers).toEqual({ Authorization: "Bearer private-social-token" });
    expect(options).toMatchObject({ method: "GET", redirect: "error" });
    expect(JSON.stringify(listSocialAccountsForAgent(db))).not.toMatch(
      /private-social-token|token_enc|has_access_token/,
    );
  });
  it("never verifies a token for a different social account", async () => {
    const { app } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ user_id: "12345", username: "other_account" }] }),
    });
    const result = await testAccount(app, saved.body.item.id).expect(200);
    expect(result.body).toMatchObject({
      ok: false,
      error: "social_account_mismatch",
      item: { connection_status: "configured", provider_user_id: null, last_test_ok: false },
    });
  });
  it("redacts provider and network errors instead of returning echoed tokens", async () => {
    const { app } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: "private-social-token", code: 190 } }),
    });
    const result = await testAccount(app, saved.body.item.id).expect(200);
    expect(result.body.error).toBe("social_authorization_or_scope_failed");
    expect(JSON.stringify(result.body)).not.toContain("private-social-token");
    fetchMock.mockRejectedValueOnce(new Error("fetch https://provider/?access_token=private-social-token"));
    const failed = await testAccount(app, saved.body.item.id).expect(200);
    expect(failed.body.error).toBe("social_connection_failed");
    expect(JSON.stringify(failed.body)).not.toContain("private-social-token");
  });
  it("clears verification after profile changes and disconnects/removes accounts", async () => {
    const { app } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    const id = saved.body.item.id;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user_id: "12345", username: "primroseevents_" }),
    });
    await testAccount(app, id).expect(200);
    const renamed = await request(app)
      .patch(`/api/business/social-accounts/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ username: "renamed" })
      .expect(200);
    expect(renamed.body.item).toMatchObject({
      connection_status: "configured",
      provider_user_id: null,
      last_test_at: null,
    });
    const disconnected = await request(app)
      .post(`/api/business/social-accounts/${id}/disconnect`)
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(disconnected.body.item).toMatchObject({ connection_status: "not_connected", has_access_token: false });
    await request(app).delete(`/api/business/social-accounts/${id}`).set("x-csrf-token", getCsrfToken()).expect(200);
    expect((await request(app).get("/api/business/social-accounts").expect(200)).body.items).toEqual([]);
  });
  it("rejects worker configuration, CSRF-less changes and invalid arbitrary request URLs", async () => {
    const { app } = harness();
    await request(app)
      .post("/api/business/social-accounts")
      .send({ business: "rental", platform: "instagram", username: "primroseevents_" })
      .expect(403);
    await request(app).get("/api/business/social-accounts").set("x-agent-task-token", "worker-token").expect(403);
    await create(app, { profile_url: "http://localhost/secrets" }).expect(400);
    await create(app, { platform: "other" }).expect(400);
    await create(app, { username: "https://evil.example" }).expect(400);
    await create(app, { access_token: null }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not mark a replaced credential verified from an in-flight test", async () => {
    const { app } = harness();
    const saved = await create(app, { access_token: "old-token" }).expect(201);
    const id = saved.body.item.id;
    let release!: (value: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = testAccount(app, id).then((response) => response);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await request(app)
      .patch(`/api/business/social-accounts/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ access_token: "new-token" })
      .expect(200);
    release({ ok: true, status: 200, json: async () => ({ user_id: "12345", username: "primroseevents_" }) });
    expect((await pending).status).toBe(409);
    const item = (await request(app).get("/api/business/social-accounts")).body.items[0];
    expect(item.connection_status).toBe("configured");
    expect(item.last_test_ok).toBeNull();
  });
  it("reads one bounded media page with header auth and returns normalized fields only", async () => {
    const { app, db } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    const id = saved.body.item.id;
    db.prepare("UPDATE business_social_accounts SET last_test_ok=1,provider_user_id='12345' WHERE id=?").run(id);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: 15 }, (_, index) => ({
          id: String(100 + index),
          caption: "Unrequested private-social-token",
          media_type: "IMAGE",
          permalink: `https://www.instagram.com/p/post-${index}/?access_token=private-social-token`,
          timestamp: "2026-11-15T12:00:00+0000",
          access_token: "private-social-token",
          unexpected: "do-not-return",
        })),
        paging: { next: "https://evil.example/?access_token=private-social-token" },
      }),
    });
    const response = await request(app).get(`/api/business/social-accounts/${id}/media`).expect(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.items).toHaveLength(10);
    expect(response.body.items[0]).toEqual({
      id: "100",
      caption: null,
      media_type: "IMAGE",
      permalink: "https://www.instagram.com/p/post-0/",
      timestamp: "2026-11-15T12:00:00.000Z",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private-social-token|do-not-return|paging|evil/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/v27.0/12345/media");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("fields")).toBe("id,media_type,permalink,timestamp");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer private-social-token" },
    });
  });
  it("does not read media for planning-only or unverified accounts", async () => {
    const { app, db } = harness();
    const saved = await create(app).expect(201);
    expect(await listInstagramMediaForAgent(db, "missing")).toEqual({ ok: false, error: "social_account_not_found" });
    expect(await listInstagramMediaForAgent(db, saved.body.item.id)).toEqual({
      ok: false,
      error: "social_account_not_verified",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await request(app)
      .get(`/api/business/social-accounts/${saved.body.item.id}/media`)
      .set("x-agent-task-token", "worker")
      .expect(403);
  });
  it("drops unsafe links, malformed media and unexpected fields without exposing credentials", async () => {
    const { app, db } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    const id = saved.body.item.id;
    db.prepare("UPDATE business_social_accounts SET last_test_ok=1,provider_user_id='12345' WHERE id=?").run(id);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "1", media_type: "UNEXPECTED", permalink: "javascript:alert(1)", timestamp: "bad" },
          { id: "2", permalink: "https://evil.example/" },
          { id: "private-social-token" },
          null,
        ],
      }),
    });
    const result = await listInstagramMediaForAgent(db, id);
    expect(result).toEqual({
      ok: true,
      items: [
        { id: "1", caption: null, media_type: null, permalink: null, timestamp: null },
        { id: "2", caption: null, media_type: null, permalink: null, timestamp: null },
      ],
    });
  });
  it("redacts media read failures and rejects a disconnect during the read", async () => {
    const { app, db } = harness();
    const saved = await create(app, { access_token: "private-social-token" }).expect(201);
    const id = saved.body.item.id;
    db.prepare("UPDATE business_social_accounts SET last_test_ok=1,provider_user_id='12345' WHERE id=?").run(id);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: "private-social-token" } }),
    });
    expect(await listInstagramMediaForAgent(db, id)).toEqual({
      ok: false,
      error: "social_authorization_or_scope_failed",
    });
    fetchMock.mockImplementationOnce(async () => {
      db.prepare("UPDATE business_social_accounts SET token_enc='',last_test_ok=NULL WHERE id=?").run(id);
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "1" }] }) };
    });
    expect(await listInstagramMediaForAgent(db, id)).toEqual({
      ok: false,
      error: "social_account_changed_during_read",
    });
  });
});
