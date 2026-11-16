import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TRUSTED_NETWORKS = "192.168.10.0/24, 192.168.20.0/24, fd00:10::/64, not-a-network";
  process.env.ALLOWED_HOSTS = "atlas.lan";
});

import { installSecurityMiddleware, requireOwnerSession } from "./auth.ts";
import { __resetLoginStoreForTests } from "./login-sessions.ts";
import {
  isTrustedNetworkRequest,
  parseTrustedNetworks,
  resolveClientAddress,
  type HeaderReadableRequest,
} from "./network-trust.ts";

function fakeRequest(remoteAddress: string, headers: Record<string, string>): HeaderReadableRequest {
  return { socket: { remoteAddress }, header: (name) => headers[name.toLowerCase()] };
}

function buildApp(socketPeer?: () => string) {
  const app = express();
  // Supertest connects over loopback; simulate the transport peer directly,
  // never through headers that an untrusted local worker could forge.
  if (socketPeer)
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: socketPeer(), configurable: true });
      next();
    });
  installSecurityMiddleware(app);
  app.get("/api/protected", (_req, res) => res.json({ ok: true }));
  app.post("/api/protected", (_req, res) => res.json({ ok: true }));
  app.post("/api/owner-decision", (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    res.json({ ok: true });
  });
  return app;
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith("claw_session="));
  if (!cookie) throw new Error("no session cookie");
  return cookie.split(";")[0];
}

const OUTSIDER = { Host: "claw.example.com", "X-Forwarded-For": "203.0.113.9" };

describe("trusted networks", () => {
  it("parses CIDR ranges and single addresses, rejecting junk", () => {
    const parsed = parseTrustedNetworks([
      "192.168.10.0/24",
      "10.0.0.7",
      "fd00::/8",
      "300.1.1.1/24",
      "10.0.0.0/33",
      "x",
    ]);
    expect(parsed.accepted).toEqual(["192.168.10.0/24", "10.0.0.7/32", "fd00::/8"]);
    expect(parsed.rejected).toEqual(["300.1.1.1/24", "10.0.0.0/33", "x"]);
  });

  it("trusts browsers on listed VLANs and nowhere else", () => {
    expect(isTrustedNetworkRequest(fakeRequest("::ffff:192.168.10.42", { host: "192.168.10.5:8790" }))).toBe(true);
    expect(isTrustedNetworkRequest(fakeRequest("192.168.20.9", { host: "atlas.lan:8790" }))).toBe(true);
    expect(isTrustedNetworkRequest(fakeRequest("fd00:10::25", { host: "[fd00:10::5]:8790" }))).toBe(true);
    // An IoT/guest VLAN that is not listed.
    expect(isTrustedNetworkRequest(fakeRequest("192.168.30.15", { host: "192.168.10.5:8790" }))).toBe(false);
    // DNS rebinding: an attacker's domain pointed at ATLAS from a trusted VLAN browser.
    expect(isTrustedNetworkRequest(fakeRequest("192.168.10.42", { host: "evil.example:8790" }))).toBe(false);
  });

  it("only believes forwarding headers from a proxy on this machine", () => {
    expect(resolveClientAddress(fakeRequest("192.168.30.15", { "x-forwarded-for": "192.168.10.42" }))).toBe(
      "192.168.30.15",
    );
    expect(resolveClientAddress(fakeRequest("127.0.0.1", { "x-forwarded-for": "192.168.10.42, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    expect(resolveClientAddress(fakeRequest("127.0.0.1", { "x-real-ip": "192.168.20.4" }))).toBe("192.168.20.4");
    expect(resolveClientAddress(fakeRequest("127.0.0.1", {}))).toBe("127.0.0.1");
  });
});

describe("sign-in flow", () => {
  beforeEach(() => {
    __resetLoginStoreForTests();
  });

  it("signs in trusted-VLAN browsers automatically, and their cookie stops working off the VLAN", async () => {
    let peer = "192.168.20.7";
    const app = buildApp(() => peer);
    const vlan = { Host: "192.168.10.5:8790" };
    const res = await request(app).get("/api/auth/session").set(vlan).expect(200);
    expect(res.body.auth.method).toBe("network");
    expect(res.body.auth.trusted_networks).toEqual(["192.168.10.0/24", "192.168.20.0/24", "fd00:10::/64"]);
    const cookie = sessionCookie(res);

    await request(app).get("/api/protected").set(vlan).set("Cookie", cookie).expect(200);
    await request(app).post("/api/owner-decision").set(vlan).set("Cookie", cookie).expect(200);
    peer = "203.0.113.9";
    await request(app).get("/api/protected").set(OUTSIDER).set("Cookie", cookie).expect(401);
  });

  it("refuses loopback workers pretending to be a trusted VLAN through forwarding headers", async () => {
    const app = buildApp();
    for (const forged of [
      { Host: "192.168.10.5:8790", "X-Forwarded-For": "192.168.20.7" },
      { Host: "atlas.lan", "X-Real-IP": "192.168.10.77" },
      { Host: "atlas.lan", Forwarded: "for=192.168.10.77" },
    ]) {
      await request(app).get("/api/auth/session").set(forged).expect(401);
    }
  });

  it("asks everyone else to log in, and refuses until a password exists", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/auth/session").set(OUTSIDER).expect(401);
    expect(res.body).toEqual({ error: "login_required", password_configured: false });
    await request(app).post("/api/auth/login").set(OUTSIDER).send({ password: "anything-at-all" }).expect(409);
  });

  it("sets a password from the server machine, then lets a remote browser log in and out", async () => {
    const app = buildApp();
    const local = await request(app).get("/api/auth/session").expect(200);
    expect(local.body.auth.method).toBe("local");
    const localCookie = sessionCookie(local);
    const csrf = local.body.csrf_token as string;

    await request(app)
      .put("/api/auth/password")
      .set("Cookie", localCookie)
      .set("x-csrf-token", csrf)
      .send({ new_password: "short" })
      .expect(400);
    await request(app)
      .put("/api/auth/password")
      .set("Cookie", localCookie)
      .send({ new_password: "long enough pw" })
      .expect(403);
    const set = await request(app)
      .put("/api/auth/password")
      .set("Cookie", localCookie)
      .set("x-csrf-token", csrf)
      .send({ new_password: "correct horse battery" })
      .expect(200);
    expect(set.body.auth.password_configured).toBe(true);

    const remote = { Host: "claw.example.com", "X-Forwarded-For": "203.0.113.20" };
    await request(app).post("/api/auth/login").set(remote).send({ password: "wrong password" }).expect(401);
    const login = await request(app)
      .post("/api/auth/login")
      .set(remote)
      .send({ password: "correct horse battery" })
      .expect(200);
    expect(login.body.auth.method).toBe("password");
    const remoteCookie = sessionCookie(login);
    await request(app).get("/api/protected").set(remote).set("Cookie", remoteCookie).expect(200);

    const logout = await request(app).post("/api/auth/logout").set(remote).set("Cookie", remoteCookie).expect(200);
    expect(logout.body.automatic_sign_in).toBe(false);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("requires the current password to change it from a remote browser, and signs out other browsers", async () => {
    const app = buildApp();
    const local = await request(app).get("/api/auth/session").expect(200);
    await request(app)
      .put("/api/auth/password")
      .set("Cookie", sessionCookie(local))
      .set("x-csrf-token", local.body.csrf_token)
      .send({ new_password: "first password 1" })
      .expect(200);

    const remote = { Host: "claw.example.com", "X-Forwarded-For": "203.0.113.30" };
    const other = { Host: "claw.example.com", "X-Forwarded-For": "203.0.113.31" };
    const login = await request(app)
      .post("/api/auth/login")
      .set(remote)
      .send({ password: "first password 1" })
      .expect(200);
    const otherLogin = await request(app)
      .post("/api/auth/login")
      .set(other)
      .send({ password: "first password 1" })
      .expect(200);
    const cookie = sessionCookie(login);
    const csrf = login.body.csrf_token as string;

    await request(app)
      .put("/api/auth/password")
      .set(remote)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf)
      .send({ new_password: "second password 2" })
      .expect(403);
    const changed = await request(app)
      .put("/api/auth/password")
      .set(remote)
      .set("Cookie", cookie)
      .set("x-csrf-token", csrf)
      .send({ current_password: "first password 1", new_password: "second password 2" })
      .expect(200);

    await request(app).get("/api/protected").set(remote).set("Cookie", sessionCookie(changed)).expect(200);
    await request(app).get("/api/protected").set(other).set("Cookie", sessionCookie(otherLogin)).expect(401);
  });

  it("locks out an address after repeated wrong passwords", async () => {
    const app = buildApp();
    const local = await request(app).get("/api/auth/session").expect(200);
    await request(app)
      .put("/api/auth/password")
      .set("Cookie", sessionCookie(local))
      .set("x-csrf-token", local.body.csrf_token)
      .send({ new_password: "the real password" })
      .expect(200);

    const attacker = { Host: "claw.example.com", "X-Forwarded-For": "198.51.100.66" };
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/login")
        .set(attacker)
        .send({ password: `guess ${i}` })
        .expect(401);
    }
    const locked = await request(app).post("/api/auth/login").set(attacker).send({ password: "the real password" });
    expect(locked.status).toBe(429);
    expect(locked.headers["retry-after"]).toBeTruthy();
    // Another address is unaffected.
    await request(app)
      .post("/api/auth/login")
      .set({ Host: "claw.example.com", "X-Forwarded-For": "198.51.100.67" })
      .send({ password: "the real password" })
      .expect(200);
  });

  it("accepts the page's own origin on a known host and rejects foreign origins", async () => {
    const app = buildApp(() => "192.168.10.77");
    const vlan = { Host: "192.168.10.5:8790" };
    const session = await request(app).get("/api/auth/session").set(vlan).expect(200);
    await request(app)
      .post("/api/protected")
      .set(vlan)
      .set("Origin", "http://192.168.10.5:8790")
      .set("Cookie", sessionCookie(session))
      .expect(200);
    await request(app)
      .post("/api/protected")
      .set(vlan)
      .set("Origin", "http://evil.example")
      .set("Cookie", sessionCookie(session))
      .expect(403);
    await request(app)
      .post("/api/auth/login")
      .set({ Host: "evil.example", Origin: "http://evil.example", "X-Forwarded-For": "192.168.10.77" })
      .send({ password: "x" })
      .expect(403);
  });
});
