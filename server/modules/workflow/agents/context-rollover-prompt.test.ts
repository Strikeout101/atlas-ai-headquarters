import { describe, expect, it } from "vitest";
import { buildCompactContextRolloverPrompt } from "./context-rollover-prompt.ts";

describe("context rollover prompt", () => {
  it("keeps goal and recent state while bounding a small model's prompt", () => {
    const prompt = buildCompactContextRolloverPrompt(
      {
        taskId: "task-1",
        title: "Finish the feature",
        checkpointText: `Goal: implement feature\n${"prior detail ".repeat(1500)}\nRemaining: run tests`,
        contextWindowTokens: 4096,
        workflowGuidance: "Follow the coding workflow",
        departmentSharedPrompt: "Follow department rules",
        taskToolsPath: "C:/claw-empire/scripts/claw-agent-tool.mjs",
        worktreeBranch: "climpire/task-1",
      },
      (parts) => `${parts.join("\n")}\n[Shared execution policy]`,
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(Math.floor(4096 * 0.65));
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
