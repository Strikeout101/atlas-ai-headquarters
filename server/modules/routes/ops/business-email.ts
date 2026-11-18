import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import nodemailer from "nodemailer";
import { decryptSecret } from "../../../oauth/helpers.ts";
import { hasValidCsrfToken, shouldRequireCsrf, requireOwnerSession } from "../../../security/auth.ts";
import { BUSINESS_SQL_LIST, syncBusinessCheck } from "../../businesses.ts";
import { routeApproval, type ApprovalFacts } from "../../approval-policy.ts";
import { contactFacts } from "../../approval-facts.ts";
import { recordApprovalDecision } from "../../trust-ramp.ts";
import { smtpSecurityOptions } from "./business-mailboxes.ts";

type Row = Record<string, string | number | null>;
export type EmailApprovalStatus = "pending" | "sending" | "sent" | "denied" | "failed" | "unknown";
export type EmailApproval = {
  id: string;
  draft_id: string;
  task_id: string;
  agent_id: string;
  business: string;
  mailbox_id: string | null;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailApprovalStatus;
  created_at: number;
  decided_at: number | null;
  sent_at: number | null;
  message_id: string;
  error_code: string | null;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalizeEmail = (email: unknown) => (typeof email === "string" ? email.trim().toLowerCase() : "");
const isEmail = (email: string) =>
  email.length <= 320 && /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(email);

export function ensureBusinessEmailSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_email_approvals (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','denied','failed','unknown')),
    snapshot_sha256 TEXT NOT NULL, draft_sha256 TEXT NOT NULL, contact_sha256 TEXT NOT NULL, mailbox_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL, decided_at INTEGER, sent_at INTEGER, message_id TEXT NOT NULL, error_code TEXT,
    UNIQUE(draft_id,snapshot_sha256)
  ); CREATE INDEX IF NOT EXISTS idx_business_email_approvals_status ON business_email_approvals(status,created_at DESC)`);
  const columns = db.prepare("PRAGMA table_info(business_email_approvals)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "mailbox_id")) {
    db.exec("ALTER TABLE business_email_approvals ADD COLUMN mailbox_id TEXT");
    // Legacy rows always refer to the single business account, migrated with its business as its stable id.
    db.exec("UPDATE business_email_approvals SET mailbox_id=business WHERE mailbox_id IS NULL");
  }
  if (!columns.some((column) => column.name === "decided_by"))
    db.exec("ALTER TABLE business_email_approvals ADD COLUMN decided_by TEXT");
  syncBusinessCheck(db, "business_email_approvals");
}

function publicApproval(row: Row): EmailApproval {
  const keys = [
    "id",
    "draft_id",
    "task_id",
    "agent_id",
    "business",
    "mailbox_id",
    "sender",
    "recipient",
    "subject",
    "body",
    "status",
    "created_at",
    "decided_at",
    "sent_at",
    "message_id",
    "error_code",
  ];
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as EmailApproval;
}

function activeTask(db: DatabaseSync, taskId: string, agentId: string): void {
  const task = db.prepare("SELECT assigned_agent_id,status FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (!task || task.assigned_agent_id !== agentId || task.status !== "in_progress")
    throw new Error("agent_task_not_active");
}

function snapshot(db: DatabaseSync, draftId: string, mailboxId?: string | null) {
  const draft = db.prepare("SELECT * FROM business_drafts WHERE id=?").get(draftId) as Row | undefined;
  if (!draft) throw new Error("email_draft_not_found");
  if (draft.channel !== "email" || draft.status === "archived") throw new Error("email_draft_not_sendable");
  const contact = db.prepare("SELECT * FROM business_contacts WHERE id=?").get(draft.contact_id) as Row | undefined;
  if (!contact || contact.business !== draft.business) throw new Error("email_contact_business_mismatch");
  const recipient = normalizeEmail(contact.email);
  if (!isEmail(recipient)) throw new Error("invalid_recipient_email");
  const suppressed = db
    .prepare("SELECT 1 FROM business_contacts WHERE lower(trim(email))=? AND do_not_contact=1 LIMIT 1")
    .get(recipient);
  if (suppressed) throw new Error("contact_do_not_contact");
  const mailbox = (
    mailboxId
      ? db.prepare("SELECT * FROM business_mailboxes WHERE id=? AND business=?").get(mailboxId, draft.business)
      : db.prepare("SELECT * FROM business_mailboxes WHERE business=? AND is_default=1").get(draft.business)
  ) as Row | undefined;
  if (!mailbox?.password_enc) throw new Error("mailbox_not_configured");
  const sender = normalizeEmail(mailbox.email);
  if (!isEmail(sender)) throw new Error("invalid_sender_email");
  const subject = typeof draft.subject === "string" ? draft.subject : "";
  const body = typeof draft.body === "string" ? draft.body : "";
  if (subject.length > 320 || /[\r\n\0]/.test(subject) || !body.trim() || body.length > 12000 || body.includes("\0")) {
    throw new Error("invalid_email_content");
  }
  const mailIdentity = {
    email: mailbox.email,
    username: mailbox.username,
    smtp_host: mailbox.smtp_host,
    smtp_port: mailbox.smtp_port,
    password_enc: mailbox.password_enc,
    updated_at: mailbox.updated_at,
    // Only part of the identity when it differs from the original behaviour, so earlier approvals stay valid.
    ...(mailbox.smtp_security === "starttls" ? { smtp_security: "starttls" } : {}),
  };
  const content = { business: String(draft.business), sender, recipient, subject, body };
  return {
    ...content,
    mailbox,
    snapshot_sha256: hash(content),
    draft_sha256: hash(draft),
    contact_sha256: hash(contact),
    mailbox_sha256: hash(mailIdentity),
  };
}

/** Called only after gateway token verification; verifies current task assignment again. */
export function requestEmailApproval(
  db: DatabaseSync,
  draftId: string,
  taskId: string,
  agentId: string,
  mailboxId?: string | null,
): EmailApproval {
  activeTask(db, taskId, agentId);
  const input = snapshot(db, draftId, mailboxId);
  const id = randomUUID();
  const messageId = `<atlas-${id}@${input.sender.split("@")[1]}>`;
  db.prepare(
    `INSERT OR IGNORE INTO business_email_approvals
    (id,draft_id,task_id,agent_id,business,sender,recipient,subject,body,status,snapshot_sha256,draft_sha256,
      contact_sha256,mailbox_sha256,created_at,message_id,mailbox_id)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
  ).run(
    id,
    draftId,
    taskId,
    agentId,
    input.business,
    input.sender,
    input.recipient,
    input.subject,
    input.body,
    input.snapshot_sha256,
    input.draft_sha256,
    input.contact_sha256,
    input.mailbox_sha256,
    Date.now(),
    messageId,
    input.mailbox.id,
  );
  const row = db
    .prepare("SELECT * FROM business_email_approvals WHERE draft_id=? AND snapshot_sha256=?")
    .get(draftId, input.snapshot_sha256) as Row;
  // Other tasks must not gain access to an approval or silently reuse another task's authorization.
  if (row.task_id !== taskId || row.agent_id !== agentId) throw new Error("email_snapshot_already_requested");
  return publicApproval(row);
}

export function getEmailApprovalStatus(
  db: DatabaseSync,
  id: string,
  taskId: string,
  agentId: string,
): EmailApproval | null {
  const row = db
    .prepare("SELECT * FROM business_email_approvals WHERE id=? AND task_id=? AND agent_id=?")
    .get(id, taskId, agentId) as Row | undefined;
  return row ? publicApproval(row) : null;
}

export function listEmailApprovals(db: DatabaseSync): EmailApproval[] {
  return (db.prepare("SELECT * FROM business_email_approvals ORDER BY created_at DESC LIMIT 200").all() as Row[]).map(
    publicApproval,
  );
}

function failure(error: unknown): { status: "failed" | "unknown"; error: string } {
  const e = error && typeof error === "object" ? (error as { code?: string; responseCode?: number }) : {};
  if (e.code === "EAUTH") return { status: "failed", error: "email_authentication_failed" };
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(e.code ?? ""))
    return { status: "failed", error: "email_connection_failed" };
  if (/TLS|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code ?? ""))
    return { status: "failed", error: "email_tls_verification_failed" };
  if (typeof e.responseCode === "number" && e.responseCode >= 400)
    return { status: "failed", error: "email_smtp_rejected" };
  return { status: "unknown", error: "email_delivery_unknown" };
}

/** Client tier and deal size of the email's recipient, from the draft's contact (never from the wording). */
function emailRoutingFacts(db: DatabaseSync, draftId: string): ApprovalFacts {
  const draft = db.prepare("SELECT contact_id FROM business_drafts WHERE id=?").get(draftId) as
    | { contact_id: string | null }
    | undefined;
  return contactFacts(db, draft?.contact_id);
}

export type EmailDecisionResult = { status: number; body: { ok?: boolean; error?: string; item?: EmailApproval } };

/** Server-internal execution; callers enforce policy before invoking this exact-content decision. */
export async function decideBusinessEmail(
  db: DatabaseSync,
  id: string,
  approve: boolean,
  { decidedBy = "owner" }: { decidedBy?: string } = {},
): Promise<EmailDecisionResult> {
  const row = db.prepare("SELECT * FROM business_email_approvals WHERE id=?").get(id) as Row | undefined;
  if (!row) return { status: 404, body: { error: "email_approval_not_found" } };
  if (
    decidedBy.startsWith("vp:") &&
    routeApproval("business_email", String(row.business), emailRoutingFacts(db, String(row.draft_id))) !== "vp"
  )
    return { status: 403, body: { error: "owner_approval_required" } };
  if (row.status !== "pending")
    return { status: 409, body: { error: "email_approval_not_pending", item: publicApproval(row) } };
  const result = () => publicApproval(db.prepare("SELECT * FROM business_email_approvals WHERE id=?").get(id) as Row);
  if (!approve) {
    db.prepare(
      "UPDATE business_email_approvals SET status='denied',decided_at=?,decided_by=? WHERE id=? AND status='pending'",
    ).run(Date.now(), decidedBy, id);
    recordApprovalDecision(db, {
      approvalKind: "business_email",
      business: row.business,
      agentId: String(row.agent_id),
      approve: false,
      decidedBy,
    });
    return { status: 200, body: { ok: true, item: result() } };
  }
  let current: ReturnType<typeof snapshot>;
  try {
    current = snapshot(db, String(row.draft_id), row.mailbox_id as string | null);
    if (
      ["snapshot_sha256", "draft_sha256", "contact_sha256", "mailbox_sha256"].some(
        (key) => current[key as keyof typeof current] !== row[key],
      )
    )
      throw new Error("email_snapshot_changed");
  } catch {
    db.prepare(
      "UPDATE business_email_approvals SET status='failed',error_code='email_approval_invalidated',decided_at=? WHERE id=? AND status='pending'",
    ).run(Date.now(), id);
    return { status: 409, body: { ok: false, error: "email_approval_invalidated", item: result() } };
  }
  // Claim before any await. Only one process can transition the persisted pending row.
  const claim = db
    .prepare(
      "UPDATE business_email_approvals SET status='sending',decided_at=?,decided_by=? WHERE id=? AND status='pending'",
    )
    .run(Date.now(), decidedBy, id);
  if (!claim.changes) return { status: 409, body: { error: "email_approval_not_pending", item: result() } };
  recordApprovalDecision(db, {
    approvalKind: "business_email",
    business: row.business,
    agentId: String(row.agent_id),
    approve: true,
    decidedBy,
  });
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    let password: string;
    try {
      password = decryptSecret(String(current.mailbox.password_enc));
    } catch {
      db.prepare(
        "UPDATE business_email_approvals SET status='failed',error_code='mailbox_credential_store_unavailable' WHERE id=? AND status='sending'",
      ).run(id);
      return { status: 200, body: { ok: false, error: "mailbox_credential_store_unavailable", item: result() } };
    }
    transport = nodemailer.createTransport({
      host: String(current.mailbox.smtp_host),
      port: Number(current.mailbox.smtp_port),
      ...smtpSecurityOptions(current.mailbox.smtp_security),
      auth: { user: String(current.mailbox.username), pass: password },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      logger: false,
      debug: false,
    });
    const sent = await transport.sendMail({
      from: { address: String(row.sender), name: "" },
      to: { address: String(row.recipient), name: "" },
      envelope: { from: String(row.sender), to: [String(row.recipient)] },
      subject: String(row.subject),
      text: String(row.body),
      messageId: String(row.message_id),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const accepted =
      Array.isArray(sent.accepted) &&
      sent.accepted.some(
        (email: unknown) =>
          normalizeEmail(typeof email === "object" && email !== null && "address" in email ? email.address : email) ===
          row.recipient,
      );
    const status = accepted ? "sent" : "unknown";
    db.prepare(
      "UPDATE business_email_approvals SET status=?,sent_at=?,error_code=? WHERE id=? AND status='sending'",
    ).run(status, accepted ? Date.now() : null, accepted ? null : "email_delivery_unknown", id);
    return {
      status: 200,
      body: { ok: accepted, ...(!accepted ? { error: "email_delivery_unknown" } : {}), item: result() },
    };
  } catch (error) {
    const failed = failure(error);
    db.prepare("UPDATE business_email_approvals SET status=?,error_code=? WHERE id=? AND status='sending'").run(
      failed.status,
      failed.error,
      id,
    );
    return { status: 200, body: { ok: false, error: failed.error, item: result() } };
  } finally {
    try {
      transport?.close();
    } catch {
      /* Cleanup must not change an already recorded SMTP result. */
    }
  }
}

export function registerBusinessEmailRoutes(app: Express, db: DatabaseSync): void {
  ensureBusinessEmailSchema(db);
  // A crash after SMTP acceptance cannot be distinguished from a crash before acceptance. Never retry it.
  db.prepare(
    "UPDATE business_email_approvals SET status='unknown',error_code='email_delivery_unknown' WHERE status='sending'",
  ).run();
  const base = "/api/business/email-approvals";
  app.use(base, (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (req.method !== "GET" && shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    next();
  });
  app.get(base, (_req, res) => res.json({ ok: true, items: listEmailApprovals(db) }));
  app.post(`${base}/:id/decide`, async (req, res) => {
    if (typeof req.body?.approve !== "boolean" || Object.keys(req.body).some((key) => key !== "approve")) {
      return res.status(400).json({ error: "approve_boolean_required" });
    }
    if (!requireOwnerSession(req, res)) return;
    const result = await decideBusinessEmail(db, String(req.params.id), req.body.approve, { decidedBy: "owner" });
    return res.status(result.status).json(result.body);
  });
}
