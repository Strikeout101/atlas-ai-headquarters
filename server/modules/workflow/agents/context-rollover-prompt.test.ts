import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompactContextRolloverPrompt, tryBuildCompactInitialTaskPrompt } from "./context-rollover-prompt.ts";

const fixtureRoot = path.resolve(".tmp");
const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (!directory.startsWith(fixtureRoot + path.sep)) throw new Error("Unexpected fixture path");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function projectWithInstructions(contents: string): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "local-instructions-"));
  fixtures.push(directory);
  fs.writeFileSync(path.join(directory, "AGENTS.md"), contents);
  return directory;
}

describe("context rollover prompt", () => {
  it("keeps goal and recent state while bounding a small model's prompt", () => {
    const prompt = buildCompactContextRolloverPrompt(
      {
        taskId: "task-1",
        title: "Finish the feature",
        checkpointText: `Goal: implement feature\n${"prior detail ".repeat(1500)}\nRemaining: run tests`,
        contextWindowTokens: 4096,
        departmentSharedPrompt: "Follow department rules",
        taskToolsPath: "C:/claw-empire/scripts/claw-agent-tool.mjs",
        worktreeBranch: "climpire/task-1",
      },
      (parts) => `${parts.join("\n")}\n[Shared execution policy]`,
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(Math.floor(Math.floor(4096 * 0.65) * 0.85));
    expect(prompt).toContain("Goal: implement feature");
    expect(prompt).toContain("Remaining: run tests");
    expect(prompt).toContain("Follow department rules");
    expect(prompt).toContain("claw-agent-tool.mjs");
    expect(prompt).toContain("Do not commit");
  });

  it("refuses a window too small for mandatory task instructions", () => {
    expect(() =>
      buildCompactContextRolloverPrompt(
        {
          taskId: "task-1",
          title: "Finish",
          checkpointText: "Goal: finish",
          contextWindowTokens: 128,
          worktreeBranch: "climpire/task-1",
        },
        (parts) => parts.join("\n"),
      ),
    ).toThrow("context_rollover_prompt_exceeds_configured_window");
  });
});

describe("initial local prompt", () => {
  it("preserves own-project rules in both initial and rollover prompts", () => {
    const rules = "Keep generated examples offline. Verify documentation links before reporting completion.";
    const input = {
      taskId: "local-task",
      title: "Document usage",
      description: "Write the usage guide.",
      checkpointText: "Continue the guide.",
      worktreeBranch: "climpire/local-task",
      contextWindowTokens: 4096,
      projectPath: projectWithInstructions(rules),
    };
    const initial = tryBuildCompactInitialTaskPrompt(input, (parts) => parts.join("\n"));
    const resumed = buildCompactContextRolloverPrompt(input, (parts) => parts.join("\n"));
    expect(initial).toContain(rules);
    expect(resumed).toContain(rules);
    expect(initial).toContain("[Project instructions]");
  });
  it("falls back when project instructions cannot fit instead of omitting them", () => {
    const base = {
      taskId: "local-task",
      title: "Document usage",
      description: "Write the usage guide.",
      worktreeBranch: "climpire/local-task",
      contextWindowTokens: 4096,
    };
    expect(
      tryBuildCompactInitialTaskPrompt(
        { ...base, projectPath: projectWithInstructions("Mandatory project rule. ".repeat(1000)) },
        (parts) => parts.join("\n"),
      ),
    ).toBeNull();
    expect(
      tryBuildCompactInitialTaskPrompt({ ...base, projectPath: projectWithInstructions("a".repeat(65537)) }, (parts) =>
        parts.join("\n"),
      ),
    ).toBeNull();
  });
  it("preserves the full task and department requirements with context headroom", () => {
    const description = `Beginning requirement. ${"Keep every detail. ".repeat(40)} Final requirement.`;
    const prompt = tryBuildCompactInitialTaskPrompt(
      {
        taskId: "local-task",
        title: "Write documentation",
        description,
        departmentSharedPrompt: "Do not omit department requirements.",
        interruptPrompt: "Owner amendment: include a usage example.",
        worktreeBranch: "climpire/local-task",
        contextWindowTokens: 8192,
      },
      (parts) => parts.join("\n"),
    );
    expect(prompt).toContain(description);
    expect(prompt).toContain("Do not omit department requirements.");
    expect(prompt).toContain("Owner amendment: include a usage example.");
    expect(Buffer.byteLength(prompt!)).toBeLessThanOrEqual(Math.floor(Math.floor(8192 * 0.65) * 0.85));
  });
  it("refuses overflow instead of truncating task requirements", () => {
    expect(
      tryBuildCompactInitialTaskPrompt(
        {
          taskId: "local-task",
          title: "Detailed work",
          description: "Mandatory requirement. ".repeat(1000),
          worktreeBranch: "climpire/local-task",
          contextWindowTokens: 4096,
        },
        (parts) => parts.join("\n"),
      ),
    ).toBeNull();
  });
});
