import { describe, expect, it } from "vitest";
import { parseCodexModelList } from "./codex-cli-models.ts";

describe("Codex CLI model discovery", () => {
  it("uses the CLI model identifier, excludes hidden models, and preserves new reasoning efforts", () => {
    expect(
      parseCodexModelList({
        data: [
          {
            id: "ui-id",
            model: "account-model",
            displayName: "Account model",
            supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Maximum effort" }],
            defaultReasoningEffort: "max",
          },
          { model: "hidden-model", hidden: true },
          { model: null },
          null,
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        slug: "account-model",
        reasoningLevels: [{ effort: "max", description: "Maximum effort" }],
        defaultReasoningLevel: "max",
      }),
    ]);
  });
  it("does not invent a model list when the installed CLI does not return one", () => {
    expect(parseCodexModelList({ error: "unavailable" })).toEqual([]);
    expect(parseCodexModelList(null)).toEqual([]);
  });
});
