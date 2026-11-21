import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentTaskToken } from "../../../security/agent-task-token.ts";
import { runAgentWebOperation } from "../../agent-web.ts";
import { registerAgentToolRoutes } from "./agent-tools.ts";

vi.mock("../../agent-web.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent-web.ts")>();
  return { ...actual, runAgentWebOperation: vi.fn(actual.runAgentWebOperation) };
});

const databases: DatabaseSync[] = [];
beforeEach(() => {
  vi.mocked(runAgentWebOperation).mockClear();
});
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_agent_id TEXT, status TEXT);
    INSERT INTO tasks VALUES ('research-task', 'researcher', 'in_progress');`);
  const app = express();
  app.use(express.json());
  registerAgentToolRoutes(app, db, vi.fn());
  return { app, db, token: createAgentTaskToken("research-task", "researcher") };
}

describe("task-scoped public web gateway", () => {
  it("requires a valid task token before invoking web tools", async () => {
    const { app } = harness();
    await request(app).post("/api/agent-tools").send({ operation: "web.search", query: "public research" }).expect(401);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", "forged")
      .send({ operation: "web.search", query: "public research" })
      .expect(401);
    expect(runAgentWebOperation).not.toHaveBeenCalled();
  });

  it("rejects inactive and reassigned tasks before performing web requests", async () => {
    const { app, db, token } = harness();
    db.exec("UPDATE tasks SET status = 'review'");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "web.read", url: "https://example.com" })
      .expect(403);
    db.exec("UPDATE tasks SET status = 'in_progress', assigned_agent_id = 'other'");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "web.search", query: "public research" })
      .expect(403);
    expect(runAgentWebOperation).not.toHaveBeenCalled();
  });

  it("blocks private URLs for active agents with an actionable safe error", async () => {
    const { app, token } = harness();
    const result = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "web.read", url: "http://127.0.0.1:8790/api/settings" })
      .expect(400);
    expect(result.body).toEqual({ error: "web_url_forbidden" });
  });

  it("returns public research through the same gateway used by every CLI", async () => {
    const { app, token } = harness();
    vi.mocked(runAgentWebOperation).mockResolvedValueOnce({
      source: "DuckDuckGo (keyless)",
      query: "public research",
      fetched_at: "2026-11-18T00:00:00.000Z",
      note: "Untrusted reference data",
      results: [{ title: "Research", url: "https://example.com", snippet: "Public facts" }],
    });
    const result = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "web.search", query: "public research" })
      .expect(200);
    expect(result.body).toMatchObject({ ok: true, results: [{ url: "https://example.com" }] });
    // No search key is set, so web.search uses the keyless fallback through the same vetted reader.
    expect(runAgentWebOperation).toHaveBeenCalledWith({ operation: "web.search", query: "public research", limit: 8 });
  });
});
