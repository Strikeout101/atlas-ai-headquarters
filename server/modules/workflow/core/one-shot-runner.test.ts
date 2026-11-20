import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOneShotRunner } from "./one-shot-runner.ts";
import { abortAllOneShots, resetControlStateForTests } from "../../control-state.ts";
import { prettyStreamJson } from "../../routes/ops/terminal/pretty-stream-json.ts";
import type { AgentRow } from "./conversation-types.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  resetControlStateForTests();
});
afterEach(() => {
  resetControlStateForTests();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const logsDir = fs.mkdtempSync(path.resolve(".tmp", "codex-runner-test-"));
  directories.push(logsDir);
  const child = Object.assign(new EventEmitter(), {
    pid: 2468,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: { write: vi.fn(), end: vi.fn() },
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const killPidTree = vi.fn();
  const executeApiProviderAgent = vi.fn();
  const broadcast = vi.fn();
  const runner = createOneShotRunner({
    logsDir,
    broadcast,
    getProviderModelConfig: () => ({}),
    executeApiProviderAgent,
    executeCopilotAgent: vi.fn(),
    executeAntigravityAgent: vi.fn(),
    killPidTree,
    prettyStreamJson,
    getPreferredLanguage: () => "en",
    normalizeStreamChunk: (raw) => raw.toString(),
    hasStructuredJsonLines: () => true,
    normalizeConversationReply: (raw) => prettyStreamJson(raw),
    buildAgentArgs: () => ["codex", "exec", "--json"],
    withCliPathFallback: (value) => value ?? "",
  });
  const run = (timeoutMs = 1000) =>
    runner.runAgentOneShot({ id: "probe", cli_provider: "codex" } as AgentRow, "Return PROBE_OK", {
      rawOutput: true,
      noTools: true,
      timeoutMs,
      projectPath: logsDir,
    });
  const message = () =>
    child.stdout.emit(
      "data",
      Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"PROBE_OK"}}\n'),
    );
  const terminal = () => child.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
  return { child, run, killPidTree, message, terminal, runner, executeApiProviderAgent, broadcast, logsDir };
}

describe("one-shot worker completion", () => {
  it("forwards API budget attribution without streaming meeting output into the task terminal", async () => {
    const { runner, executeApiProviderAgent, broadcast, logsDir } = setup();
    executeApiProviderAgent.mockImplementation(async (...args: any[]) => args[7]("MEETING_OK"));
    await runner.runAgentOneShot(
      { id: "reviewer", cli_provider: "api", api_provider_id: "local" } as AgentRow,
      "Review",
      { rawOutput: true, noTools: true, projectPath: logsDir, budgetTaskId: "autonomous-task" },
    );
    expect(executeApiProviderAgent).toHaveBeenCalledWith(
      "Review",
      logsDir,
      expect.anything(),
      expect.anything(),
      undefined,
      "local",
      null,
      expect.any(Function),
      undefined,
      "autonomous-task",
    );
    expect(broadcast).not.toHaveBeenCalled();
  });
  it("returns after actual successful exit and completed turn without waiting for inherited pipes", async () => {
    const { child, run, killPidTree, message, terminal } = setup();
    const result = run();
    message();
    terminal();
    child.emit("exit", 0);
    await expect(result).resolves.toEqual({ text: "PROBE_OK" });
    expect(killPidTree).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
  });

  it("retains output but reports a nonzero exit even with a terminal event", async () => {
    const { child, run, message, terminal } = setup();
    const result = run();
    message();
    terminal();
    child.emit("exit", 7);
    child.emit("close", 7);
    await expect(result).resolves.toEqual({ text: "PROBE_OK", error: "codex exited with code 7" });
  });

  it("keeps the normal close path for successful output without a terminal event", async () => {
    const { child, run, message } = setup();
    const result = run();
    message();
    child.emit("exit", 0);
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ text: "PROBE_OK" });
  });

  it("times out a terminal marker without OS exit rather than approving partial output", async () => {
    const { run, killPidTree, message, terminal } = setup();
    const result = run(20);
    message();
    terminal();
    expect((await result).error).toBe("timeout after 20ms");
    expect(killPidTree).toHaveBeenCalledWith(2468);
  });

  it("respects owner stop and ignores later successful events", async () => {
    const { child, run, killPidTree, message, terminal } = setup();
    const result = run();
    message();
    abortAllOneShots();
    terminal();
    child.emit("exit", 0);
    expect((await result).error).toBe("runs_halted_by_owner");
    expect(killPidTree).toHaveBeenCalledWith(2468);
  });
});
