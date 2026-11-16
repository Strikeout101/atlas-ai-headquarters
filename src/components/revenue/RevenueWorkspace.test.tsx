import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFinance, recordFinanceEntry, type FinanceOverview } from "../../api/finance";
import { ApiRequestError } from "../../api/core";
import RevenueWorkspace from "./RevenueWorkspace";

vi.mock("../../api/finance", () => ({
  getFinance: vi.fn(),
  saveDeal: vi.fn(),
  recordFinanceEntry: vi.fn(),
  linkFinanceEntry: vi.fn(),
  createSpendRequest: vi.fn(),
  decideSpendRequest: vi.fn(),
}));
const empty: FinanceOverview = { deals: [], ledger: [], spend_requests: [], totals: [], goals: [], opportunities: [] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFinance).mockResolvedValue(empty);
  vi.mocked(recordFinanceEntry).mockResolvedValue({ ok: true });
});
describe("revenue workspace", () => {
  it("keeps currencies separate and distinguishes unverified costs from the recorded surplus", async () => {
    vi.mocked(getFinance).mockResolvedValue({
      ...empty,
      totals: [
        {
          business: "ventures",
          currency: "USD",
          revenue_minor: 2900,
          cost_minor: 100,
          surplus_minor: 2800,
          unverified_revenue_minor: 300,
          unverified_cost_minor: 900,
          costs_complete: false,
        },
        {
          business: "ventures",
          currency: "JPY",
          revenue_minor: 431,
          cost_minor: 0,
          surplus_minor: 431,
          unverified_revenue_minor: 0,
          unverified_cost_minor: 0,
          costs_complete: false,
        },
      ],
    });
    render(<RevenueWorkspace />);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Ventures · USD" })).toBeVisible();
    expect(within(table).getByRole("rowheader", { name: "Ventures · JPY" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Verified costs" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Unverified costs" })).toBeVisible();
    expect(within(table).getByText(/Surplus subtracts verified costs only/)).toBeVisible();
    expect(within(table).getByText("$28.00")).toBeVisible();
    expect(screen.queryByText("Grand total")).not.toBeInTheDocument();
  });
  it("records three-decimal amounts without verification authority and keeps the form when owner auth fails", async () => {
    vi.mocked(recordFinanceEntry).mockRejectedValue(
      new ApiRequestError("Forbidden", { status: 403, code: "owner_session_required", url: "/api/finance/ledger" }),
    );
    const user = userEvent.setup();
    render(<RevenueWorkspace />);
    await user.click(await screen.findByRole("tab", { name: "Records" }));
    await user.click(screen.getByRole("button", { name: "Add manual record" }));
    const form = screen.getByRole("form", { name: "Manual record" });
    await user.selectOptions(within(form).getByLabelText("Currency"), "KWD");
    await user.clear(within(form).getByLabelText("Amount", { exact: true }));
    await user.type(within(form).getByLabelText("Amount", { exact: true }), "4.317");
    await user.type(within(form).getByLabelText("Description"), "Recorded materials estimate");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(recordFinanceEntry).toHaveBeenCalledWith(
        expect.objectContaining({ amount_minor: 4317, currency: "KWD", kind: "expense" }),
      ),
    );
    expect(vi.mocked(recordFinanceEntry).mock.calls[0][0]).not.toHaveProperty("verified");
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings > Security");
    expect(form).toBeVisible();
  });
  it("keeps milestones distinct and offers no manual paid stage", async () => {
    const user = userEvent.setup();
    render(<RevenueWorkspace />);
    await user.click(await screen.findByRole("tab", { name: "Pipeline" }));
    await user.click(screen.getByRole("button", { name: "Add deal" }));
    const form = screen.getByRole("form", { name: "Deal" });
    expect(within(form).getByLabelText("Product generated")).toBeVisible();
    expect(within(form).getByLabelText("Listing published")).toBeVisible();
    expect(within(form).getByLabelText("Order received")).toBeVisible();
    expect(within(form).queryByRole("option", { name: /^paid$/ })).not.toBeInTheDocument();
    expect(within(form).getByText(/Only sufficient linked verified receipts/)).toBeVisible();
  });
});
