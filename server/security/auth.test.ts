import express from "express";
import request from "supertest";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { SESSION_AUTH_TOKEN, SESSION_COOKIE_NAME } from "../config/runtime.ts";
import {
  bearerToken,
  buildTaskInterruptControlToken,
  cookieToken,
  csrfTokenFromRequest,
  getCsrfToken,
  hasValidCsrfToken,
  hasValidTaskInterruptControlToken,
  incomingMessageBearerToken,
  incomingMessageCookieToken,
  installSecurityMiddleware,
  isAuthenticated,
  isDirectLocalRequest,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  isPublicApiPath,
  isTrustedOrigin,
  issueSessionCookie,
  parseCookies,
  requireOwnerSession,
  safeSecretEquals,
  shouldRequireCsrf,
  shouldUseSecureCookie,
} from "./auth.ts";
import {
  __resetLoginStoreForTests,
  createSessionToken,
  revokeAllSessions,
  verifySessionToken,
  setLoginPassword,
} from "./login-sessions.ts";
import { agentEnvironment } from "./agent-environment.ts";

function mockRequest(headers: Record<string, string | undefined>): Request {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    secure: false,
    socket: {
      remoteAddress: "127.0.0.1",
    },
  } as unknown as Request;
}

describe("auth helpers", () => {
  it("detects loopback addresses correctly", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);

    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);

    expect(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: "10.1.2.3" } })).toBe(false);
  });

  it("parses cookies and tokens and checks auth", () => {
    const reqWithBearer = mockRequest({
      authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
    });
    expect(bearerToken(reqWithBearer)).toBe(SESSION_AUTH_TOKEN);
    expect(isAuthenticated(reqWithBearer)).toBe(true);

    // The master API token is not a browser session: cookies carry signed session tokens instead.
    const reqWithTokenCookie = mockRequest({
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}; foo=bar`,
    });
    expect(cookieToken(reqWithTokenCookie)).toBe(SESSION_AUTH_TOKEN);
    expect(isAuthenticated(reqWithTokenCookie)).toBe(false);

    const passwordSession = createSessionToken("password");
    const reqWithSession = mockRequest({ cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(passwordSession)}` });
    expect(isAuthenticated(reqWithSession)).toBe(true);
    expect(isAuthenticated(mockRequest({ cookie: `${SESSION_COOKIE_NAME}=${passwordSession}x` }))).toBe(false);

    const parsed = parseCookies("a=1; b=hello%20world; c=%E3%81%82");
    expect(parsed).toMatchObject({
      a: "1",
      b: "hello world",
      c: "\u3042",
    });
  });

  it("applies the origin, path and secure-cookie rules", () => {
    expect(isTrustedOrigin("http://localhost:8800")).toBe(true);
    expect(isTrustedOrigin("https://dev.ts.net")).toBe(true);
    expect(isTrustedOrigin("file://tmp/test")).toBe(false);
    expect(isTrustedOrigin("not-a-url")).toBe(false);

    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/auth/session")).toBe(true);
    expect(isPublicApiPath("/api/openapi.json")).toBe(true);
    expect(isPublicApiPath("/api/docs")).toBe(true);
    expect(isPublicApiPath("/api/docs/")).toBe(true);
    expect(isPublicApiPath("/api/tasks")).toBe(false);

    const insecureReq = mockRequest({
      "x-forwarded-proto": "http",
    });
    expect(shouldUseSecureCookie(insecureReq)).toBe(false);

    const secureReq = {
      ...insecureReq,
      secure: true,
    } as Request;
    expect(shouldUseSecureCookie(secureReq)).toBe(true);
  });

  it("issues signed session cookies that never contain the API token", () => {
    const append = vi.fn();
    const res = { append } as unknown as Response;

    issueSessionCookie(mockRequest({ cookie: undefined }), res, "local");
    expect(append).toHaveBeenCalledTimes(1);
    const cookie = String(append.mock.calls[0]?.[1] ?? "");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=");
    expect(cookie).not.toContain(SESSION_AUTH_TOKEN);
    const value = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
    expect(verifySessionToken(value)?.kind).toBe("local");
  });

  it("re-checks automatic sessions on every request", () => {
    const local = encodeURIComponent(createSessionToken("local"));
    const onServer = mockRequest({ host: "127.0.0.1:8790", cookie: `${SESSION_COOKIE_NAME}=${local}` });
    expect(isAuthenticated(onServer)).toBe(true);
    const relayed = mockRequest({
      host: "claw.example.com",
      "x-forwarded-for": "203.0.113.9",
      cookie: `${SESSION_COOKIE_NAME}=${local}`,
    });
    expect(isAuthenticated(relayed)).toBe(false);

    // No TRUSTED_NETWORKS configured in this test file, so a network session is never accepted.
    const network = encodeURIComponent(createSessionToken("network"));
    expect(isAuthenticated(mockRequest({ host: "127.0.0.1:8790", cookie: `${SESSION_COOKIE_NAME}=${network}` }))).toBe(
      false,
    );
  });

  it("signs out every browser when sessions are revoked", () => {
    const token = createSessionToken("password");
    expect(verifySessionToken(token)).not.toBeNull();
    revokeAllSessions();
    expect(verifySessionToken(token)).toBeNull();
    expect(verifySessionToken(createSessionToken("password"))).not.toBeNull();
  });

  it("checks auth and origin on an IncomingMessage", () => {
    const incoming = {
      headers: {
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
        origin: "http://localhost:8800",
      },
    } as unknown as IncomingMessage;

    expect(incomingMessageBearerToken(incoming)).toBe(SESSION_AUTH_TOKEN);
    expect(incomingMessageCookieToken(incoming)).toBe(SESSION_AUTH_TOKEN);
    expect(isIncomingMessageAuthenticated(incoming)).toBe(true);
    expect(isIncomingMessageOriginTrusted(incoming)).toBe(true);
  });

  it("safeSecretEquals is true only for equal values", () => {
    expect(safeSecretEquals("abc123", "abc123")).toBe(true);
    expect(safeSecretEquals("abc123", "abc124")).toBe(false);
    expect(safeSecretEquals("short", "much-longer")).toBe(false);
  });

  it("validates csrf and task-interrupt control tokens", () => {
    const csrf = getCsrfToken();
    const req = {
      ...mockRequest({
        "x-csrf-token": csrf,
      }),
      method: "POST",
    } as Request;
    expect(csrfTokenFromRequest(req)).toBe(csrf);
    expect(shouldRequireCsrf(req)).toBe(true);
    expect(hasValidCsrfToken(req)).toBe(true);

    const bearerReq = {
      ...mockRequest({
        authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      }),
      method: "POST",
    } as Request;
    expect(shouldRequireCsrf(bearerReq)).toBe(false);

    const token = buildTaskInterruptControlToken("task-1", "session-1");
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", token)).toBe(true);
    expect(hasValidTaskInterruptControlToken("task-1", "session-1", `${token}x`)).toBe(false);
  });
});

describe("isDirectLocalRequest", () => {
  const local = (headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") =>
    isDirectLocalRequest({
      socket: { remoteAddress },
      header: (name: string) => headers[name.toLowerCase()],
    });

  it("accepts direct same-machine requests", () => {
    expect(local({ host: "127.0.0.1:8790" })).toBe(true);
    expect(local({ host: "localhost:8800" })).toBe(true);
    expect(local({ host: "[::1]:8790" }, "::1")).toBe(true);
    expect(local({ host: "127.0.0.1:8790", "x-forwarded-for": "127.0.0.1" })).toBe(true);
  });

  it("rejects remote sockets and non-loopback Host headers", () => {
    expect(local({ host: "127.0.0.1:8790" }, "10.0.0.5")).toBe(false);
    expect(local({})).toBe(false);
    expect(local({ host: "claw.example.com" })).toBe(false);
    expect(local({ host: "atlas.tailnet-abc.ts.net" })).toBe(false);
    expect(local({ host: "192.168.1.20:8800" })).toBe(false);
  });

  it("rejects requests a same-host proxy relays for a remote client", () => {
    expect(local({ host: "localhost", "x-forwarded-for": "203.0.113.9" })).toBe(false);
    expect(local({ host: "localhost", "x-forwarded-for": "127.0.0.1, 203.0.113.9" })).toBe(false);
    expect(local({ host: "localhost", "x-real-ip": "203.0.113.9" })).toBe(false);
    expect(local({ host: "localhost", "cf-connecting-ip": "2001:db8::1" })).toBe(false);
    expect(local({ host: "localhost", "x-forwarded-host": "claw.example.com" })).toBe(false);
    expect(local({ host: "localhost", forwarded: "for=203.0.113.9;proto=https" })).toBe(false);
    expect(local({ host: "localhost", forwarded: 'for="[2001:db8::1]:443"' })).toBe(false);
    expect(local({ host: "localhost", forwarded: "for=127.0.0.1;host=claw.example.com" })).toBe(false);
    expect(local({ host: "localhost", forwarded: "for=_hidden" })).toBe(false);
  });
});

describe("installSecurityMiddleware", () => {
  it("does not grant owner authority to an agent through local bootstrap, even without its task header", async () => {
    const app = express();
    installSecurityMiddleware(app);
    app.post("/api/test/decide", (req, res) => {
      if (!requireOwnerSession(req, res)) return;
      res.json({ ok: true });
    });
    const agent = request.agent(app);
    const bootstrap = await agent.get("/api/auth/session").expect(200);
    expect(bootstrap.body.auth.method).toBe("local");
    await agent.post("/api/test/decide").set("x-csrf-token", bootstrap.body.csrf_token).expect(403);
    await agent.get("/api/auth/session").set("x-agent-task-token", "worker-token").expect(403);
    await agent.get("/api/auth/session").set("x-claw-agent-process", "1").expect(403);
    const passwordCookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    await request(app).post("/api/test/decide").set("Cookie", passwordCookie).expect(200);
    await request(app)
      .post("/api/test/decide")
      .set("Cookie", passwordCookie)
      .set("x-agent-task-token", "worker-token")
      .expect(403);
    await request(app).post("/api/test/decide").set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`).expect(403);
  });

  it("requires the existing password even on the local machine and upgrades password changes to owner sessions", async () => {
    __resetLoginStoreForTests();
    await setLoginPassword("original owner password");
    const app = express();
    installSecurityMiddleware(app);
    const local = request.agent(app);
    await local.get("/api/auth/session").expect(401);
    await local.get("/api/auth/session").set("x-forwarded-for", "192.168.1.8").expect(401);
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("local")}`;
    await local
      .put("/api/auth/password")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .send({ new_password: "attacker replacement password" })
      .expect(403);
    const changed = await local
      .put("/api/auth/password")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .send({ current_password: "original owner password", new_password: "new owner password" })
      .expect(200);
    expect(changed.body.auth.method).toBe("password");
    __resetLoginStoreForTests();
  });

  it("strips owner credentials from agent and one-shot environments without mutating their parent", () => {
    const parent = {
      PATH: "tools",
      API_AUTH_TOKEN: "owner",
      SESSION_AUTH_TOKEN: "owner",
      SESSION_SECRET: "signing",
      OAUTH_ENCRYPTION_SECRET: "mail",
      INBOX_WEBHOOK_SECRET: "inbox",
    };
    expect(agentEnvironment(parent)).toEqual({
      PATH: "tools",
      CLAW_EMPIRE_AGENT_PROCESS: "1",
      // No git credentials: the owner's credential helper is switched off and git may not prompt.
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    });
    expect(parent.API_AUTH_TOKEN).toBe("owner");
  });
  it("does not issue a session to a remote client relayed by a local reverse proxy", async () => {
    const app = express();
    installSecurityMiddleware(app);
    app.get("/api/protected", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app)
      .get("/api/auth/session")
      .set("Host", "claw.example.com")
      .set("X-Forwarded-For", "203.0.113.9")
      .set("X-Forwarded-Proto", "https")
      .expect(401);
    await request(app).get("/api/auth/session").set("Host", "atlas.tailnet-abc.ts.net").expect(401);

    const bearerRes = await request(app)
      .get("/api/auth/session")
      .set("Host", "claw.example.com")
      .set("X-Forwarded-For", "203.0.113.9")
      .set("Authorization", `Bearer ${SESSION_AUTH_TOKEN}`)
      .expect(200);
    expect(bearerRes.headers["set-cookie"]?.[0]).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it("allows protected API access after a session is issued", async () => {
    const app = express();
    installSecurityMiddleware(app);
    app.get("/api/protected", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/protected").expect(401);

    const sessionRes = await request(app).get("/api/auth/session").expect(200);
    const cookieHeader = sessionRes.headers["set-cookie"]?.[0];
    expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(sessionRes.body?.csrf_token).toBeTypeOf("string");

    await request(app).get("/api/protected").set("Cookie", String(cookieHeader)).expect(200, { ok: true });
  });
});
