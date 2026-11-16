import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { decryptSecret, encryptSecret } from "../../../oauth/helpers.ts";
import { hasValidCsrfToken, shouldRequireCsrf } from "../../../security/auth.ts";

type Business = "tech" | "rental";
type MailboxRow = {
  id: string;
  is_default: number;
  business: Business;
  email: string;
  username: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  password_enc: string;
  updated_at: number;
  last_test_at: number | null;
  last_test_ok: number | null;
};
type Probe = { ok: boolean; error?: string };
const TIMEOUT = 15_000;

export function ensureBusinessMailboxSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(business_mailboxes)").all() as Array<{ name: string }>;
  const legacy = columns.length > 0 && !columns.some((column) => column.name === "id");
  let migrationStarted = false;
  try {
    if (legacy) {
      db.exec("BEGIN IMMEDIATE");
      migrationStarted = true;
      db.exec("ALTER TABLE business_mailboxes RENAME TO business_mailboxes_legacy");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS business_mailboxes (
    id TEXT PRIMARY KEY NOT NULL,
    business TEXT NOT NULL CHECK(business IN ('tech','rental')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL CHECK(imap_port BETWEEN 1 AND 65535),
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL CHECK(smtp_port BETWEEN 1 AND 65535),
    password_enc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    last_test_at INTEGER,
    last_test_ok INTEGER CHECK(last_test_ok IN (0,1))
  )`);
    if (legacy) {
      db.exec(`INSERT INTO business_mailboxes
      (id,business,is_default,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at,last_test_at,last_test_ok)
      SELECT business,business,1,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at,last_test_at,last_test_ok
      FROM business_mailboxes_legacy;
      DROP TABLE business_mailboxes_legacy;`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_business_email ON business_mailboxes(business,lower(trim(email)));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_business_default ON business_mailboxes(business) WHERE is_default=1;`);
    if (legacy) db.exec("COMMIT");
  } catch (error) {
    if (migrationStarted) db.exec("ROLLBACK");
    throw error;
  }
}

export function listAgentMailboxes(db: DatabaseSync) {
  const rows = db
    .prepare(
      "SELECT id,business,email,is_default,password_enc != '' AS configured FROM business_mailboxes ORDER BY business,is_default DESC,email,id",
    )
    .all() as Array<{ id: string; business: Business; email: string; is_default: number; configured: number }>;
  return rows.map((row) => ({ ...row, is_default: row.is_default === 1, configured: row.configured === 1 }));
}

function safeConfig(row: MailboxRow) {
  const { password_enc, ...config } = row;
  return {
    ...config,
    is_default: row.is_default === 1,
    has_password: Boolean(password_enc),
    last_test_ok: row.last_test_ok === null ? null : row.last_test_ok === 1,
  };
}

function safeProbeError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (["EAUTH", "AUTHENTICATIONFAILED", "AUTHENTICATION_FAILED"].includes(code)) return "authentication_failed";
  if (["ETIMEDOUT", "ETIMEOUT"].includes(code)) return "connection_timeout";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "host_not_found";
  if (["ECONNREFUSED", "ECONNRESET"].includes(code)) return "connection_failed";
  if (/TLS|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "tls_verification_failed";
  return "connection_test_failed";
}

async function probeImap(config: MailboxRow, password: string): Promise<Probe> {
  const client = new ImapFlow({
    host: config.imap_host,
    port: config.imap_port,
    secure: true,
    auth: { user: config.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    logger: false,
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: TIMEOUT,
    disableAutoIdle: true,
  });
  // Socket errors may arrive after connect resolves; never let them escape as uncaught events.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeProbeError(error) };
  } finally {
    client.close();
  }
}

async function probeSmtp(config: MailboxRow, password: string): Promise<Probe> {
  const transport = nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port,
    secure: true,
    auth: { user: config.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: TIMEOUT,
    logger: false,
    debug: false,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeProbeError(error) };
  } finally {
    transport.close();
  }
}

function validHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || !value) return false;
  return (
    Boolean(isIP(value)) || value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  );
}

/** Owner configuration only. No worker tool, inbox sync, or sending endpoint is exposed. */
export function registerBusinessMailboxRoutes(app: Express, db: DatabaseSync): void {
  ensureBusinessMailboxSchema(db);
  const base = "/api/business/mailboxes";
  app.use(base, (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (req.method !== "GET" && shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
      return res.status(403).json({ error: "csrf_token_required" });
    }
    next();
  });
  app.get(base, (_req, res) => {
    const rows = db
      .prepare("SELECT * FROM business_mailboxes ORDER BY business,is_default DESC,email,id")
      .all() as MailboxRow[];
    return res.json({ ok: true, items: rows.map(safeConfig) });
  });
  const save = (
    business: Business,
    current: MailboxRow | undefined,
    input: unknown,
    res: Response,
    creating = false,
  ) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return res.status(400).json({ error: "invalid_body" });
    }
    const body = input as Record<string, unknown>;
    const allowed = new Set([
      "email",
      "username",
      "imap_host",
      "imap_port",
      "smtp_host",
      "smtp_port",
      "password",
      "is_default",
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key)))
      return res.status(400).json({ error: "invalid_mailbox_field" });
    const values = { ...current, ...body };
    const email = typeof values.email === "string" ? values.email.trim() : "";
    if ("username" in body && typeof body.username !== "string") {
      return res.status(400).json({ error: "invalid_username" });
    }
    const username = typeof values.username === "string" ? values.username.trim() || email : email;
    if (email.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (!username || username.length > 320 || /[\r\n\0]/.test(username))
      return res.status(400).json({ error: "invalid_username" });
    if (!validHost(values.imap_host) || !validHost(values.smtp_host))
      return res.status(400).json({ error: "invalid_mail_host" });
    const imapPort = values.imap_port ?? 993;
    const smtpPort = values.smtp_port ?? 465;
    if (
      ![imapPort, smtpPort].every(
        (port) => typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535,
      )
    ) {
      return res.status(400).json({ error: "invalid_mail_port" });
    }
    if (
      "password" in body &&
      (typeof body.password !== "string" || body.password.length > 4096 || body.password.includes("\0"))
    ) {
      return res.status(400).json({ error: "invalid_password" });
    }
    if ("is_default" in body && typeof body.is_default !== "boolean")
      return res.status(400).json({ error: "invalid_default_flag" });
    if (body.is_default === false && current?.is_default === 1)
      return res.status(400).json({ error: "mailbox_default_required" });
    const id = current?.id ?? randomUUID();
    if (
      db
        .prepare("SELECT 1 FROM business_mailboxes WHERE business=? AND lower(trim(email))=? AND id!=?")
        .get(business, email.toLowerCase(), id)
    ) {
      return res.status(409).json({ error: "mailbox_email_exists" });
    }
    let transactionStarted = false;
    try {
      const passwordEnc = body.password ? encryptSecret(body.password as string) : (current?.password_enc ?? "");
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const hasDefault = db.prepare("SELECT 1 FROM business_mailboxes WHERE business=? AND is_default=1").get(business);
      const isDefault = body.is_default === true || current?.is_default === 1 || !hasDefault;
      if (isDefault)
        db.prepare("UPDATE business_mailboxes SET is_default=0 WHERE business=? AND id!=?").run(business, id);
      if (current && Object.keys(body).every((key) => key === "is_default")) {
        db.prepare("UPDATE business_mailboxes SET is_default=? WHERE id=?").run(isDefault ? 1 : 0, id);
        db.exec("COMMIT");
        transactionStarted = false;
        const row = db.prepare("SELECT * FROM business_mailboxes WHERE id=?").get(id) as MailboxRow;
        return res.json({ ok: true, item: safeConfig(row) });
      }
      db.prepare(
        `INSERT INTO business_mailboxes
        (id,business,is_default,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        is_default=excluded.is_default,
        email=excluded.email,username=excluded.username,imap_host=excluded.imap_host,imap_port=excluded.imap_port,
        smtp_host=excluded.smtp_host,smtp_port=excluded.smtp_port,password_enc=excluded.password_enc,
        updated_at=excluded.updated_at,last_test_at=NULL,last_test_ok=NULL`,
      ).run(
        id,
        business,
        isDefault ? 1 : 0,
        email,
        username,
        values.imap_host,
        imapPort as number,
        values.smtp_host,
        smtpPort as number,
        passwordEnc,
        Date.now(),
      );
      db.exec("COMMIT");
      transactionStarted = false;
      const row = db.prepare("SELECT * FROM business_mailboxes WHERE id = ?").get(id) as MailboxRow;
      return res.status(creating ? 201 : 200).json({ ok: true, item: safeConfig(row) });
    } catch {
      if (transactionStarted) db.exec("ROLLBACK");
      return res.status(503).json({ error: "mailbox_credential_store_unavailable" });
    }
  };
  app.post(base, (req, res) => {
    const business = req.body?.business;
    if (business !== "tech" && business !== "rental") return res.status(400).json({ error: "invalid_business" });
    const { business: _business, ...body } = req.body;
    return save(business, undefined, body, res, true);
  });
  app.patch(`${base}/accounts/:id`, (req, res) => {
    const current = db.prepare("SELECT * FROM business_mailboxes WHERE id=?").get(String(req.params.id)) as
      | MailboxRow
      | undefined;
    if (!current) return res.status(404).json({ error: "mailbox_not_configured" });
    return save(current.business, current, req.body, res);
  });
  app.patch(`${base}/:business`, (req, res) => {
    const business = String(req.params.business);
    if (business !== "tech" && business !== "rental") return res.status(400).json({ error: "invalid_business" });
    const current = db.prepare("SELECT * FROM business_mailboxes WHERE business=? AND is_default=1").get(business) as
      | MailboxRow
      | undefined;
    return save(business, current, req.body, res);
  });
  const testing = new Set<string>();
  const test = async (config: MailboxRow | undefined, res: Response) => {
    if (!config) return res.status(404).json({ error: "mailbox_not_configured" });
    if (!config.password_enc) return res.status(400).json({ error: "mailbox_password_required" });
    if (testing.has(config.id)) return res.status(409).json({ error: "mailbox_test_in_progress" });
    let password: string;
    try {
      password = decryptSecret(config.password_enc);
    } catch {
      return res.status(503).json({ error: "mailbox_credential_store_unavailable" });
    }
    testing.add(config.id);
    try {
      const [imap, smtp] = await Promise.all([probeImap(config, password), probeSmtp(config, password)]);
      const testedAt = Date.now();
      // A save during the test invalidates its result rather than marking the new configuration verified.
      db.prepare(
        `UPDATE business_mailboxes SET last_test_at=?,last_test_ok=?
        WHERE id=? AND updated_at=? AND password_enc=? AND imap_host=? AND imap_port=? AND smtp_host=? AND smtp_port=? AND username=?`,
      ).run(
        testedAt,
        imap.ok && smtp.ok ? 1 : 0,
        config.id,
        config.updated_at,
        config.password_enc,
        config.imap_host,
        config.imap_port,
        config.smtp_host,
        config.smtp_port,
        config.username,
      );
      return res.json({ ok: true, imap, smtp, tested_at: testedAt });
    } catch {
      return res.status(502).json({ error: "mailbox_test_failed" });
    } finally {
      testing.delete(config.id);
    }
  };
  app.post(`${base}/accounts/:id/test`, (req, res) =>
    test(
      db.prepare("SELECT * FROM business_mailboxes WHERE id=?").get(String(req.params.id)) as MailboxRow | undefined,
      res,
    ),
  );
  app.post(`${base}/:business/test`, (req, res) => {
    const business = String(req.params.business);
    if (business !== "tech" && business !== "rental") return res.status(400).json({ error: "invalid_business" });
    return test(
      db.prepare("SELECT * FROM business_mailboxes WHERE business=? AND is_default=1").get(business) as
        | MailboxRow
        | undefined,
      res,
    );
  });
}
