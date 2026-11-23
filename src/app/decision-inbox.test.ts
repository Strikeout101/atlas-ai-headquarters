import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../api/approvals";
import { mapApprovalDecisionItems } from "./decision-inbox";

describe("owner approval inbox cards", () => {
  it("shows spending details and a safe recommendation before the decision", () => {
    const request = {
      id: "spend-1",
      kind: "spend_request",
      created_at: 10,
      task_id: "task-1",
      task_title: "Order supplies",
      agent_id: "agent-1",
      agent_name: "Alex",
      business: "ventures",
      amount_minor: 13500,
      currency: "USD",
      purpose: "Sample stock",
      initiative_id: null,
    } as PendingApproval;
    const [card] = mapApprovalDecisionItems([request]);
    expect(card.requestContent).toContain("$135.00");
    expect(card.options).toHaveLength(3);
    expect(card.options[0]).toMatchObject({ action: "approval_hold", number: 1 });
    expect(card.options[0].label).toContain("recommended");
  });
});
