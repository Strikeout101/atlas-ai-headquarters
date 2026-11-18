import type { DatabaseSync } from "node:sqlite";
import type { ApprovalFacts } from "./approval-policy.ts";

/**
 * Facts for approval routing, read from records rather than from the wording of a message: which client an item
 * touches (its tier) and how much money is at stake (the deal or quote amount). See business_policies for the
 * owner's limits that use them.
 */
type Row = Record<string, unknown>;

const OPEN_DEAL = "stage NOT IN ('paid','lost')";
const OPEN_QUOTE = "status NOT IN ('declined','archived')";

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}
function amount(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

type Money = { amountMinor: number; amountCurrency: string };
/** The larger of two amounts. Amounts in different currencies cannot be compared, so the result is marked mixed. */
function larger(a: Money | null, b: Money | null): Money | null {
  if (!a) return b;
  if (!b) return a;
  if (a.amountCurrency !== b.amountCurrency)
    return { amountMinor: Math.max(a.amountMinor, b.amountMinor), amountCurrency: "MIXED" };
  return a.amountMinor >= b.amountMinor ? a : b;
}

/** Tier of a contact, and the largest open deal or quote it has. */
export function contactFacts(db: DatabaseSync, contactId: unknown): ApprovalFacts {
  if (typeof contactId !== "string" || !contactId || !tableExists(db, "business_contacts")) return {};
  const contact = db.prepare("SELECT * FROM business_contacts WHERE id=?").get(contactId) as Row | undefined;
  if (!contact) return {};
  let money: Money | null = null;
  if (tableExists(db, "deals"))
    for (const row of db
      .prepare(`SELECT expected_amount_minor,currency FROM deals WHERE contact_id=? AND ${OPEN_DEAL}`)
      .all(contactId) as Row[]) {
      const value = amount(row.expected_amount_minor);
      if (value) money = larger(money, { amountMinor: value, amountCurrency: String(row.currency || "USD") });
    }
  if (tableExists(db, "business_quotes") && columnExists(db, "business_quotes", "total_minor"))
    for (const row of db
      .prepare(`SELECT total_minor,currency FROM business_quotes WHERE contact_id=? AND ${OPEN_QUOTE}`)
      .all(contactId) as Row[]) {
      const value = amount(row.total_minor);
      if (value) money = larger(money, { amountMinor: value, amountCurrency: String(row.currency || "USD") });
    }
  return {
    clientTier: typeof contact.tier === "string" ? contact.tier : "normal",
    amountMinor: money?.amountMinor ?? null,
    amountCurrency: money?.amountCurrency ?? null,
  };
}

const TABLE_FOR: Record<string, string> = {
  contacts: "business_contacts",
  tickets: "business_tickets",
  quotes: "business_quotes",
  deals: "deals",
};

/**
 * Facts for an agent's change to a record: the tier of the client it touches, the biggest amount involved (the change
 * itself, the record as it is now, and the client's other open deals and quotes), and whether it changes a tier.
 */
export function recordChangeFacts(
  db: DatabaseSync,
  change: { resource: string; target_id: string | null; payload: Record<string, unknown> },
): ApprovalFacts {
  const table = TABLE_FOR[change.resource];
  const current =
    change.target_id && table && tableExists(db, table)
      ? ((db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(change.target_id) as Row | undefined) ?? null)
      : null;
  const contactId =
    change.resource === "contacts"
      ? change.target_id
      : ((change.payload.contact_id as string | undefined) ?? (current?.contact_id as string | undefined) ?? null);
  const facts = contactFacts(db, contactId);
  // A change that moves a deal or quote to another client is judged by both clients.
  if (current?.contact_id && change.payload.contact_id && current.contact_id !== change.payload.contact_id) {
    const previous = contactFacts(db, current.contact_id);
    const rank = { normal: 0, important: 1, vip: 2 } as Record<string, number>;
    if ((rank[previous.clientTier ?? "normal"] ?? 3) > (rank[facts.clientTier ?? "normal"] ?? 3))
      facts.clientTier = previous.clientTier;
    const merged = larger(
      facts.amountMinor ? { amountMinor: facts.amountMinor, amountCurrency: facts.amountCurrency ?? "USD" } : null,
      previous.amountMinor
        ? { amountMinor: previous.amountMinor, amountCurrency: previous.amountCurrency ?? "USD" }
        : null,
    );
    facts.amountMinor = merged?.amountMinor ?? null;
    facts.amountCurrency = merged?.amountCurrency ?? null;
  }
  const own = (field: string, currencyField: string): Money | null => {
    const values = [change.payload, current].map((source) => {
      const value = amount(source?.[field]);
      return value ? { amountMinor: value, amountCurrency: String(source?.[currencyField] || "USD") } : null;
    });
    return larger(values[0], values[1]);
  };
  const recordMoney =
    change.resource === "deals"
      ? own("expected_amount_minor", "currency")
      : change.resource === "quotes"
        ? own("total_minor", "currency")
        : null;
  const total = larger(
    facts.amountMinor ? { amountMinor: facts.amountMinor, amountCurrency: facts.amountCurrency ?? "USD" } : null,
    recordMoney,
  );
  const tierChange =
    change.resource === "contacts" &&
    "tier" in change.payload &&
    String(change.payload.tier ?? "normal") !== String(current?.tier ?? "normal");
  return {
    ...facts,
    amountMinor: total?.amountMinor ?? null,
    amountCurrency: total?.amountCurrency ?? null,
    changesClientTier:
      tierChange ||
      (change.resource === "contacts" && !current && "tier" in change.payload && change.payload.tier !== "normal"),
  };
}
