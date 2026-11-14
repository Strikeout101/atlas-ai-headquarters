import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiProviderTools } from "./api-provider-tools.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Ollama coding task runner", () => {
  it("interrupts a completed OpenCode step at 80% and classifies it for rollover", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const spawnCliAgent = vi.fn((..._args: any[]) => child);
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: {
        prepare: (sql: string) => ({
          get: () =>
            sql.includes("context_window_tokens")
              ? { context_window_tokens: 1000 }
              : {
                  id: "local",
                  name: "Local",
                  type: "ollama",
                  base_url: "http://localhost:11434/v1",
                  api_key_enc: null,
                  enabled: 1,
                  models_cache: null,
                  models_cached_at: null,
                },
        }),
      },
      logsDir: ".",
      activeProcesses: new Map(),
      broadcast: vi.fn(),
      normalizeStreamChunk: (chunk) => String(chunk),
      handleTaskRunComplete,
      spawnCliAgent,
      createSafeLogStreamOps: vi.fn() as any,
      parseSSEStream: vi.fn(),
      parseGeminiSSEStream: vi.fn(),
    });
    tools.launchApiProviderAgent(
      "task-1",
      "local",
      "qwen",
      "Do work",
      "C:\\worktree",
      "task.log",
      new AbortController(),
      9001,
    );
    const observe = spawnCliAgent.mock.calls[0]![8] as (chunk: Buffer, stream: "stdout" | "stderr") => void;
    observe(Buffer.from('{"type":"step_finish","part":{"tokens":{"input":750,"output":50}}}\n'), "stdout");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    child.emit("close", 1);
    await vi.waitFor(() => expect(handleTaskRunComplete).toHaveBeenCalledWith("task-1", 1, "context_near_limit"));
  });

  it("recovers a structured context error when usage is unavailable", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const spawnCliAgent = vi.fn((..._args: any[]) => child);
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: {
        prepare: () => ({
          get: () => ({
            id: "local",
            name: "Local",
            type: "ollama",
            base_url: "http://localhost:11434/v1",
            api_key_enc: null,
            enabled: 1,
            models_cache: null,
            models_cached_at: null,
          }),
        }),
      },
      logsDir: ".",
      activeProcesses: new Map(),
      broadcast: vi.fn(),
      normalizeStreamChunk: (chunk) => String(chunk),
      handleTaskRunComplete,
      spawnCliAgent,
      createSafeLogStreamOps: vi.fn() as any,
      parseSSEStream: vi.fn(),
      parseGeminiSSEStream: vi.fn(),
    });
    tools.launchApiProviderAgent(
      "task-1",
      "local",
      "qwen",
      "Do work",
      "C:\\worktree",
      "task.log",
      new AbortController(),
      9001,
    );
    const observe = spawnCliAgent.mock.calls[0]![8] as (chunk: Buffer, stream: "stdout" | "stderr") => void;
    observe(Buffer.from('{"type":"error","error":{"code":"context_length_exceeded"}}\n'), "stdout");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 1);
    await vi.waitFor(() => expect(handleTaskRunComplete).toHaveBeenCalledWith("task-1", 1, "context_exhausted"));
  });

  it("accepts a successful run when OpenCode recovered from its own context error", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const spawnCliAgent = vi.fn((..._args: any[]) => child);
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: {
        prepare: () => ({
          get: () => ({
            id: "local",
            name: "Local",
            type: "ollama",
            base_url: "http://localhost:11434/v1",
            api_key_enc: null,
            enabled: 1,
            models_cache: null,
            models_cached_at: null,
          }),
        }),
      },
      logsDir: ".",
      activeProcesses: new Map(),
      broadcast: vi.fn(),
      normalizeStreamChunk: (chunk) => String(chunk),
      handleTaskRunComplete,
      spawnCliAgent,
      createSafeLogStreamOps: vi.fn() as any,
      parseSSEStream: vi.fn(),
      parseGeminiSSEStream: vi.fn(),
    });
    tools.launchApiProviderAgent(
      "task-1",
      "local",
      "qwen",
      "Do work",
      "C:\\worktree",
      "task.log",
      new AbortController(),
      9001,
    );
    const observe = spawnCliAgent.mock.calls[0]![8] as (chunk: Buffer, stream: "stdout" | "stderr") => void;
    observe(
      Buffer.from('{"type":"session.error","properties":{"error":{"code":"context_length_exceeded"}}}\n'),
      "stdout",
    );
    child.emit("close", 0);
    await vi.waitFor(() => expect(handleTaskRunComplete).toHaveBeenCalledWith("task-1", 0));
  });

  it("runs the selected local model through OpenCode with worktree tools and preserves failed work", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("host offline")));
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const spawnCliAgent = vi.fn((..._args: any[]) => child);
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: {
        prepare: () => ({
          get: () => ({
            id: "homelab",
            name: "Homelab",
            type: "ollama",
            base_url: "http://homelab:11434/v1",
            api_key_enc: null,
            enabled: 1,
            models_cache: null,
            models_cached_at: null,
          }),
        }),
      },
      logsDir: ".",
      activeProcesses: new Map(),
      broadcast: vi.fn(),
      normalizeStreamChunk: (chunk) => String(chunk),
      handleTaskRunComplete,
      spawnCliAgent,
      createSafeLogStreamOps: vi.fn() as any,
      parseSSEStream: vi.fn(),
      parseGeminiSSEStream: vi.fn(),
    });

    tools.launchApiProviderAgent(
      "task-1",
      "homelab",
      "qwen-small",
      "Implement the task",
      "C:\\project\\.climpire-worktrees\\task-1",
      "task.log",
      new AbortController(),
      9001,
    );

    expect(spawnCliAgent).toHaveBeenCalledWith(
      "task-1",
      "opencode",
      "Implement the task",
      "C:\\project\\.climpire-worktrees\\task-1",
      "task.log",
      "climpire-homelab/qwen-small",
      undefined,
      expect.objectContaining({
        OPENCODE_CONFIG_CONTENT: expect.any(String),
      }),
      expect.any(Function),
    );
    const config = JSON.parse(spawnCliAgent.mock.calls[0]![7].OPENCODE_CONFIG_CONTENT);
    expect(config.providers["climpire-homelab"].settings.baseURL).toBe("http://homelab:11434/v1");
    expect(config.providers["climpire-homelab"].models["qwen-small"]).toBeDefined();
    expect(config.permission.bash["git commit*"]).toBe("deny");

    child.emit("close", 1);
    await vi.waitFor(() => expect(handleTaskRunComplete).toHaveBeenCalledWith("task-1", 1, "provider_unavailable"));
  });

  it("ignores a late close from an older run after its replacement starts", () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const replacement = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const activeProcesses = new Map<string, ChildProcess>();
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: {
        prepare: () => ({
          get: () => ({
            id: "local",
            name: "Local",
            type: "ollama",
            base_url: "http://localhost:11434/v1",
            api_key_enc: null,
            enabled: 1,
            models_cache: null,
          }),
        }),
      },
      logsDir: ".",
      activeProcesses,
      broadcast: vi.fn(),
      normalizeStreamChunk: (chunk) => String(chunk),
      handleTaskRunComplete,
      spawnCliAgent: () => child,
      createSafeLogStreamOps: vi.fn() as any,
      parseSSEStream: vi.fn(),
      parseGeminiSSEStream: vi.fn(),
    });
    tools.launchApiProviderAgent("task-1", "local", "qwen", "Do work", "C:\\worktree", "task.log", new AbortController(), 9001);
    activeProcesses.set("task-1", replacement);
    child.emit("close", 0);
    expect(handleTaskRunComplete).not.toHaveBeenCalled();
    expect(activeProcesses.get("task-1")).toBe(replacement);
  });
});
