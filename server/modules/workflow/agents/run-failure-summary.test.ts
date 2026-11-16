import { describe, expect, it } from "vitest";
import { summarizeTaskRunFailure } from "./run-failure-summary.ts";

describe("task startup failure summary", () => {
  it("reports only the current run's curated cause, without leaking provider payloads", () => {
    const log =
      "===== task run start older =====\n[copilot] Error: No GitHub OAuth token found\n" +
      '===== task run start current =====\n{"message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.","access_token":"private-value"}';
    expect(summarizeTaskRunFailure(log)).toContain("Codex rejected model gpt-6.1-sol");
    expect(summarizeTaskRunFailure(log)).not.toMatch(/Copilot|private-value|access_token/);
  });
  it("explains missing sign-in and obsolete model-catalog parsing", () => {
    expect(
      summarizeTaskRunFailure("[copilot] Error: No GitHub OAuth token found. Connect GitHub Copilot first."),
    ).toContain("Copilot is not connected");
    expect(summarizeTaskRunFailure("codex_models_manager::cache: unknown variant `max`")).toContain("Update Codex CLI");
  });
  it("does not copy unknown output into the task summary", () => {
    expect(summarizeTaskRunFailure("failed request with password=private-value")).toBeNull();
  });
});
