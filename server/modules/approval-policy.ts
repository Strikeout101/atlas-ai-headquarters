import { BUSINESSES, isBusinessKey } from "./businesses.ts";

export const DEFAULT_DEPARTMENT_IDS = ["planning", "dev", "design", "qa", "devsecops", "operations"] as const;
/** Actions a customer can see. Owner-approved businesses always route these to the owner. */
const CUSTOMER_FACING_KINDS = ["business_email", "social_send", "customer_send", "listing_publish"];
export interface ApprovalFacts {
  spendsMoney?: boolean;
  newPaidAccount?: boolean;
  agreesToTerms?: boolean;
  customerFacing?: boolean;
  destructiveSsh?: boolean;
  orgKind?: string;
  departmentId?: string;
}

/** Hard floors are code, never settings or model-provided policy. Unknown actions fail closed. */
export function routeApproval(kind: string, business?: string | null, facts: ApprovalFacts = {}): "owner" | "vp" {
  if (facts.spendsMoney || facts.newPaidAccount || facts.agreesToTerms || facts.destructiveSsh) return "owner";
  if (kind === "ssh_command") return "owner";
  if (kind === "spend_request") return "owner";
  if (
    facts.orgKind === "dissolve_department" &&
    DEFAULT_DEPARTMENT_IDS.includes(facts.departmentId as (typeof DEFAULT_DEPARTMENT_IDS)[number])
  )
    return "owner";
  const registered = isBusinessKey(business) ? BUSINESSES[business] : undefined;
  if ((facts.customerFacing || CUSTOMER_FACING_KINDS.includes(kind)) && registered?.approval !== "vp") return "owner";
  if (["task_proposal", "model_upgrade", "org_request"].includes(kind)) return "vp";
  if (CUSTOMER_FACING_KINDS.includes(kind) && registered?.approval === "vp") return "vp";
  return "owner";
}

/** Conservative extra owner floors for free-text requests. VPs must also escalate any spending/terms they discover. */
export function factsFromContent(content: string): ApprovalFacts {
  return {
    spendsMoney: /\b(pay(?:ment)?|purchase|buy|spend|refund|charge|transfer funds|paid subscription)\b/i.test(content),
    newPaidAccount: /\b(?:paid|premium)\s+(?:account|plan|subscription)\b/i.test(content),
    agreesToTerms: /\b(?:agree|accept|sign)\b.{0,40}\b(?:terms|contract|agreement)\b/i.test(content),
  };
}
