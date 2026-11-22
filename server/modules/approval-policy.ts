import { isBusinessKey } from "./businesses.ts";
import { businessPolicy, type BusinessPolicy, type GateLevel } from "./business-policies.ts";

export const DEFAULT_DEPARTMENT_IDS = ["planning", "dev", "design", "qa", "devsecops", "operations"] as const;
/** Actions a customer can see. They follow the business's customer_sends setting. */
export const CUSTOMER_FACING_KINDS = [
  "business_email",
  "social_send",
  "customer_send",
  "listing_publish",
  "shop_change",
];
export const CLIENT_TIERS = ["normal", "important", "vip"] as const;
export type ClientTier = (typeof CLIENT_TIERS)[number];

/**
 * Structured facts about an approval, read from records, never from the wording of a message: a customer email that
 * says "you can pay at pickup" spends nothing. VPs are still told to escalate anything that commits to money or terms.
 */
export interface ApprovalFacts {
  spendsMoney?: boolean;
  /** A spend request that fits the owner's spending budget for that business and category. */
  withinSpendBudget?: boolean;
  newPaidAccount?: boolean;
  agreesToTerms?: boolean;
  customerFacing?: boolean;
  destructiveSsh?: boolean;
  orgKind?: string;
  departmentId?: string;
  /** Tier of the client the item touches. */
  clientTier?: string | null;
  /** The deal or quote amount the item touches, in minor units, with its currency. */
  amountMinor?: number | null;
  amountCurrency?: string | null;
  /** An agent setting or changing a client's tier. Always the owner, so a tier cannot be lowered to skip approval. */
  changesClientTier?: boolean;
}

/** True when the client tier or the amount means the owner must decide, whatever the level settings say. */
export function needsOwnerForClientOrAmount(policy: BusinessPolicy | undefined, facts: ApprovalFacts): boolean {
  if (!policy) return true;
  const tier = facts.clientTier ?? "normal";
  if (!(CLIENT_TIERS as readonly string[]).includes(tier)) return true;
  if (policy.tier_to_owner === "important" && tier !== "normal") return true;
  if (policy.tier_to_owner === "vip" && tier === "vip") return true;
  const amount = facts.amountMinor ?? 0;
  if (policy.owner_amount_minor > 0 && amount > 0) {
    if ((facts.amountCurrency ?? "USD").toUpperCase() !== policy.amount_currency) return true;
    if (amount >= policy.owner_amount_minor) return true;
  }
  return false;
}

/** Hard floors are code, never settings or model-provided policy. Unknown actions fail closed. */
export function routeApproval(kind: string, business?: string | null, facts: ApprovalFacts = {}): "owner" | "vp" {
  if (kind === "spend_request")
    return facts.withinSpendBudget && !facts.newPaidAccount && !facts.agreesToTerms ? "vp" : "owner";
  if (facts.spendsMoney || facts.newPaidAccount || facts.agreesToTerms || facts.destructiveSsh) return "owner";
  if (kind === "ssh_command") return "owner";
  if (
    facts.orgKind === "dissolve_department" &&
    DEFAULT_DEPARTMENT_IDS.includes(facts.departmentId as (typeof DEFAULT_DEPARTMENT_IDS)[number])
  )
    return "owner";
  const customerFacing = facts.customerFacing || CUSTOMER_FACING_KINDS.includes(kind);
  if (!customerFacing && ["task_proposal", "model_upgrade", "org_request"].includes(kind)) return "vp";
  const policy = isBusinessKey(business) ? businessPolicy(business) : undefined;
  if (!policy) return "owner";
  if (facts.changesClientTier || needsOwnerForClientOrAmount(policy, facts)) return "owner";
  const gate = (level: GateLevel) => (level === "vp" || level === "none" ? "vp" : "owner");
  if (kind === "record_change") return gate(policy.record_changes);
  if (kind === "code_push") return gate(policy.code_pushes);
  if (customerFacing) return policy.customer_sends === "vp" ? "vp" : "owner";
  return "owner";
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(minor / 100);
const who = (level: string) =>
  level === "owner" ? "the owner" : level === "vp" ? "both VPs" : "no one (applied directly)";

/** The approval rules for one business in plain words, built from its settings (for VP and agent prompts). */
export function describeApprovalRules(business: string | null | undefined): string {
  const floors =
    "Always the owner, whatever the settings: spending money (except spend requests within the owner's spending budget), paid accounts, accepting terms or contracts, destructive SSH, dissolving default departments, and any message that commits the business to a payment, price change, discount or terms.";
  if (!isBusinessKey(business)) return `${floors} Items with no business go to the owner.`;
  const policy = businessPolicy(business);
  const tiers =
    policy.tier_to_owner === "important"
      ? "Important and VIP clients go to the owner."
      : policy.tier_to_owner === "vip"
        ? "VIP clients go to the owner."
        : "Client tier does not change who approves.";
  const amount =
    policy.owner_amount_minor > 0
      ? `Deals and quotes of ${money(policy.owner_amount_minor, policy.amount_currency)} or more (or in another currency) go to the owner.`
      : "There is no deal-size limit.";
  return [
    `Customer-facing work is approved by ${who(policy.customer_sends)}; agent record changes by ${who(policy.record_changes)}; code pushes by ${who(policy.code_pushes)}.`,
    tiers,
    amount,
    floors,
  ].join(" ");
}
