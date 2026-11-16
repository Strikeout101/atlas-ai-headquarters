import type { DatabaseSync } from "node:sqlite";
import { decideProposal, type DecideDeps } from "./agent-proposals.ts";
import { decideModelUpgrade } from "./model-routing.ts";
import { decideOrgRequest } from "./org-requests.ts";
import { decideListing } from "./listings.ts";
import { decideBusinessEmail } from "./routes/ops/business-email.ts";
import { listPendingApprovals, type PendingApproval } from "./routes/ops/approvals.ts";
import { approvalRoute, approvalSnapshot } from "./approval-review-state.ts";
import { isAutonomyAllowed } from "./control-state.ts";

export async function executeVpApproval(
  db: DatabaseSync,
  item: PendingApproval,
  approve: boolean,
  decidedBy: string,
  reason: string,
  deps: DecideDeps = {},
): Promise<void> {
  if (!isAutonomyAllowed() || approvalRoute(item) !== "vp" || !decidedBy.startsWith("vp:"))
    throw new Error("vp_execution_forbidden");
  const current = listPendingApprovals(db, 1000, "all").find(
    (candidate) => candidate.kind === item.kind && candidate.id === item.id,
  );
  if (!current || approvalSnapshot(current) !== approvalSnapshot(item) || approvalRoute(current) !== "vp")
    throw new Error("vp_request_changed");

  if (item.kind === "business_email") {
    const result = await decideBusinessEmail(db, item.id, approve, { decidedBy });
    if (result.status !== 200 || result.body.ok !== true || (approve && result.body.item?.status !== "sent"))
      throw new Error("email_execution_failed");
  } else if (item.kind === "task_proposal") {
    const result = decideProposal(db, item.id, approve, { ...deps, decidedBy });
    if (!result.ok) throw new Error(result.error);
  } else if (item.kind === "model_upgrade") {
    const result = await decideModelUpgrade(db, item.id, approve, reason, undefined, decidedBy);
    if (result.status !== (approve ? "approved" : "denied")) throw new Error("model_decision_failed");
  } else if (item.kind === "org_request") {
    decideOrgRequest(db, item.id, approve, decidedBy);
    deps.broadcast?.("agents_changed", {});
    deps.broadcast?.("departments_changed", {});
  } else if (item.kind === "listing_publish") {
    // Re-checks the business and the month's fee budget in the same transaction that records the decision.
    decideListing(db, item.id, approve, decidedBy, reason);
    deps.broadcast?.("listings_changed", {});
  } else throw new Error("vp_approval_kind_forbidden");
}
