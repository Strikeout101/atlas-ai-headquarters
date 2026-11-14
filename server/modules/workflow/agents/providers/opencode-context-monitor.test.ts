import { describe, expect, it, vi } from "vitest";
import { createOpenCodeContextMonitor } from "./opencode-context-monitor.ts";

describe("OpenCode context monitor", () => {
  it("rolls over after a completed step reaches 80% of a configured window", () => {
    const onNearLimit = vi.fn();
    const monitor = createOpenCodeContextMonitor({ contextWindowTokens: 1000, onNearLimit });
    monitor.ingest('{"type":"step_finish","part":{"tokens":{"input":700,', "stdout");
    monitor.ingest('"output":99}}}\n', "stdout");
    expect(onNearLimit).not.toHaveBeenCalled();
    monitor.ingest('{"type":"step_finish","part":{"tokens":{"input":750,"output":50}}}\n', "stdout");
    expect(onNearLimit).toHaveBeenCalledTimes(1);
    expect(monitor.reason).toBe("near_limit");
    expect(monitor.latestTokens).toBe(800);
  });

  it("recognizes a structured context error without a configured window", () => {
    const monitor = createOpenCodeContextMonitor();
    monitor.ingest(
      '{"type":"error","error":{"name":"ContextLengthExceededError","message":"maximum context length exceeded"}}\n',
      "stdout",
    );
    expect(monitor.reason).toBe("context_exhausted");
  });

  it("leaves a final completed step alone even when it used most of the window", () => {
    const onNearLimit = vi.fn();
    const monitor = createOpenCodeContextMonitor({ contextWindowTokens: 1000, onNearLimit });
    monitor.ingest(
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":900,"output":20}}}\n',
      "stdout",
    );
    expect(monitor.latestTokens).toBe(920);
    expect(monitor.reason).toBeNull();
    expect(onNearLimit).not.toHaveBeenCalled();
  });

  it("does not confuse tool output or unrelated errors with context exhaustion", () => {
    const monitor = createOpenCodeContextMonitor({ contextWindowTokens: 1000 });
    monitor.ingest('{"type":"tool_result","output":"context length exceeded","tokens":{"input":900}}\n', "stdout");
    monitor.ingest('{"type":"error","error":{"message":"permission denied"}}\n', "stdout");
    expect(monitor.reason).toBeNull();
    expect(monitor.latestTokens).toBeNull();
  });
});
