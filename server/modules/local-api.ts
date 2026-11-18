import { PORT, SESSION_AUTH_TOKEN } from "../config/runtime.ts";

/**
 * Calls this server's own HTTP API with the internal token, so server-side features (the agent gateway, approved
 * record changes) go through exactly the same validation as the routes the app uses.
 */
export async function localApi(
  method: string,
  pathname: string,
  payload?: unknown,
): Promise<{ status: number; result: any }> {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(70_000),
  });
  const result = await response.json().catch(() => ({ error: "invalid_local_response" }));
  return { status: response.status, result };
}
