import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const network = vi.hoisted(() => {
  process.env.OAUTH_ENCRYPTION_SECRET = "business-email-test-key";
  return { createTransport: vi.fn(), sendMail: vi.fn(), close: vi.fn() };
});
vi.mock("nodemailer", () => ({ default: { createTransport: network.createTransport } }));
import { encryptSecret } from "../../../oauth/helpers.ts";
import { SESSION_COOKIE_NAME } from "../../../config/runtime.ts";
import { createSessionToken } from "../../../security/login-sessions.ts";
import { getCsrfToken } from "../../../security/auth.ts";
import { ensureBusinessSchema } from "./business.ts";
import { ensureBusinessMailboxSchema } from "./business-mailboxes.ts";
import {
  ensureBusinessEmailSchema,
  decideBusinessEmail,
  getEmailApprovalStatus,
  listEmailApprovals,
  registerBusinessEmailRoutes,
  requestEmailApproval,
} from "./business-email.ts";

const databases: DatabaseSync[] = [];
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  ensureBusinessSchema(db);
  ensureBusinessMailboxSchema(db);
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,assigned_agent_id TEXT,status TEXT);
    INSERT INTO tasks VALUES('task','agent','in_progress');
    INSERT INTO business_contacts(id,business,name,email,created_at,updated_at)
      VALUES('contact','tech','Test recipient',' Recipient@Example.com ',1,1);
    INSERT INTO business_drafts(id,business,contact_id,channel,purpose,subject,body,status,created_at,updated_at)
      VALUES('draft','tech','contact','email','general','Hello','Exact plain text body','ready',1,1);`);
  db.prepare(
    `INSERT INTO business_mailboxes(id,is_default,business,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
    VALUES('tech',1,'tech','info@example.com','info@example.com','mail.example.com',993,'mail.example.com',465,?,1)`,
  ).run(encryptSecret("private-mail-password"));
  const app = express();
  app.use(express.json());
  registerBusinessEmailRoutes(app, db);
  const approve = (id: string, approve = true) =>
    request(app)
      .post(`/api/business/email-approvals/${id}/decide`)
      .set("x-csrf-token", getCsrfToken())
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`)
      .send({ approve });
  return { app, db, approve, create: () => requestEmailApproval(db, "draft", "task", "agent") };
}
beforeEach(() => {
  vi.clearAllMocks();
  network.createTransport.mockReturnValue({ sendMail: network.sendMail, close: network.close });
  network.sendMail.mockResolvedValue({ accepted: ["recipient@example.com"], rejected: [] });
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("owner-approved business email", () => {
  it("refuses worker self-approval through a local bootstrap cookie even when its task header is omitted", async () => {
    const { app, db, create } = harness();
    const approval = create();
    await request(app)
      .post(`/api/business/email-approvals/${approval.id}/decide`)
      .set("x-csrf-token", getCsrfToken())
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("local")}`)
      .send({ approve: true })
      .expect(403);
    expect(getEmailApprovalStatus(db, approval.id, "task", "agent")?.status).toBe("pending");
    expect(network.sendMail).not.toHaveBeenCalled();
  });

  it("shares the immutable send transition with server VP decisions and records who decided", async () => {
    const { db, create } = harness();
    db.exec(
      "UPDATE business_mailboxes SET business='ventures'; UPDATE business_contacts SET business='ventures'; UPDATE business_drafts SET business='ventures'",
    );
    const approval = create();
    const result = await decideBusinessEmail(db, approval.id, true, { decidedBy: "vp:codex,claude" });
    expect(result.body.item?.status).toBe("sent");
    expect(db.prepare("SELECT decided_by FROM business_email_approvals WHERE id=?").get(approval.id)).toEqual({
      decided_by: "vp:codex,claude",
    });
    expect((await decideBusinessEmail(db, approval.id, true, { decidedBy: "vp:codex,claude" })).status).toBe(409);
    expect(network.sendMail).toHaveBeenCalledTimes(1);
  });

  it("keeps the owner floor when the shared executor is called with a VP attribution", async () => {
    const { db, create } = harness();
    const approval = create();
    expect((await decideBusinessEmail(db, approval.id, true, { decidedBy: "vp:codex,claude" })).body.error).toBe(
      "owner_approval_required",
    );
    expect(network.sendMail).not.toHaveBeenCalled();
  });
  it("binds explicit mailbox selection and preserves its sender when the business default changes", async () => {
    const { db, approve } = harness();
    db.exec(`INSERT INTO business_mailboxes(id,business,is_default,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
      SELECT 'support',business,0,'support@example.com','support-login',imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at FROM business_mailboxes WHERE id='tech'`);
    const approval = requestEmailApproval(db, "draft", "task", "agent", "support");
    expect(approval).toMatchObject({ mailbox_id: "support", sender: "support@example.com" });
    expect(() => requestEmailApproval(db, "draft", "task", "agent", "rental")).toThrow("mailbox_not_configured");
    db.exec(
      "UPDATE business_mailboxes SET is_default=0; UPDATE business_mailboxes SET is_default=1 WHERE id='support'",
    );
    expect((await approve(approval.id)).body.item.status).toBe("sent");
    expect(network.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: { address: "support@example.com", name: "" } }),
    );
    expect(network.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "support-login", pass: "private-mail-password" } }),
    );
  });

  it("keeps legacy queued approval hashes and sender valid across account and approval migration", async () => {
    const { db, approve, create } = harness();
    const queued = create();
    const previous = db
      .prepare("SELECT snapshot_sha256,mailbox_sha256,message_id FROM business_email_approvals WHERE id=?")
      .get(queued.id);
    db.exec(`ALTER TABLE business_mailboxes RENAME TO new_mailboxes;
      CREATE TABLE business_mailboxes AS SELECT business,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at,last_test_at,last_test_ok FROM new_mailboxes;
      DROP TABLE new_mailboxes;
      ALTER TABLE business_email_approvals DROP COLUMN mailbox_id;`);
    ensureBusinessMailboxSchema(db);
    ensureBusinessEmailSchema(db);
    expect(
      db
        .prepare("SELECT snapshot_sha256,mailbox_sha256,message_id FROM business_email_approvals WHERE id=?")
        .get(queued.id),
    ).toEqual(previous);
    expect(getEmailApprovalStatus(db, queued.id, "task", "agent")).toMatchObject({
      mailbox_id: "tech",
      sender: "info@example.com",
      status: "pending",
    });
    expect((await approve(queued.id)).body.item.status).toBe("sent");
    await approve(queued.id).expect(409);
    expect(network.sendMail).toHaveBeenCalledOnce();
  });

  it("snapshots and deduplicates a draft, sends only the exact owner-approved plain text once", async () => {
    const { app, db, approve, create } = harness();
    const approval = create();
    expect(create().id).toBe(approval.id);
    expect(approval).toMatchObject({
      sender: "info@example.com",
      recipient: "recipient@example.com",
      subject: "Hello",
      body: "Exact plain text body",
      status: "pending",
    });
    expect(network.sendMail).not.toHaveBeenCalled();
    const sent = await approve(approval.id).expect(200);
    expect(sent.body).toMatchObject({ ok: true, item: { status: "sent" } });
    expect(network.sendMail).toHaveBeenCalledWith({
      from: { address: approval.sender, name: "" },
      to: { address: approval.recipient, name: "" },
      envelope: { from: approval.sender, to: [approval.recipient] },
      subject: approval.subject,
      text: approval.body,
      messageId: approval.message_id,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(network.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: true,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        auth: { user: "info@example.com", pass: "private-mail-password" },
        logger: false,
      }),
    );
    await approve(approval.id).expect(409);
    expect(create().status).toBe("sent");
    expect(network.sendMail).toHaveBeenCalledOnce();
    const listed = await request(app).get("/api/business/email-approvals").expect(200);
    expect(listed.body.items[0]).not.toHaveProperty("mailbox_sha256");
    expect(JSON.stringify(listed.body)).not.toContain("private-mail-password");
    expect(JSON.stringify(listed.body)).not.toContain("v1:");
    expect(getEmailApprovalStatus(db, approval.id, "other", "agent")).toBeNull();
  });

  it("claims approval atomically before awaiting SMTP so concurrent owner clicks cannot send twice", async () => {
    const { approve, create } = harness();
    const approval = create();
    let resolveSend!: (value: unknown) => void;
    network.sendMail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const first = approve(approval.id).then((result) => result);
    await vi.waitFor(() => expect(network.sendMail).toHaveBeenCalledOnce());
    await approve(approval.id).expect(409);
    resolveSend({ accepted: [approval.recipient] });
    expect((await first).body.item.status).toBe("sent");
    expect(network.sendMail).toHaveBeenCalledOnce();
  });

  it("uses the rental draft's matching mailbox rather than the tech sender", async () => {
    const { db, approve } = harness();
    db.exec(`UPDATE business_contacts SET business='rental' WHERE id='contact';
      UPDATE business_drafts SET business='rental' WHERE id='draft';
      UPDATE business_mailboxes SET business='rental',email='events@example.com',username='events-login' WHERE business='tech';`);
    const approval = requestEmailApproval(db, "draft", "task", "agent");
    expect(approval).toMatchObject({ business: "rental", sender: "events@example.com" });
    await approve(approval.id).expect(200);
    expect(network.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: { address: "events@example.com", name: "" } }),
    );
    expect(network.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: "events-login", pass: "private-mail-password" } }),
    );
  });

  it("denies without contacting SMTP and never reopens a denied snapshot", async () => {
    const { approve, create } = harness();
    const approval = create();
    const denied = await approve(approval.id, false).expect(200);
    expect(denied.body.item.status).toBe("denied");
    expect(create().status).toBe("denied");
    await approve(approval.id).expect(409);
    expect(network.createTransport).not.toHaveBeenCalled();
  });

  it.each([
    "UPDATE business_drafts SET body='Changed' WHERE id='draft'",
    "UPDATE business_contacts SET email='someoneelse@example.com' WHERE id='contact'",
    "UPDATE business_mailboxes SET smtp_host='changed.example.com' WHERE business='tech'",
    "UPDATE business_contacts SET do_not_contact=1 WHERE id='contact'",
  ])("invalidates a pending approval after a relevant edit: %s", async (sql) => {
    const { db, approve, create } = harness();
    const approval = create();
    db.exec(sql);
    const result = await approve(approval.id).expect(409);
    expect(result.body).toMatchObject({ ok: false, error: "email_approval_invalidated", item: { status: "failed" } });
    expect(network.sendMail).not.toHaveBeenCalled();
  });

  it("suppresses by normalized email across both businesses and validates task/contact scope", () => {
    const { db, create } = harness();
    db.exec(`INSERT INTO business_contacts(id,business,name,email,do_not_contact,created_at,updated_at)
      VALUES('duplicate','rental','Opted out','RECIPIENT@example.com',1,1,1)`);
    expect(create).toThrow("contact_do_not_contact");
    db.exec(
      "DELETE FROM business_contacts WHERE id='duplicate'; UPDATE business_contacts SET business='rental' WHERE id='contact'",
    );
    expect(create).toThrow("email_contact_business_mismatch");
    db.exec("UPDATE business_contacts SET business='tech' WHERE id='contact'; UPDATE tasks SET status='done'");
    expect(create).toThrow("agent_task_not_active");
    expect(listEmailApprovals(db)).toHaveLength(0);
  });

  it("treats an ambiguous SMTP timeout as unknown, redacts details and never retries", async () => {
    const { approve, create } = harness();
    const approval = create();
    network.sendMail.mockRejectedValue(
      Object.assign(new Error("private-mail-password raw server details"), { code: "ETIMEDOUT" }),
    );
    const failed = await approve(approval.id).expect(200);
    expect(failed.body).toMatchObject({
      ok: false,
      error: "email_delivery_unknown",
      item: { status: "unknown", sent_at: null },
    });
    expect(JSON.stringify(failed.body)).not.toContain("private-mail-password");
    await approve(approval.id).expect(409);
    expect(create().status).toBe("unknown");
    expect(network.sendMail).toHaveBeenCalledOnce();
  });

  it("records definitive SMTP authentication failure accurately and preserves sent status if cleanup fails", async () => {
    const { db, approve, create } = harness();
    const approval = create();
    network.sendMail.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "EAUTH" }));
    expect((await approve(approval.id)).body).toMatchObject({
      ok: false,
      item: { status: "failed", error_code: "email_authentication_failed" },
    });
    db.exec("UPDATE business_drafts SET subject='Another email'");
    const second = create();
    network.close.mockImplementationOnce(() => {
      throw new Error("cleanup");
    });
    expect((await approve(second.id)).body).toMatchObject({ ok: true, item: { status: "sent" } });
  });

  it("requires owner CSRF authorization and rejects task-worker headers on owner routes", async () => {
    const { app, create } = harness();
    const approval = create();
    await request(app).post(`/api/business/email-approvals/${approval.id}/decide`).send({ approve: true }).expect(403);
    await request(app)
      .post(`/api/business/email-approvals/${approval.id}/decide`)
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "worker")
      .send({ approve: true })
      .expect(403);
    await request(app).get("/api/business/email-approvals").set("x-agent-task-token", "worker").expect(403);
    expect(network.sendMail).not.toHaveBeenCalled();
  });

  it("recovers interrupted sends as unknown on startup without retrying", () => {
    const { app, db, create } = harness();
    const approval = create();
    db.prepare("UPDATE business_email_approvals SET status='sending' WHERE id=?").run(approval.id);
    ensureBusinessEmailSchema(db);
    registerBusinessEmailRoutes(app, db);
    expect(getEmailApprovalStatus(db, approval.id, "task", "agent")).toMatchObject({
      status: "unknown",
      error_code: "email_delivery_unknown",
    });
    expect(network.sendMail).not.toHaveBeenCalled();
  });
});
