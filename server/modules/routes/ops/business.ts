import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Express } from "express";
import { registerBusinessProfileRoutes } from "./business-profiles.ts";
import {
  BUSINESS_KEYS,
  BUSINESS_SQL_LIST,
  isBusinessKey,
  syncBusinessCheck,
  type BusinessKey,
} from "../../businesses.ts";

type Business = BusinessKey;
type Body = Record<string, unknown>;

type Field = {
  name: string;
  required?: boolean;
  max?: number;
  values?: readonly string[];
  pattern?: RegExp;
  /** Stored instead of an empty value, for NOT NULL columns with a default. */
  fallback?: string;
};
type Entity = {
  path: string;
  table: string;
  business?: Business;
  fields: readonly Field[];
};

const BUSINESSES = BUSINESS_KEYS;
const TICKET_STATUSES = ["new", "scheduled", "active", "waiting", "done"] as const;
const QUOTE_STATUSES = ["draft", "shared", "accepted", "declined", "archived"] as const;
const DRAFT_STATUSES = ["draft", "ready", "archived"] as const;
const CHANNELS = ["email", "social", "sms"] as const;
const PURPOSES = ["outreach", "promotion", "follow_up", "checkin", "checkout", "general"] as const;
const FLAG_VALUES = ["0", "1"] as const;
/** Important and VIP clients go to the owner (business_policies.tier_to_owner). */
export const CLIENT_TIER_VALUES = ["normal", "important", "vip"] as const;

const ENTITIES: readonly Entity[] = [
  {
    path: "contacts",
    table: "business_contacts",
    fields: [
      { name: "business", required: true, values: BUSINESSES },
      { name: "name", required: true, max: 160 },
      { name: "email", max: 320 },
      { name: "phone", max: 80 },
      { name: "notes", max: 4000 },
      { name: "do_not_contact", values: FLAG_VALUES },
      { name: "tier", values: CLIENT_TIER_VALUES, fallback: "normal" },
    ],
  },
  {
    path: "tickets",
    table: "business_tickets",
    business: "tech",
    fields: [
      { name: "contact_id", max: 64 },
      { name: "title", required: true, max: 200 },
      { name: "device", max: 200 },
      { name: "description", max: 8000 },
      { name: "status", required: true, values: TICKET_STATUSES },
    ],
  },
  {
    path: "quotes",
    table: "business_quotes",
    business: "rental",
    fields: [
      { name: "contact_id", max: 64 },
      { name: "event_name", required: true, max: 200 },
      { name: "event_date", max: 40 },
      { name: "items", required: true, max: 8000 },
      { name: "quote_text", max: 8000 },
      { name: "status", required: true, values: QUOTE_STATUSES },
      // Quote total in cents, used for the owner's deal-size approval limit.
      { name: "total_minor", pattern: /^\d{1,13}$/ },
      { name: "currency", pattern: /^[A-Z]{3}$/, fallback: "USD" },
    ],
  },
  {
    path: "drafts",
    table: "business_drafts",
    fields: [
      { name: "business", required: true, values: BUSINESSES },
      { name: "contact_id", max: 64 },
      { name: "channel", required: true, values: CHANNELS },
      { name: "purpose", required: true, values: PURPOSES },
      { name: "subject", max: 320 },
      { name: "body", required: true, max: 12000 },
      { name: "status", required: true, values: DRAFT_STATUSES },
    ],
  },
];

/** Records and drafts only. This schema deliberately has no payment or send queue. */
export function ensureBusinessSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_contacts (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN (${BUSINESS_SQL_LIST})),
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_tickets (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL DEFAULT 'tech' CHECK (business = 'tech'),
      contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      device TEXT,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('new','scheduled','active','waiting','done')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_quotes (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL DEFAULT 'rental' CHECK (business = 'rental'),
      contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,
      event_name TEXT NOT NULL,
      event_date TEXT,
      items TEXT NOT NULL,
      quote_text TEXT,
      status TEXT NOT NULL CHECK (status IN ('draft','shared','accepted','declined','archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_drafts (
      id TEXT PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN (${BUSINESS_SQL_LIST})),
      contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,
      channel TEXT NOT NULL CHECK (channel IN ('email','social','sms')),
      purpose TEXT NOT NULL CHECK (purpose IN ('outreach','promotion','follow_up','checkin','checkout','general')),
      subject TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','ready','archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_business_contacts_business ON business_contacts(business, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_business_tickets_status ON business_tickets(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_business_quotes_status ON business_quotes(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_business_drafts_business ON business_drafts(business, status, updated_at DESC);
  `);
  const contactColumns = db.prepare("PRAGMA table_info(business_contacts)").all() as Array<{ name: string }>;
  if (!contactColumns.some((column) => column.name === "do_not_contact")) {
    db.exec("ALTER TABLE business_contacts ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0");
  }
  if (!contactColumns.some((column) => column.name === "tier"))
    db.exec(
      "ALTER TABLE business_contacts ADD COLUMN tier TEXT NOT NULL DEFAULT 'normal' CHECK(tier IN ('normal','important','vip'))",
    );
  const quoteColumns = new Set(
    (db.prepare("PRAGMA table_info(business_quotes)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!quoteColumns.has("total_minor"))
    db.exec(
      "ALTER TABLE business_quotes ADD COLUMN total_minor INTEGER CHECK(total_minor IS NULL OR (typeof(total_minor)='integer' AND total_minor >= 0))",
    );
  if (!quoteColumns.has("currency"))
    db.exec("ALTER TABLE business_quotes ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  // Older databases only allow the first two businesses in these tables.
  syncBusinessCheck(db, "business_contacts");
  syncBusinessCheck(db, "business_drafts");
}

function isDoNotContact(db: DatabaseSync, contactId: unknown): boolean {
  if (typeof contactId !== "string" || !contactId) return false;
  const row = db.prepare("SELECT do_not_contact FROM business_contacts WHERE id = ?").get(contactId) as
    | { do_not_contact: number }
    | undefined;
  return Number(row?.do_not_contact ?? 0) === 1;
}

function isBody(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readValues(entity: Entity, body: Body, partial: boolean): { values: Body; error?: string } {
  const values: Body = {};
  for (const field of entity.fields) {
    if (!(field.name in body)) {
      if (field.required && !partial) return { values, error: `${field.name}_required` };
      continue;
    }
    const raw = body[field.name];
    if (raw !== null && typeof raw !== "string") return { values, error: `invalid_${field.name}` };
    const value = (typeof raw === "string" ? raw.trim() || null : null) ?? field.fallback ?? null;
    if (field.required && !value) return { values, error: `${field.name}_required` };
    if (value !== null && field.max && value.length > field.max) return { values, error: `${field.name}_too_long` };
    if (value && field.values && !field.values.includes(value)) return { values, error: `invalid_${field.name}` };
    if (value && field.pattern && !field.pattern.test(value)) return { values, error: `invalid_${field.name}` };
    values[field.name] = value;
  }
  if (partial && Object.keys(values).length === 0) return { values, error: "no_fields_to_update" };
  return { values };
}

function contactBelongsToBusiness(db: DatabaseSync, contactId: unknown, business: Business): boolean {
  if (contactId === null || contactId === undefined || contactId === "") return true;
  if (typeof contactId !== "string") return false;
  const row = db.prepare("SELECT business FROM business_contacts WHERE id = ?").get(contactId) as
    | { business: string }
    | undefined;
  return row?.business === business;
}

export function registerBusinessRoutes(app: Express, db: DatabaseSync): void {
  ensureBusinessSchema(db);
  registerBusinessProfileRoutes(app, db);

  for (const entity of ENTITIES) {
    const base = `/api/business/${entity.path}`;

    app.get(base, (req, res) => {
      const business = entity.business ?? req.query.business;
      if (business !== undefined && !isBusinessKey(business)) {
        return res.status(400).json({ error: "invalid_business" });
      }
      const status = req.query.status;
      const statusField = entity.fields.find((field) => field.name === "status");
      if (
        status !== undefined &&
        (!statusField?.values || typeof status !== "string" || !statusField.values.includes(status))
      ) {
        return res.status(400).json({ error: "invalid_status" });
      }
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (business) {
        where.push("business = ?");
        params.push(business);
      }
      if (status) {
        where.push("status = ?");
        params.push(status as string);
      }
      const sql = `SELECT * FROM ${entity.table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`;
      const items = db.prepare(sql).all(...params);
      return res.json({ ok: true, items });
    });

    app.get(`${base}/:id`, (req, res) => {
      const item = db.prepare(`SELECT * FROM ${entity.table} WHERE id = ?`).get(String(req.params.id));
      return item ? res.json({ ok: true, item }) : res.status(404).json({ error: "not_found" });
    });

    app.post(base, (req, res) => {
      if (!isBody(req.body)) return res.status(400).json({ error: "invalid_body" });
      const input = entity.business ? { ...req.body, business: entity.business } : req.body;
      const parsed = readValues(entity, input, false);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const business = (entity.business ?? parsed.values.business) as Business;
      if (!contactBelongsToBusiness(db, parsed.values.contact_id, business)) {
        return res.status(400).json({ error: "contact_business_mismatch" });
      }
      if (
        entity.path === "drafts" &&
        parsed.values.status === "ready" &&
        isDoNotContact(db, parsed.values.contact_id)
      ) {
        return res.status(409).json({ error: "contact_do_not_contact" });
      }
      const id = randomUUID();
      const now = Date.now();
      const columns = [
        "id",
        "business",
        ...Object.keys(parsed.values).filter((key) => key !== "business"),
        "created_at",
        "updated_at",
      ];
      const values: SQLInputValue[] = [
        id,
        business,
        ...Object.entries(parsed.values)
          .filter(([key]) => key !== "business")
          .map(([, value]) => value as SQLInputValue),
        now,
        now,
      ];
      db.prepare(
        `INSERT INTO ${entity.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...values);
      const item = db.prepare(`SELECT * FROM ${entity.table} WHERE id = ?`).get(id);
      return res.status(201).json({ ok: true, item });
    });

    app.patch(`${base}/:id`, (req, res) => {
      const id = String(req.params.id);
      const current = db.prepare(`SELECT * FROM ${entity.table} WHERE id = ?`).get(id) as Body | undefined;
      if (!current) return res.status(404).json({ error: "not_found" });
      if (!isBody(req.body)) return res.status(400).json({ error: "invalid_body" });
      if ("business" in req.body && req.body.business !== current.business) {
        return res.status(400).json({ error: "business_immutable" });
      }
      const parsed = readValues(entity, req.body, true);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const business = current.business as Business;
      const contactId = "contact_id" in parsed.values ? parsed.values.contact_id : current.contact_id;
      if (!contactBelongsToBusiness(db, contactId, business)) {
        return res.status(400).json({ error: "contact_business_mismatch" });
      }
      if (entity.path === "drafts") {
        const status = "status" in parsed.values ? parsed.values.status : current.status;
        if (status === "ready" && isDoNotContact(db, contactId)) {
          return res.status(409).json({ error: "contact_do_not_contact" });
        }
      }
      delete parsed.values.business;
      const columns = Object.keys(parsed.values);
      if (columns.length === 0) return res.status(400).json({ error: "no_fields_to_update" });
      const values = columns.map((column) => parsed.values[column] as SQLInputValue);
      db.prepare(
        `UPDATE ${entity.table} SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ).run(...values, Date.now(), id);
      // Someone who asked not to be contacted must not have messages waiting to go out.
      if (entity.path === "contacts" && parsed.values.do_not_contact === "1") {
        db.prepare(
          "UPDATE business_drafts SET status = 'draft', updated_at = ? WHERE contact_id = ? AND status = 'ready'",
        ).run(Date.now(), id);
      }
      const item = db.prepare(`SELECT * FROM ${entity.table} WHERE id = ?`).get(id);
      return res.json({ ok: true, item });
    });

    app.delete(`${base}/:id`, (req, res) => {
      const result = db.prepare(`DELETE FROM ${entity.table} WHERE id = ?`).run(String(req.params.id));
      return result.changes ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
    });
  }
}
