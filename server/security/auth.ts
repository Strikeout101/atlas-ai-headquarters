import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { SESSION_AUTH_TOKEN, SESSION_COOKIE_NAME } from "../config/runtime.ts";
import {
  createSessionToken,
  isPasswordConfigured,
  loginLockRemainingMs,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  recordLoginFailure,
  recordLoginSuccess,
  revokeAllSessions,
  SESSION_REFRESH_WINDOW_MS,
  SESSION_TTL_MS,
  setLoginPassword,
  validateNewPassword,
  verifyLoginPassword,
  verifySessionToken,
  type SessionClaims,
  type SessionKind,
} from "./login-sessions.ts";
import {
  getTrustedNetworkSummary,
  isDirectLocalRequest,
  isTrustedNetworkRequest,
  isTrustedOriginForRequest,
  resolveClientAddress,
  type HeaderReadableRequest,
} from "./network-trust.ts";

export {
  isDirectLocalRequest,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isTrustedNetworkRequest,
  isTrustedOrigin,
  isTrustedOriginForRequest,
  resolveClientAddress,
} from "./network-trust.ts";
export { configureLoginStore } from "./login-sessions.ts";

const CSRF_TOKEN = createHash("sha256").update(`csrf:${SESSION_AUTH_TOKEN}`, "utf8").digest("hex");
const TASK_INTERRUPT_TOKEN_SCOPE = "task_interrupt_v1";

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerValue) return out;
  for (const part of headerValue.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function bearerFromHeader(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function bearerToken(req: Request): string | null {
  return bearerFromHeader(req.header("authorization"));
}

export function getCsrfToken(): string {
  return CSRF_TOKEN;
}

export function csrfTokenFromRequest(req: Request): string | null {
  const raw = req.header("x-csrf-token");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldRequireCsrf(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !bearerToken(req);
}

export function hasValidCsrfToken(req: Request): boolean {
  const token = csrfTokenFromRequest(req);
  if (!token) return false;
  return safeSecretEquals(token, CSRF_TOKEN);
}

export function buildTaskInterruptControlToken(taskId: string, sessionId: string): string {
  const input = `${TASK_INTERRUPT_TOKEN_SCOPE}:${SESSION_AUTH_TOKEN}:${taskId}:${sessionId}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hasValidTaskInterruptControlToken(taskId: string, sessionId: string, providedToken: string): boolean {
  const token = providedToken.trim();
  if (!token) return false;
  const expected = buildTaskInterruptControlToken(taskId, sessionId);
  return safeSecretEquals(token, expected);
}

export function safeSecretEquals(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieFromHeader(raw: string | undefined): string | null {
  const token = parseCookies(raw)[SESSION_COOKIE_NAME];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function cookieToken(req: Request): string | null {
  return cookieFromHeader(req.header("cookie"));
}

function isApiTokenBearer(bearer: string | null): boolean {
  return Boolean(bearer) && safeSecretEquals(bearer as string, SESSION_AUTH_TOKEN);
}

/**
 * The browser session carried by the cookie, if it is still valid for this request. Automatic sessions are
 * re-checked on every request, so a cookie taken off the server machine or off a trusted network stops working.
 */
function sessionFromCookie(req: HeaderReadableRequest, cookie: string | null): SessionClaims | null {
  if (!cookie) return null;
  const claims = verifySessionToken(cookie);
  if (!claims) return null;
  if (claims.kind === "local" && !isDirectLocalRequest(req)) return null;
  if (claims.kind === "network" && !isTrustedNetworkRequest(req)) return null;
  return claims;
}

export function getRequestSession(req: Request): SessionClaims | null {
  return sessionFromCookie(req, cookieToken(req));
}

export function isAuthenticated(req: Request): boolean {
  return isApiTokenBearer(bearerToken(req)) || getRequestSession(req) !== null;
}

export function shouldUseSecureCookie(req: Request): boolean {
  const xfProto = req.header("x-forwarded-proto");
  return Boolean(req.secure || xfProto === "https");
}

export function issueSessionCookie(req: Request, res: Response, kind: SessionKind): void {
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(createSessionToken(kind))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (shouldUseSecureCookie(req)) cookie.push("Secure");
  res.append("Set-Cookie", cookie.join("; "));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const cookie = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (shouldUseSecureCookie(req)) cookie.push("Secure");
  res.append("Set-Cookie", cookie.join("; "));
}

/** The automatic sign-in this request qualifies for, if any. */
function automaticSessionKind(req: Request): SessionKind | null {
  if (isDirectLocalRequest(req)) return "local";
  if (isTrustedNetworkRequest(req)) return "network";
  return null;
}

export function isPublicApiPath(pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/session") return true;
  if (pathname === "/api/auth/login") return true;
  if (pathname === "/api/auth/logout") return true;
  if (pathname === "/api/inbox") return true;
  if (pathname === "/api/agent-tools") return true;
  if (pathname === "/api/openapi.json") return true;
  if (pathname === "/api/docs" || pathname.startsWith("/api/docs/")) return true;
  if (pathname === "/api/oauth/start") return true;
  if (pathname.startsWith("/api/oauth/callback/")) return true;
  return false;
}

function incomingMessageView(req: IncomingMessage): HeaderReadableRequest {
  return {
    socket: req.socket,
    header(name: string) {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(",") : value;
    },
  };
}

export function incomingMessageBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw || Array.isArray(raw)) return null;
  return bearerFromHeader(raw);
}

export function incomingMessageCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw || Array.isArray(raw)) return null;
  return cookieFromHeader(raw);
}

export function isIncomingMessageAuthenticated(req: IncomingMessage): boolean {
  if (isApiTokenBearer(incomingMessageBearerToken(req))) return true;
  return sessionFromCookie(incomingMessageView(req), incomingMessageCookieToken(req)) !== null;
}

export function isIncomingMessageOriginTrusted(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return true;
  return isTrustedOriginForRequest(origin, incomingMessageView(req));
}

function sessionPayload(kind: SessionKind) {
  const trust = getTrustedNetworkSummary();
  return {
    ok: true,
    csrf_token: CSRF_TOKEN,
    auth: {
      method: kind,
      password_configured: isPasswordConfigured(),
      password_min_length: MIN_PASSWORD_LENGTH,
      can_set_password_without_current: kind === "local",
      trusted_networks: trust.networks,
      allowed_hosts: trust.allowedHosts,
    },
  };
}

function loginThrottleKey(req: Request): string {
  return resolveClientAddress(req) ?? "unknown";
}

export function installSecurityMiddleware(app: Express): void {
  const corsMiddleware = cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "content-type",
      "authorization",
      "x-inbox-secret",
      "x-csrf-token",
      "x-task-interrupt-token",
      "x-agent-task-token",
    ],
    maxAge: 600,
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (origin && !isTrustedOriginForRequest(origin, req)) {
      return res.status(403).json({ error: "origin_not_allowed" });
    }
    corsMiddleware(req, res, (err) => {
      if (err) return res.status(403).json({ error: "origin_not_allowed" });
      next();
    });
  });

  app.use(express.json({ limit: "12mb" }));

  app.get("/api/auth/session", (req, res) => {
    if (isApiTokenBearer(bearerToken(req))) {
      issueSessionCookie(req, res, "token");
      return res.json(sessionPayload("token"));
    }
    const existing = getRequestSession(req);
    if (existing) {
      if (existing.expiresAt - Date.now() < SESSION_REFRESH_WINDOW_MS) issueSessionCookie(req, res, existing.kind);
      return res.json(sessionPayload(existing.kind));
    }
    const automatic = automaticSessionKind(req);
    if (automatic) {
      issueSessionCookie(req, res, automatic);
      return res.json(sessionPayload(automatic));
    }
    return res.status(401).json({ error: "login_required", password_configured: isPasswordConfigured() });
  });

  app.post("/api/auth/login", async (req, res) => {
    const key = loginThrottleKey(req);
    const lockedMs = loginLockRemainingMs(key);
    if (lockedMs > 0) {
      const retryAfter = Math.ceil(lockedMs / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "too_many_attempts", retry_after_seconds: retryAfter });
    }
    if (!isPasswordConfigured()) return res.status(409).json({ error: "password_not_set" });
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || password.length > MAX_PASSWORD_LENGTH || !(await verifyLoginPassword(password))) {
      recordLoginFailure(key);
      return res.status(401).json({ error: "invalid_credentials" });
    }
    recordLoginSuccess(key);
    issueSessionCookie(req, res, "password");
    return res.json(sessionPayload("password"));
  });

  app.post("/api/auth/logout", (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true, automatic_sign_in: automaticSessionKind(req) !== null });
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (isPublicApiPath(req.path)) return next();
    if (isApiTokenBearer(bearerToken(req))) return next();
    const session = getRequestSession(req);
    if (!session) return res.status(401).json({ error: "unauthorized" });
    if (session.expiresAt - Date.now() < SESSION_REFRESH_WINDOW_MS) issueSessionCookie(req, res, session.kind);
    return next();
  });

  app.put("/api/auth/password", async (req, res) => {
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) return res.status(403).json({ error: "csrf_invalid" });
    const nextPassword = req.body?.new_password;
    const problem = validateNewPassword(nextPassword);
    if (problem) return res.status(400).json({ error: problem, min_length: MIN_PASSWORD_LENGTH });

    const session = getRequestSession(req);
    if (isPasswordConfigured() && !isDirectLocalRequest(req)) {
      const key = loginThrottleKey(req);
      if (loginLockRemainingMs(key) > 0) return res.status(429).json({ error: "too_many_attempts" });
      const current = typeof req.body?.current_password === "string" ? req.body.current_password : "";
      if (!current || !(await verifyLoginPassword(current))) {
        recordLoginFailure(key);
        return res.status(403).json({ error: "invalid_current_password" });
      }
      recordLoginSuccess(key);
    }

    await setLoginPassword(nextPassword as string);
    // Changing the password signs out every browser; keep this one signed in.
    const kind: SessionKind = session?.kind ?? (isApiTokenBearer(bearerToken(req)) ? "token" : "password");
    issueSessionCookie(req, res, kind);
    return res.json(sessionPayload(kind));
  });

  app.post("/api/auth/sessions/revoke", (req, res) => {
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) return res.status(403).json({ error: "csrf_invalid" });
    const session = getRequestSession(req);
    revokeAllSessions();
    const kind: SessionKind = session?.kind ?? "token";
    issueSessionCookie(req, res, kind);
    return res.json(sessionPayload(kind));
  });
}
