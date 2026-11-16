import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { getCsrfToken } from "../../../security/auth.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => {
  process.env.OAUTH_ENCRYPTION_SECRET = "mailbox-test-encryption-key-only";
  return {
    imapOptions: vi.fn(),
    smtpOptions: vi.fn(),
    connect: vi.fn(),
    logout: vi.fn(),
    imapClose: vi.fn(),
    verify: vi.fn(),
    smtpClose: vi.fn(),
  };
});
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(options: unknown) {
      network.imapOptions(options);
    }
    on() {}
    connect = network.connect;
    logout = network.logout;
    close = network.imapClose;
  },
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: unknown) => {
      network.smtpOptions(options);
      return { verify: network.verify, close: network.smtpClose };
    },
  },
}));

import { ensureBusinessMailboxSchema, registerBusinessMailboxRoutes } from "./business-mailboxes.ts";

const databases: DatabaseSync[] = [];
function harness() {
  const db = new DatabaseSync(":memory:");
  ensureBusinessMailboxSchema(db);
  ensureBusinessMailboxSchema(db);
  databases.push(db);
  const app = express();
  app.use(express.json());
  registerBusinessMailboxRoutes(app, db);
  return { app, db };
}
const input = {
  email: "info@smallbusinessestech.com",
  imap_host: "mail.smallbusinessestech.com",
  smtp_host: "mail.smallbusinessestech.com",
  password: "private-test-password",
};

beforeEach(() => {
  vi.clearAllMocks();
  network.connect.mockResolvedValue(undefined);
  network.logout.mockResolvedValue(undefined);
  network.verify.mockResolvedValue(true);
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("business mailbox connection configuration", () => {
  it("migrates legacy single accounts without altering ciphertext, identity or test history", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`CREATE TABLE business_mailboxes (
      business TEXT PRIMARY KEY,email TEXT,username TEXT,imap_host TEXT,imap_port INTEGER,smtp_host TEXT,smtp_port INTEGER,
      password_enc TEXT,updated_at INTEGER,last_test_at INTEGER,last_test_ok INTEGER);
      INSERT INTO business_mailboxes VALUES ('tech','Info@Example.com','login','mail.example.com',993,'mail.example.com',465,'v1:preserved-ciphertext',123,456,1);`);
    ensureBusinessMailboxSchema(db);
    ensureBusinessMailboxSchema(db);
    expect(db.prepare("SELECT * FROM business_mailboxes").get()).toEqual({
      id: "tech",
      business: "tech",
      is_default: 1,
      email: "Info@Example.com",
      username: "login",
      imap_host: "mail.example.com",
      imap_port: 993,
      smtp_host: "mail.example.com",
      smtp_port: 465,
      password_enc: "v1:preserved-ciphertext",
      updated_at: 123,
      last_test_at: 456,
      last_test_ok: 1,
      imap_security: "tls",
      smtp_security: "tls",
    });
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("gives the ventures business its own mailbox and connects with STARTTLS when asked", async () => {
    const { app } = harness();
    const created = await request(app)
      .post("/api/business/mailboxes")
      .set("x-csrf-token", getCsrfToken())
      .send({
        business: "ventures",
        email: "office@example.com",
        imap_host: "mail.example.com",
        smtp_host: "mail.example.com",
        smtp_port: 587,
        smtp_security: "starttls",
        password: "private-test-password",
      })
      .expect(201);
    expect(created.body.item).toMatchObject({
      business: "ventures",
      is_default: true,
      imap_port: 993,
      imap_security: "tls",
      smtp_port: 587,
      smtp_security: "starttls",
      has_password: true,
    });
    expect(JSON.stringify(created.body)).not.toContain("private-test-password");

    await request(app)
      .post(`/api/business/mailboxes/accounts/${created.body.item.id}/test`)
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    // IMAP stays on implicit TLS; SMTP upgrades with STARTTLS and refuses to continue in the clear.
    expect(network.imapOptions).toHaveBeenCalledWith(expect.objectContaining({ port: 993, secure: true }));
    expect(network.imapOptions.mock.calls[0][0]).not.toHaveProperty("doSTARTTLS");
    expect(network.smtpOptions).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );

    await request(app)
      .patch(`/api/business/mailboxes/accounts/${created.body.item.id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ imap_port: 143, imap_security: "starttls" })
      .expect(200);
    network.imapOptions.mockClear();
    await request(app)
      .post(`/api/business/mailboxes/accounts/${created.body.item.id}/test`)
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(network.imapOptions).toHaveBeenCalledWith(
      expect.objectContaining({ port: 143, secure: false, doSTARTTLS: true }),
    );

    await request(app)
      .patch(`/api/business/mailboxes/accounts/${created.body.item.id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ smtp_security: "none" })
      .expect(400, { error: "invalid_mail_security" });
    await request(app)
      .post("/api/business/mailboxes")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, business: "somewhere-else" })
      .expect(400, { error: "invalid_business" });
  });

  it("supports several accounts, normalized address uniqueness, and atomic default changes with legacy callers", async () => {
    const { app, db } = harness();
    const first = await request(app)
      .post("/api/business/mailboxes")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, business: "tech" })
      .expect(201);
    const firstId = first.body.item.id;
    expect(first.body.item.is_default).toBe(true);
    const second = await request(app)
      .post("/api/business/mailboxes")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, business: "tech", email: "support@example.com", password: "" })
      .expect(201);
    const secondId = second.body.item.id;
    expect(second.body.item).toMatchObject({ is_default: false, has_password: false });
    await request(app)
      .post("/api/business/mailboxes")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, business: "tech", email: input.email.toUpperCase() })
      .expect(409);
    await request(app)
      .patch(`/api/business/mailboxes/accounts/${secondId}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ is_default: true })
      .expect(200);
    expect(db.prepare("SELECT id FROM business_mailboxes WHERE is_default=1").get()).toEqual({ id: secondId });
    await request(app)
      .patch(`/api/business/mailboxes/accounts/${secondId}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ is_default: false })
      .expect(400);
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ username: "default-login" })
      .expect(200);
    expect(db.prepare("SELECT username FROM business_mailboxes WHERE id=?").get(secondId)).toEqual({
      username: "default-login",
    });
    await request(app)
      .post(`/api/business/mailboxes/accounts/${firstId}/test`)
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(network.imapOptions).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: input.email, pass: input.password } }),
    );
    await request(app).post("/api/business/mailboxes/tech/test").set("x-csrf-token", getCsrfToken()).expect(400);
    expect(network.connect).toHaveBeenCalledOnce();
  });

  it("encrypts credentials, returns safe configuration and preserves passwords on edits", async () => {
    const { app, db } = harness();
    const saved = await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(200);
    expect(saved.body.item).toMatchObject({
      business: "tech",
      username: input.email,
      imap_port: 993,
      smtp_port: 465,
      has_password: true,
      last_test_at: null,
      last_test_ok: null,
    });
    expect(JSON.stringify(saved.body)).not.toContain(input.password);
    expect(saved.body.item).not.toHaveProperty("password_enc");
    const row = db.prepare("SELECT password_enc FROM business_mailboxes WHERE business='tech'").get() as {
      password_enc: string;
    };
    expect(row.password_enc).toMatch(/^v1:/);
    expect(row.password_enc).not.toContain(input.password);
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ username: "support", password: "" })
      .expect(200);
    expect(db.prepare("SELECT password_enc FROM business_mailboxes WHERE business='tech'").get()).toEqual(row);
    const list = await request(app).get("/api/business/mailboxes").expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].username).toBe("support");
    expect(JSON.stringify(list.body)).not.toContain(row.password_enc);
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("tests IMAP and SMTP authentication with certificate validation and closes both clients without sending", async () => {
    const { app, db } = harness();
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(200);
    const result = await request(app)
      .post("/api/business/mailboxes/tech/test")
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(result.body).toMatchObject({ ok: true, imap: { ok: true }, smtp: { ok: true } });
    for (const options of [network.imapOptions, network.smtpOptions]) {
      expect(options).toHaveBeenCalledWith(
        expect.objectContaining({
          secure: true,
          tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
          auth: { user: input.email, pass: input.password },
          logger: false,
        }),
      );
    }
    expect(network.verify).toHaveBeenCalledOnce();
    expect(network.imapClose).toHaveBeenCalledOnce();
    expect(network.smtpClose).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT last_test_ok FROM business_mailboxes WHERE business='tech'").get()).toEqual({
      last_test_ok: 1,
    });
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ imap_port: 9993 })
      .expect(200);
    expect(db.prepare("SELECT last_test_ok FROM business_mailboxes WHERE business='tech'").get()).toEqual({
      last_test_ok: null,
    });
  });

  it("defaults a blank login username to the mailbox address and rejects explicit null", async () => {
    const { app } = harness();
    const saved = await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, username: "  " })
      .expect(200);
    expect(saved.body.item.username).toBe(input.email);
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ username: null })
      .expect(400);
    await request(app).post("/api/business/mailboxes/tech/test").set("x-csrf-token", getCsrfToken()).expect(200);
    expect(network.imapOptions).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: input.email, pass: input.password } }),
    );
  });

  it("redacts protocol failures and records an unsuccessful test", async () => {
    const { app } = harness();
    await request(app)
      .patch("/api/business/mailboxes/rental")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(200);
    network.connect.mockRejectedValue(
      Object.assign(new Error(`secret ${input.password}`), { code: "CERT_HAS_EXPIRED" }),
    );
    network.verify.mockRejectedValue(Object.assign(new Error(`secret ${input.password}`), { code: "EAUTH" }));
    const result = await request(app)
      .post("/api/business/mailboxes/rental/test")
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(result.body).toMatchObject({
      imap: { ok: false, error: "tls_verification_failed" },
      smtp: { ok: false, error: "authentication_failed" },
    });
    expect(JSON.stringify(result.body)).not.toContain(input.password);
    const list = await request(app).get("/api/business/mailboxes");
    expect(list.body.items[0].last_test_ok).toBe(false);
    expect(network.imapClose).toHaveBeenCalledOnce();
    expect(network.smtpClose).toHaveBeenCalledOnce();
  });

  it("validates configuration before storing or connecting", async () => {
    const { app } = harness();
    await request(app)
      .patch("/api/business/mailboxes/other")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(400);
    for (const invalid of [
      { email: "bad\r\n@example.com" },
      { imap_host: "https://mail.example.com" },
      { smtp_host: "mail.example.com/path" },
      { imap_port: 0 },
      { smtp_port: "465" },
      { secure: false },
    ]) {
      await request(app)
        .patch("/api/business/mailboxes/tech")
        .set("x-csrf-token", getCsrfToken())
        .send({ ...input, ...invalid })
        .expect(400);
    }
    await request(app).post("/api/business/mailboxes/tech/test").set("x-csrf-token", getCsrfToken()).expect(404);
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("rejects worker credentials on every mailbox endpoint", async () => {
    const { app } = harness();
    await request(app).get("/api/business/mailboxes").set("x-agent-task-token", "worker").expect(403);
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "worker")
      .send(input)
      .expect(403);
    await request(app)
      .post("/api/business/mailboxes/tech/test")
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "worker")
      .expect(403);
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("saves nonsecret connection settings before a password is entered, without probing", async () => {
    const { app } = harness();
    const saved = await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, password: "" })
      .expect(200);
    expect(saved.body.item.has_password).toBe(false);
    const tested = await request(app)
      .post("/api/business/mailboxes/tech/test")
      .set("x-csrf-token", getCsrfToken())
      .expect(400);
    expect(tested.body).toEqual({ error: "mailbox_password_required" });
    expect(network.connect).not.toHaveBeenCalled();
    expect(network.verify).not.toHaveBeenCalled();
    const configured = await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send({ password: input.password })
      .expect(200);
    expect(configured.body.item.has_password).toBe(true);
  });

  it("requires CSRF protection and handles unreadable saved credentials without touching the network", async () => {
    const { app, db } = harness();
    await request(app).patch("/api/business/mailboxes/tech").send(input).expect(403);
    await request(app)
      .patch("/api/business/mailboxes/tech")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(200);
    await request(app).post("/api/business/mailboxes/tech/test").expect(403);
    db.prepare("UPDATE business_mailboxes SET password_enc='invalid'").run();
    const result = await request(app)
      .post("/api/business/mailboxes/tech/test")
      .set("x-csrf-token", getCsrfToken())
      .expect(503);
    expect(result.body).toEqual({ error: "mailbox_credential_store_unavailable" });
    expect(network.connect).not.toHaveBeenCalled();
  });
});
