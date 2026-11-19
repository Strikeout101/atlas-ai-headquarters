import { describe, expect, it, vi } from "vitest";
import { createCliTools } from "./cli-tools.ts";
import { resolveGeminiCommand } from "./gemini-command.ts";

vi.mock("./gemini-command.ts", () => ({ resolveGeminiCommand: vi.fn() }));

function createTools() {
  return createCliTools({
    nowMs: () => 0,
    cliOutputDedupWindowMs: 1000,
  });
}

describe("buildAgentArgs", () => {
  it("uses Antigravity's headless stream protocol for Gemini agents", () => {
    vi.mocked(resolveGeminiCommand).mockReturnValue("agy");
    const tools = createTools();
    expect(tools.buildAgentArgs("gemini", "gemini-3-pro-preview")).toEqual([
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ]);
    expect(tools.buildAgentArgs("gemini", "gemini-4-neon-high", undefined, { noTools: true })).toEqual([
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-4-neon-high",
      "--mode",
      "plan",
    ]);
  });

  it("keeps the legacy Gemini CLI protocol when it is installed instead", () => {
    vi.mocked(resolveGeminiCommand).mockReturnValue("gemini");
    expect(createTools().buildAgentArgs("gemini", "gemini-2.5-pro")).toEqual([
      "gemini",
      "-m",
      "gemini-2.5-pro",
      "--yolo",
      "--output-format=stream-json",
    ]);
  });
  it("claude noTools mode uses --tools= without empty argv", () => {
    const tools = createTools();
    const args = tools.buildAgentArgs("claude", "claude-opus-4-6", undefined, { noTools: true });

    expect(args).toContain("--tools=");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("");
  });
});
