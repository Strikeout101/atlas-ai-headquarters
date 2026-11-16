import { describe, expect, it } from "vitest";
import { DEFAULT_DEPARTMENT_IDS, factsFromContent, routeApproval } from "./approval-policy.ts";
import { approvalRoute } from "./approval-review-state.ts";

describe("approval policy hard floors", () => {
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
  it("conservatively finds spending and terms in unstructured content", () => {
    expect(factsFromContent("Purchase a premium account and accept the terms")).toMatchObject({
      spendsMoney: true,
      newPaidAccount: true,
      agreesToTerms: true,
    });
    expect(approvalRoute({ kind: "task_proposal", id: "proposal", description: "Buy a new subscription" })).toBe(
      "owner",
    );
  });
});
