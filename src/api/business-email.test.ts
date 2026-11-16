import { beforeEach, describe, expect, it, vi } from "vitest";

import { decidePendingApproval, type PendingApproval } from "./approvals";
import { post } from "./core";

vi.mock("./core", () => ({ post: vi.fn(), request: vi.fn(), isApiRequestError: () => false }));
const item: PendingApproval = {
  kind: "business_email",
  id: "e1",
  created_at: 1,
  task_id: "t",
  task_title: "Test email",
  agent_id: "w",
  agent_name: "Felix",
  business: "tech",
  sender: "info@example.com",
  recipient: "owner@example.net",
  subject: "Test",
  body: "Exact text",
};
beforeEach(() => vi.resetAllMocks());
describe("owner email decisions", () => {
  it("warns that a lost approval response may already have sent and never retries", async () => {
    vi.mocked(post).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(decidePendingApproval(item, true)).rejects.toThrow("Do not create another message");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not treat SMTP uncertainty as a successful send or retry it", async () => {
    vi.mocked(post).mockResolvedValue({ ok: false, item: { status: "unknown", error_code: "email_delivery_unknown" } });
    await expect(decidePendingApproval(item, true)).rejects.toThrow("Do not resend");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("accepts sent and denied outcomes", async () => {
    vi.mocked(post)
      .mockResolvedValueOnce({ ok: true, item: { status: "sent" } })
      .mockResolvedValueOnce({ ok: true, item: { status: "denied" } });
    await expect(decidePendingApproval(item, true)).resolves.toBeUndefined();
    await expect(decidePendingApproval(item, false)).resolves.toBeUndefined();
  });
});
