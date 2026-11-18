import { describe, expect, it } from "vitest";
import { parseDecisionRequest } from "./decision-request";

describe("parseDecisionRequest", () => {
  it("parses multiline options where text continues on next line", () => {
    const content = [
      "A conflict was found during the work. Options to proceed:",
      "1.",
      "Continue QA on the current state",
      "2.",
      "Clean up the base commit/branch, then run QA",
    ].join("\n");

    const parsed = parseDecisionRequest(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.options).toEqual([
      { number: 1, label: "Continue QA on the current state" },
      { number: 2, label: "Clean up the base commit/branch, then run QA" },
    ]);
  });

  it("parses inline English options", () => {
    const content = [
      "Decision needed. Choose one option:",
      "1) Continue QA on current workspace",
      "2) Reset to baseline branch and rerun QA",
    ].join("\n");

    const parsed = parseDecisionRequest(content);
    expect(parsed?.options).toEqual([
      { number: 1, label: "Continue QA on current workspace" },
      { number: 2, label: "Reset to baseline branch and rerun QA" },
    ]);
  });

  it("returns null for normal numbered notes without decision hints", () => {
    const content = ["Today TODO", "1. run lint", "2. run tests", "3. check the build"].join("\n");

    expect(parseDecisionRequest(content)).toBeNull();
  });
});
