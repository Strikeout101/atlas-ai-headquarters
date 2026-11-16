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
  return env;
}
