import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgentPerformanceSchema, getAgentPerformanceSummary } from "../../../agent-performance.ts";
import { createApiProviderTools } from "./api-provider-tools.ts";
import { createStreamTools } from "./stream-tools.ts";

const resources: Array<{ db: DatabaseSync; dir: string }> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const { db, dir } of resources.splice(0)) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup(type: string) {
  const db = new DatabaseSync(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-api-performance-"));
  resources.push({ db, dir });
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, assigned_agent_id TEXT);
    INSERT INTO tasks VALUES ('task','worker');
    CREATE TABLE api_providers(id TEXT PRIMARY KEY, name TEXT, type TEXT, base_url TEXT,
      api_key_enc TEXT, enabled INTEGER, models_cache TEXT, models_cached_at INTEGER);`);
  db.prepare("INSERT INTO api_providers VALUES ('provider','Provider',?,'https://provider.example',NULL,1,?,0)").run(
    type,
    JSON.stringify(["cached-model"]),
  );
  ensureAgentPerformanceSchema(db);
  const streams = createStreamTools({
    db,
    broadcast: vi.fn(),
    normalizeStreamChunk: String,
    createSubtaskFromCli: vi.fn(),
    completeSubtaskFromCli: vi.fn(),
  });
  const complete = vi.fn();
  const tools = createApiProviderTools({
    db,
    logsDir: dir,
    activeProcesses: new Map(),
    broadcast: vi.fn(),
    normalizeStreamChunk: String,
    handleTaskRunComplete: complete,
    spawnCliAgent: vi.fn(),
    createSafeLogStreamOps: streams.createSafeLogStreamOps,
    parseSSEStream: streams.parseSSEStream,
    parseGeminiSSEStream: streams.parseGeminiSSEStream,
  });
  return { db, dir, tools, complete };
}

describe("API provider structured usage tracking", () => {
  it.each([
    {
      type: "openrouter",
      stream: 'data: {"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.003}}\ndata: [DONE]\n',
      input: 20,
      output: 5,
      cost: 0.003,
    },
    {
      type: "anthropic",
      stream:
        'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":0}}}\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\ndata: {"type":"message_stop"}\n',
      input: 20,
      output: 5,
      cost: null,
    },
    {
      type: "google",
      stream: 'data: {"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"thoughtsTokenCount":2}}\n',
      input: 20,
      output: 7,
      cost: null,
    },
  ])("captures $type usage and the resolved cached model", async ({ type, stream, input, output, cost }) => {
    const { db, dir, tools, complete } = setup(type);
    const fetchMock = vi.fn(async () => new Response(stream));
    vi.stubGlobal("fetch", fetchMock);
    tools.launchApiProviderAgent(
      "task",
      "provider",
      null,
      "Do work",
      "/repo",
      path.join(dir, "task.log"),
      new AbortController(),
      9001,
    );
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith("task", 0, undefined));
    expect(getAgentPerformanceSummary(db)).toEqual([
      expect.objectContaining({
        provider: "api",
        model: "cached-model",
        runs: 1,
        successes: 1,
        input_tokens: input,
        output_tokens: output,
        cost_usd: cost,
      }),
    ]);
  });
});
