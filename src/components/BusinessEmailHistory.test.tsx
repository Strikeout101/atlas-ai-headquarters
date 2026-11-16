import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { businessEmailApi, type EmailApproval } from "../api/business-email";
import BusinessEmailHistory from "./BusinessEmailHistory";

vi.mock("../api/business-email", () => ({ businessEmailApi: { list: vi.fn() } }));

describe("email delivery history", () => {
  it("shows uncertain delivery honestly and only lists the selected business", async () => {
    const item: EmailApproval = {
      id: "a",
      draft_id: "d",
      task_id: "t",
      agent_id: "w",
      business: "tech",
      sender: "info@example.com",
      recipient: "owner@example.net",
      subject: "Tech message",
      body: "Exact text",
      status: "unknown",
      created_at: Date.now(),
      decided_at: null,
      sent_at: null,
      message_id: null,
      error_code: "email_delivery_unknown",
    };
    vi.mocked(businessEmailApi.list).mockResolvedValue([
      item,
      { ...item, id: "r", business: "rental", subject: "Rental message" },
    ]);
    render(<BusinessEmailHistory business="tech" />);
    expect(await screen.findByText("Tech message")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText(/will not be retried automatically/)).toBeInTheDocument();
    expect(screen.queryByText("Rental message")).not.toBeInTheDocument();
  });
});
