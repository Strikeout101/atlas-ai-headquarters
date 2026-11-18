import type { DatabaseSync } from "node:sqlite";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy, saveBusinessPolicy } from "./business-policies.ts";

/**
 * Trust ramp: a track record of approval decisions per business, kind of work and agent. When the owner has approved
 * a kind of item `trust_ramp_after` times in a row with no denial, Settings > Businesses > Approvals offers to let the
 * two VPs approve that kind. It is only an offer: nothing changes until the owner accepts. Hard floors (spending,
 * paid accounts, terms, destructive SSH) and the client tier and amount limits are never part of the ramp.
 */
export const RAMP_KINDS = ["customer_sends", "record_changes", "code_pushes"] as const;
export type RampKind = (typeof RAMP_KINDS)[number];
const ALL_AGENTS = "*";

/** Which policy setting an approval kind falls under. */
export function rampKindFor(approvalKind: string): RampKind | null {
  if (["business_email", "social_send", "customer_send", "listing_publish"].includes(approvalKind))
    return "customer_sends";
  if (approvalKind === "record_change") return "record_changes";
  if (approvalKind === "code_push") return "code_pushes";
  return null;
}

export function ensureTrustRampSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_track_record (
    business TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0,
    owner_streak INTEGER NOT NULL DEFAULT 0, snoozed_until INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(business, kind, agent_id)
  )`);
}

/**
 * Records one decision. `owner_streak` counts the owner's approvals in a row; any denial resets it. VP decisions add
 * to the totals but not the streak, since the ramp asks whether the owner still needs to look.
 */
export function recordApprovalDecision(
  db: DatabaseSync,
  input: { approvalKind: string; business: unknown; agentId?: string | null; approve: boolean; decidedBy: string },
  now = Date.now(),
): void {
  const kind = rampKindFor(input.approvalKind);
  if (!kind || !isBusinessKey(input.business)) return;
  ensureTrustRampSchema(db);
  const byOwner = input.decidedBy === "owner";
  const upsert = db.prepare(
    `INSERT INTO approval_track_record (business,kind,agent_id,approved,denied,owner_streak,last_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(business,kind,agent_id) DO UPDATE SET
       approved = approved + excluded.approved,
       denied = denied + excluded.denied,
       owner_streak = CASE WHEN excluded.denied > 0 THEN 0 ELSE owner_streak + excluded.owner_streak END,
       snoozed_until = CASE WHEN excluded.denied > 0 THEN 0 ELSE snoozed_until END,
       last_at = excluded.last_at`,
  );
  const approved = input.approve ? 1 : 0;
  const denied = input.approve ? 0 : 1;
  const streak = input.approve && byOwner ? 1 : 0;
  for (const agent of new Set([ALL_AGENTS, input.agentId || "owner"]))
    upsert.run(input.business, kind, agent, approved, denied, streak, now);
}

export interface TrustOffer {
  business: BusinessKey;
  kind: RampKind;
  streak: number;
  approved: number;
  denied: number;
  agents: Array<{ agent_id: string; approved: number; denied: number }>;
}

/** Offers for kinds still at `owner` whose streak reached the business's threshold and are not snoozed. */
export function listTrustOffers(db: DatabaseSync): TrustOffer[] {
  ensureTrustRampSchema(db);
  const rows = db
    .prepare("SELECT * FROM approval_track_record WHERE agent_id=? ORDER BY business, kind")
    .all(ALL_AGENTS) as Array<Record<string, unknown>>;
  const offers: TrustOffer[] = [];
  for (const row of rows) {
    if (!isBusinessKey(row.business) || !(RAMP_KINDS as readonly unknown[]).includes(row.kind)) continue;
    const policy = businessPolicy(row.business);
    const kind = row.kind as RampKind;
    const threshold = policy.trust_ramp_after;
    const streak = Number(row.owner_streak);
    if (threshold <= 0 || policy[kind] !== "owner" || streak < threshold || streak < Number(row.snoozed_until))
      continue;
    const agents = db
      .prepare(
        "SELECT agent_id,approved,denied FROM approval_track_record WHERE business=? AND kind=? AND agent_id<>? ORDER BY approved DESC",
      )
      .all(row.business, kind, ALL_AGENTS) as Array<{ agent_id: string; approved: number; denied: number }>;
    offers.push({
      business: row.business,
      kind,
      streak,
      approved: Number(row.approved),
      denied: Number(row.denied),
      agents,
    });
  }
  return offers;
}

/** Accept lowers that kind to the VPs; "not now" hides the offer until another full run of approvals. */
export function answerTrustOffer(
  db: DatabaseSync,
  business: unknown,
  kind: unknown,
  accept: unknown,
  now = Date.now(),
) {
  if (!isBusinessKey(business)) throw new Error("invalid_business");
  if (!(RAMP_KINDS as readonly unknown[]).includes(kind)) throw new Error("invalid_kind");
  if (typeof accept !== "boolean") throw new Error("accept_boolean_required");
  const offer = listTrustOffers(db).find((item) => item.business === business && item.kind === kind);
  if (!offer) throw new Error("trust_offer_not_found");
  if (accept) return { policy: saveBusinessPolicy(db, business, { [kind as RampKind]: "vp" }, now) };
  db.prepare("UPDATE approval_track_record SET snoozed_until=? WHERE business=? AND kind=? AND agent_id=?").run(
    offer.streak + businessPolicy(business).trust_ramp_after,
    business,
    kind as RampKind,
    ALL_AGENTS,
  );
  return { policy: businessPolicy(business) };
}
