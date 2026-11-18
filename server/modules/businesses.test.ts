import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BUSINESSES, BUSINESS_KEYS, isBusinessKey, syncBusinessCheck } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import { ensureBusinessSchema } from "./routes/ops/business.ts";
import { ensureBusinessProfilesSchema } from "./routes/ops/business-profiles.ts";
import { ensureBusinessMailboxSchema } from "./routes/ops/business-mailboxes.ts";
import { ensureBusinessEmailSchema } from "./routes/ops/business-email.ts";
import { ensureBusinessSocialSchema } from "./routes/ops/business-social.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

/** A database exactly as an install from before the ventures business has it: two businesses pinned by CHECKs. */
function oldDatabase() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE business_contacts (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('tech','rental')),
      name TEXT NOT NULL, email TEXT, phone TEXT, notes TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    ALTER TABLE business_contacts ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE business_tickets (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL DEFAULT 'tech' CHECK (business = 'tech'),
      contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL, device TEXT, description TEXT,
      status TEXT NOT NULL CHECK (status IN ('new','scheduled','active','waiting','done')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE business_drafts (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('tech','rental')),
      contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email','social','sms')),
      purpose TEXT NOT NULL CHECK (purpose IN ('outreach','promotion','follow_up','checkin','checkout','general')),
      subject TEXT, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','ready','archived')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_business_contacts_business ON business_contacts(business, updated_at DESC);
    CREATE INDEX idx_business_drafts_business ON business_drafts(business, status, updated_at DESC);
    CREATE TABLE business_profiles (
      business TEXT PRIMARY KEY CHECK (business IN ('tech','rental')),
      name TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      service_area TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', brand_voice TEXT NOT NULL DEFAULT '',
      social_profiles TEXT NOT NULL DEFAULT '', services TEXT NOT NULL DEFAULT '', workflow_notes TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE business_mailboxes (
      id TEXT PRIMARY KEY NOT NULL,
      business TEXT NOT NULL CHECK(business IN ('tech','rental')),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
      email TEXT NOT NULL, username TEXT NOT NULL,
      imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL CHECK(imap_port BETWEEN 1 AND 65535),
      smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL CHECK(smtp_port BETWEEN 1 AND 65535),
      password_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
      last_test_at INTEGER, last_test_ok INTEGER CHECK(last_test_ok IN (0,1))
    );
    CREATE UNIQUE INDEX idx_mailbox_business_email ON business_mailboxes(business,lower(trim(email)));
    CREATE UNIQUE INDEX idx_mailbox_business_default ON business_mailboxes(business) WHERE is_default=1;
    CREATE TABLE business_email_approvals (
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      business TEXT NOT NULL CHECK(business IN ('tech','rental')),
      sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','denied','failed','unknown')),
      snapshot_sha256 TEXT NOT NULL, draft_sha256 TEXT NOT NULL, contact_sha256 TEXT NOT NULL, mailbox_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL, decided_at INTEGER, sent_at INTEGER, message_id TEXT NOT NULL, error_code TEXT,
      UNIQUE(draft_id,snapshot_sha256)
    );
    ALTER TABLE business_email_approvals ADD COLUMN mailbox_id TEXT;
    CREATE TABLE business_social_accounts (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN ('tech','rental')),
      platform TEXT NOT NULL CHECK(platform = 'instagram'),
      username TEXT NOT NULL, token_enc TEXT NOT NULL DEFAULT '', provider_user_id TEXT, display_name TEXT,
      last_test_at INTEGER, last_test_ok INTEGER CHECK(last_test_ok IN (0,1)), updated_at INTEGER NOT NULL,
      UNIQUE(business,platform,username)
    );

    INSERT INTO business_contacts VALUES ('c1','tech','Dana','dana@example.com',NULL,'likes mornings',1,2,1);
    INSERT INTO business_contacts VALUES ('c2','rental','Lee',NULL,'555',NULL,3,4,0);
    INSERT INTO business_tickets VALUES ('t1','tech','c1','Slow laptop',NULL,NULL,'new',1,1);
    INSERT INTO business_drafts VALUES ('d1','tech','c1','email','follow_up','Hi','Body','ready',5,6);
    INSERT INTO business_profiles (business,name) VALUES ('tech','Small Business Tech'), ('rental','Primrose Events');
    INSERT INTO business_mailboxes VALUES ('m1','tech',1,'info@example.com','info','mail.example.com',993,'mail.example.com',465,'v1:cipher',7,8,1);
    INSERT INTO business_email_approvals VALUES ('e1','d1','task','agent','tech','info@example.com','dana@example.com','Hi','Body','sent','a','b','c','d',9,10,11,'<m@x>',NULL,'m1');
    INSERT INTO business_social_accounts VALUES ('s1','rental','instagram','primrose','v1:token',NULL,NULL,NULL,NULL,12);`);
  return db;
}

function upgrade(db: DatabaseSync) {
  ensureBusinessSchema(db);
  ensureBusinessProfilesSchema(db);
  ensureBusinessMailboxSchema(db);
  ensureBusinessEmailSchema(db);
  ensureBusinessSocialSchema(db);
}

const TABLES = [
  "business_contacts",
  "business_drafts",
  "business_profiles",
  "business_mailboxes",
  "business_email_approvals",
  "business_social_accounts",
];
const dump = (db: DatabaseSync) =>
  Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));

describe("business registry", () => {
  it("lists the three businesses and who approves their customer-facing work", () => {
    expect([...BUSINESS_KEYS]).toEqual(["tech", "rental", "ventures"]);
    expect(businessPolicy("tech").customer_sends).toBe("owner");
    expect(businessPolicy("rental").customer_sends).toBe("owner");
    expect(businessPolicy("ventures").customer_sends).toBe("vp");
    expect(BUSINESSES.rental.label).toBe("Events and rentals business");
    expect(isBusinessKey("ventures")).toBe(true);
    expect(isBusinessKey("stripe")).toBe(false);
    expect(isBusinessKey(undefined)).toBe(false);
  });
});

describe("upgrading a database from before the ventures business", () => {
  it("keeps every existing row and link exactly as it was", () => {
    const db = oldDatabase();
    const before = dump(db);
    const ticketBefore = db.prepare("SELECT * FROM business_tickets").all();
    upgrade(db);
    const after = dump(db);
    for (const table of TABLES) {
      // New columns and the new empty ventures profile are additions; nothing that existed may differ.
      const kept = (after[table] as Array<Record<string, unknown>>).filter((row) => row.business !== "ventures");
      expect(kept.length).toBe(before[table].length);
      kept.forEach((row, index) => expect(row).toMatchObject(before[table][index] as Record<string, unknown>));
    }
    // Rebuilding the contacts table must not clear the contact link on tickets and drafts.
    expect(db.prepare("SELECT * FROM business_tickets").all()).toEqual(ticketBefore);
    expect(db.prepare("SELECT contact_id FROM business_drafts WHERE id='d1'").get()).toEqual({ contact_id: "c1" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("then accepts ventures everywhere and still rejects unknown businesses", () => {
    const db = oldDatabase();
    upgrade(db);
    db.exec(`INSERT INTO business_contacts (id,business,name,created_at,updated_at) VALUES ('c3','ventures','Etsy buyer',1,1);
      INSERT INTO business_drafts (id,business,contact_id,channel,purpose,body,status,created_at,updated_at)
        VALUES ('d2','ventures','c3','email','general','Thanks','draft',1,1);
      INSERT INTO business_mailboxes (id,business,is_default,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
        VALUES ('m2','ventures',1,'office@example.com','office','mail.example.com',993,'mail.example.com',587,'',1);
      INSERT INTO business_social_accounts (id,business,platform,username,updated_at) VALUES ('s2','ventures','instagram','shop',1);
      INSERT INTO business_email_approvals (id,draft_id,task_id,agent_id,business,sender,recipient,subject,body,status,snapshot_sha256,draft_sha256,contact_sha256,mailbox_sha256,created_at,decided_at,sent_at,message_id,error_code,mailbox_id) VALUES ('e2','d2','task','agent','ventures','office@example.com','b@example.com','Hi','Body','pending','a2','b','c','d',9,NULL,NULL,'<m2@x>',NULL,'m2');`);
    expect(db.prepare("SELECT business FROM business_profiles ORDER BY business").all()).toEqual([
      { business: "rental" },
      { business: "tech" },
      { business: "ventures" },
    ]);
    for (const table of ["business_contacts", "business_drafts", "business_mailboxes", "business_social_accounts"]) {
      expect(() => db.exec(`UPDATE ${table} SET business = 'somewhere-else'`)).toThrow(/CHECK/i);
    }
  });

  it("keeps the indexes, including the one-default-mailbox rule", () => {
    const db = oldDatabase();
    upgrade(db);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
      .map((index) => index.name)
      .filter((name) => !name.startsWith("sqlite_"));
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_business_contacts_business",
        "idx_business_drafts_business",
        "idx_mailbox_business_email",
        "idx_mailbox_business_default",
      ]),
    );
    expect(() =>
      db.exec(`INSERT INTO business_mailboxes (id,business,is_default,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
        VALUES ('m9','tech',1,'second@example.com','x','h',993,'h',465,'',1)`),
    ).toThrow(/UNIQUE/i);
  });

  it("does nothing the second time", () => {
    const db = oldDatabase();
    upgrade(db);
    const schema = () => db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const once = schema();
    const rows = dump(db);
    for (const table of TABLES) expect(syncBusinessCheck(db, table)).toBe(false);
    upgrade(db);
    expect(schema()).toEqual(once);
    expect(dump(db)).toEqual(rows);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__rebuild'").all()).toEqual([]);
  });

  it("ignores tables that do not exist or have no business rule", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec("CREATE TABLE plain (id TEXT)");
    expect(syncBusinessCheck(db, "plain")).toBe(false);
    expect(syncBusinessCheck(db, "missing_table")).toBe(false);
    expect(() => syncBusinessCheck(db, "x; DROP TABLE plain")).toThrow(/unsafe/);
  });
});
