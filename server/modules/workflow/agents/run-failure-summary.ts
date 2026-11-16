/** Deliberately returns curated messages, never raw provider output or credential-bearing JSON. */
export function summarizeTaskRunFailure(log: string): string | null {
  const output = log.slice(Math.max(0, log.lastIndexOf("===== task run start")));
  if (/No GitHub OAuth token found|Connect GitHub Copilot first/i.test(output)) {
    return "GitHub Copilot is not connected. Connect it in Settings > OAuth or assign a connected provider.";
  }
  const unsupportedModel = output.match(/The ['\\"]([a-zA-Z0-9._/-]{1,100})['\\"] model is not supported/);
  if (unsupportedModel) {
    return `Codex rejected model ${unsupportedModel[1]}. Update the installed Codex CLI, refresh its model list, and choose a model available to its signed-in account.`;
  }
  if (/unknown variant [`'"]max[`'"]/.test(output) && /codex_models_manager/.test(output)) {
    return "The installed Codex CLI cannot read the current model catalog. Update Codex CLI and refresh the model list before retrying.";
  }
  if (
    /Your access token could not be refreshed|Please try signing in again|refresh_token_reused|authentication_required/i.test(
      output,
    )
  ) {
    return "The provider sign-in has expired. Sign in again before retrying this task.";
  }
  if (/usage_limit_reached|usage limit|quota exceeded|insufficient_quota/i.test(output)) {
    return "The provider reported a usage limit. Retry after its allowance resets or select another connected provider.";
  }
  return null;
}
