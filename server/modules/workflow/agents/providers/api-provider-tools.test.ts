import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiProviderTools } from "./api-provider-tools.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Ollama coding task runner", () => {
  it("runs the selected local model through OpenCode with worktree tools and preserves failed work", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("host offline")));
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
    const spawnCliAgent = vi.fn((..._args: any[]) => child);
    const handleTaskRunComplete = vi.fn();
    const tools = createApiProviderTools({
      db: { prepare: () => ({ get: () => ({
        id: "homelab", name: "Homelab", type: "ollama", base_url: "http://homelab:11434/v1",
        api_key_enc: null, enabled: 1, models_cache: null, models_cached_at: null,
      }) }) },
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
      "task-1", "homelab", "qwen-small", "Implement the task", "C:\\project\\.climpire-worktrees\\task-1",
      "task.log", new AbortController(), 9001,
    );

    expect(spawnCliAgent).toHaveBeenCalledWith(
      "task-1", "opencode", "Implement the task", "C:\\project\\.climpire-worktrees\\task-1",
      "task.log", "climpire-homelab/qwen-small", undefined, expect.objectContaining({
        OPENCODE_CONFIG_CONTENT: expect.any(String),
      }),
    );
    const config = JSON.parse(spawnCliAgent.mock.calls[0]![7].OPENCODE_CONFIG_CONTENT);
    expect(config.providers["climpire-homelab"].settings.baseURL).toBe("http://homelab:11434/v1");
    expect(config.providers["climpire-homelab"].models["qwen-small"]).toBeDefined();
    expect(config.permission.bash["git commit*"]).toBe("deny");

    child.emit("close", 1);
    await vi.waitFor(() => expect(handleTaskRunComplete).toHaveBeenCalledWith("task-1", 1, "provider_unavailable"));
  });
});
