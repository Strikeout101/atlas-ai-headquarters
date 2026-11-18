/** Defense in depth: workers receive task credentials, never owner credentials. */
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of [
    "API_AUTH_TOKEN",
    "SESSION_AUTH_TOKEN",
    "SESSION_SECRET",
    "OAUTH_ENCRYPTION_SECRET",
    "INBOX_WEBHOOK_SECRET",
  ])
    delete env[key];
  env.CLAW_EMPIRE_AGENT_PROCESS = "1";
  // No git credentials: the credential helper (the owner's own GitHub login) is switched off and git may not prompt,
  // so an agent's own `git push` fails. Reviewed work is pushed by ATLAS with the project's account.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  return env;
}
