import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_AUTH_TOKEN } from "../config/runtime.ts";

type Claims = { taskId: string; agentId: string; expiresAt: number };

function sign(payload: string): string {
  return createHmac("sha256", SESSION_AUTH_TOKEN).update(`agent-tools-v1:${payload}`).digest("base64url");
}

export function createAgentTaskToken(taskId: string, agentId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ taskId, agentId, expiresAt: now + 8 * 60 * 60 * 1000 })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

export function verifyAgentTaskToken(token: string, now = Date.now()): Claims | null {
  if (token.length > 2048) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
    if (
      typeof claims.taskId !== "string" ||
      !claims.taskId ||
      typeof claims.agentId !== "string" ||
      !claims.agentId ||
      typeof claims.expiresAt !== "number" ||
      claims.expiresAt <= now ||
      claims.expiresAt > now + 8 * 60 * 60 * 1000
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}
