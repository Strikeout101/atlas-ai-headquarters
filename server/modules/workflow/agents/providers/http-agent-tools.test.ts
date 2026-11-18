import type { WriteStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgentPerformanceSchema, getAgentPerformanceSummary } from "../../../agent-performance.ts";
import { createHttpAgentTools } from "./http-agent-tools.ts";
import type { DecryptedOAuthToken } from "./types.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function account(id: string, model: string): DecryptedOAuthToken {
  return {
    id,
    provider: "github",
    source: null,
    label: id,
    accessToken: "test-token",
    refreshToken: null,
    expiresAt: null,
    email: null,
    modelOverride: model,
  };
}

function setup(accounts: DecryptedOAuthToken[]) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, assigned_agent_id TEXT);
    INSERT INTO tasks VALUES ('task','worker');
    CREATE TABLE task_model_routes(task_id TEXT, agent_id TEXT, provider TEXT, model TEXT);
    INSERT INTO task_model_routes VALUES ('task','worker','api','wrong-route-model');`);
  ensureAgentPerformanceSchema(db);
  const tools = createHttpAgentTools({
    db,
    logsDir: ".",
    activeProcesses: new Map(),
    broadcast: vi.fn(),
    normalizeStreamChunk: String,
    createSubtaskFromCli: vi.fn(),
    completeSubtaskFromCli: vi.fn(),
    handleTaskRunComplete: vi.fn(),
    setActiveOAuthAccount: vi.fn(),
    getProviderModelConfig: () => ({ copilot: { model: "global-default" }, antigravity: { model: "global-default" } }),
    getOAuthAutoSwapEnabled: () => true,
    getPreferredOAuthAccounts: () => accounts,
    prioritizeOAuthAccount: (items) => items,
    rotateOAuthAccounts: (_provider, items) => items,
    getOAuthAccountDisplayName: (item) => item.id ?? "account",
    exchangeCopilotToken: vi.fn(async () => ({
      token: "test-copilot",
      baseUrl: "https://copilot.example",
      expiresAt: 0,
    })),
    refreshGoogleToken: vi.fn(async () => "test-google"),
    loadCodeAssistProject: vi.fn(async () => "project"),
    markOAuthAccountFailure: vi.fn(),
    markOAuthAccountSuccess: vi.fn(),
    ANTIGRAVITY_ENDPOINTS: ["https://gemini.example"],
  });
  const write = vi.fn(() => true);
  const log = {} as WriteStream;
  return { db, tools, write, log };
}

function copilotResponse() {
  return new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: {"usage":{"prompt_tokens":20,"completion_tokens":5}}\ndata: [DONE]\n',
    { status: 200 },
  );
}

describe("HTTP worker performance attribution", () => {
  it("records each actual Copilot account/model attempt, including failures before fallback", async () => {
    const { db, tools, write, log } = setup([
      account("first", "github-copilot/first-model"),
      account("second", "github-copilot/second-model"),
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(copilotResponse());
    vi.stubGlobal("fetch", fetchMock);
    await tools.executeCopilotAgent("Do work", "/repo", log, new AbortController().signal, "task", null, write);
    const summary = getAgentPerformanceSummary(db);
    expect(summary).toHaveLength(2);
    expect(summary.find((row) => row.model === "first-model")).toMatchObject({
      provider: "copilot",
      failures: 1,
      cost_usd: null,
    });
    expect(summary.find((row) => row.model === "second-model")).toMatchObject({
      provider: "copilot",
      successes: 1,
      rework_runs: 1,
      input_tokens: 20,
      output_tokens: 5,
      cost_usd: null,
    });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).model)).toEqual(["first-model", "second-model"]);
  });

  it("records the actual Antigravity override and final cumulative usage", async () => {
    const { db, tools, write, log } = setup([account("google", "google/antigravity-gemini-override")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            'data: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"thoughtsTokenCount":1}}}\ndata: {"response":{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"thoughtsTokenCount":3}}}\n',
          ),
      ),
    );
    await tools.executeAntigravityAgent("Do work", log, new AbortController().signal, "task", null, write);
    expect(getAgentPerformanceSummary(db)).toEqual([
      expect.objectContaining({
        provider: "antigravity",
        model: "gemini-override",
        runs: 1,
        successes: 1,
        input_tokens: 10,
        output_tokens: 7,
        cost_usd: null,
      }),
    ]);
  });

  it("classifies an explicitly aborted HTTP attempt as cancelled", async () => {
    const { db, tools, write, log } = setup([account("first", "github-copilot/model")]);
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new DOMException("Stopped", "AbortError");
      }),
    );
    await expect(
      tools.executeCopilotAgent("Do work", "/repo", log, controller.signal, "task", null, write),
    ).rejects.toThrow("Stopped");
    expect(getAgentPerformanceSummary(db)).toEqual([
      expect.objectContaining({ cancelled: 1, failures: 0, success_rate: null }),
    ]);
  });
});
