import { describe, expect, it } from "vitest";
import { DEFAULT_DEPARTMENT_IDS, routeApproval } from "./approval-policy.ts";
import { approvalRoute } from "./approval-review-state.ts";

describe("approval policy hard floors", () => {
  it("always routes spending requests to the owner regardless of business or facts", () => {
    for (const business of ["tech", "rental", "ventures", null])
      expect(routeApproval("spend_request", business, {})).toBe("owner");
  });
  it.each(["spendsMoney", "newPaidAccount", "agreesToTerms", "destructiveSsh"] as const)(
    "routes %s to owner for every otherwise VP action",
    (fact) => {
      for (const kind of ["business_email", "task_proposal", "model_upgrade", "org_request"])
        expect(routeApproval(kind, "ventures", { [fact]: true })).toBe("owner");
    },
  );
  it.each(["tech", "rental", null, "unknown"])("requires the owner for %s customer-facing actions", (business) => {
    for (const kind of ["business_email", "social_send", "customer_send"])
      expect(routeApproval(kind, business)).toBe("owner");
    expect(routeApproval("task_proposal", business, { customerFacing: true })).toBe("owner");
  });
  it("permits Ventures sends and ordinary internal requests", () => {
    for (const kind of [
      "business_email",
      "social_send",
      "customer_send",
      "task_proposal",
      "model_upgrade",
      "org_request",
    ])
      expect(routeApproval(kind, "ventures")).toBe("vp");
    expect(routeApproval("task_proposal", "tech")).toBe("vp");
    expect(routeApproval("model_upgrade")).toBe("vp");
  });
  it("protects all six default departments and unknown action types", () => {
    for (const departmentId of DEFAULT_DEPARTMENT_IDS)
      expect(routeApproval("org_request", undefined, { orgKind: "dissolve_department", departmentId })).toBe("owner");
    expect(routeApproval("org_request", undefined, { orgKind: "dissolve_department", departmentId: "research" })).toBe(
      "vp",
    );
    expect(routeApproval("ssh_command", "ventures")).toBe("owner");
    expect(routeApproval("unregistered_action", "ventures")).toBe("owner");
  });
  it("does not accept model or request payload overrides of the owner floor", () => {
    expect(
      approvalRoute({
        kind: "business_email",
        id: "email",
        business: "tech",
        payload: { approval: "vp", spends_money: false },
      }),
    ).toBe("owner");
    expect(
      approvalRoute({
        kind: "org_request",
        id: "org",
        org_kind: "dissolve_department",
        payload: { department_id: "planning", approval: "vp" },
      }),
    ).toBe("owner");
    expect(
      approvalRoute({
        kind: "business_email",
        id: "email",
        business: "ventures",
        payload: { spends_money: true, approval: "vp" },
      }),
    ).toBe("owner");
  });
  it("routes by structured facts, not by words like pay or buy in the text", () => {
    // Spending is its own request kind; VPs are told to escalate anything that commits ATLAS to money or terms.
    expect(approvalRoute({ kind: "task_proposal", id: "proposal", description: "Buy a new subscription" })).toBe("vp");
    expect(
      approvalRoute({ kind: "business_email", id: "e", business: "ventures", body: "You can pay at pickup." }),
    ).toBe("vp");
    expect(
      approvalRoute({ kind: "task_proposal", id: "p2", payload: { new_paid_account: true } }),
    ).toBe("owner");
  });
});
