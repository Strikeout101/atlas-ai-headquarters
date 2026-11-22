import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ListingsPanel from "./ListingsPanel";
import ApprovalRow from "../today/ApprovalRow";
import { listingsApi, type ListingPackage, type ListingsOverview } from "../../api/listings";
import { etsyApi, type EtsySettings } from "../../api/etsy";
import type { PendingApproval } from "../../api";

vi.mock("../../api/listings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/listings")>()),
  listingsApi: {
    list: vi.fn(),
    setBudget: vi.fn(),
    update: vi.fn(),
    decide: vi.fn(),
    markPublished: vi.fn(),
    withdraw: vi.fn(),
  },
}));

vi.mock("../../api/etsy", () => ({
  etsyApi: { get: vi.fn(), pushDraft: vi.fn(), publish: vi.fn() },
}));

const base: ListingPackage = {
  id: "l1",
  business: "ventures",
  platform: "etsy",
  project_id: null,
  initiative_id: null,
  title: "Minimal budget planner",
  description: "A one-page monthly budget planner.",
  tags: ["planner", "budget"],
  price_minor: 450,
  currency: "USD",
  files: ["products/planner.pdf"],
  mockups: ["products/mockup.png"],
  notes: "Original work.",
  fee_minor: 20,
  fee_currency: "USD",
  status: "approved",
  listing_url: null,
  agent_id: "maker",
  task_id: "task-1",
  decided_by: "vp:a,b",
  decision_reason: null,
  submitted_at: 1,
  decided_at: 2,
  published_at: null,
  created_at: 1,
  updated_at: 2,
  approver: "vp",
};
const overview = (items: ListingPackage[], cap = 1000, used = 20): ListingsOverview & { ok: true } => ({
  ok: true,
  items,
  budget: { month: "2026-11", currency: "USD", monthly_cap_minor: cap, used_minor: used, remaining_minor: cap - used },
  fees: { etsy: { amount_minor: 20, currency: "USD" }, itch: { amount_minor: 0, currency: "USD" } },
});

beforeEach(() => {
  localStorage.setItem("climpire.language", "en");
  vi.mocked(listingsApi.list).mockReset();
  vi.mocked(etsyApi.get).mockReset().mockRejectedValue(new Error("not connected"));
  vi.mocked(etsyApi.pushDraft)
    .mockReset()
    .mockResolvedValue(undefined as never);
  for (const fn of [listingsApi.setBudget, listingsApi.decide, listingsApi.markPublished, listingsApi.withdraw])
    vi.mocked(fn)
      .mockReset()
      .mockResolvedValue(undefined as never);
});

describe("Listings panel", () => {
  it("says plainly that every paid listing needs the owner until a budget is set", async () => {
    vi.mocked(listingsApi.list).mockResolvedValue(overview([], 0, 0));
    render(<ListingsPanel business="ventures" />);
    expect(await screen.findByText(/No budget set: every listing that costs a fee needs your approval/)).toBeVisible();
    expect(screen.getByText("Nothing is approved and waiting to be published.")).toBeVisible();
    expect(listingsApi.list).toHaveBeenCalledWith("ventures");
  });

  it("saves the monthly budget in cents without rounding errors", async () => {
    const user = userEvent.setup();
    vi.mocked(listingsApi.list).mockResolvedValue(overview([]));
    render(<ListingsPanel business="ventures" />);
    const input = await screen.findByLabelText("Monthly listing fee budget (USD)");
    expect(input).toHaveValue("10.00");
    expect(screen.getByText(/\$0\.20 of \$10\.00 used in 2026-11/)).toBeVisible();
    await user.clear(input);
    await user.type(input, "0.29");
    await user.click(screen.getByRole("button", { name: "Save budget" }));
    expect(listingsApi.setBudget).toHaveBeenCalledWith(29);
  });

  it("gives an approved package a publish checklist and records the live address", async () => {
    const user = userEvent.setup();
    vi.mocked(listingsApi.list).mockResolvedValue(overview([base]));
    render(<ListingsPanel business="ventures" />);
    const ready = await screen.findByRole("region", { name: "Ready to publish" });
    const card = within(ready).getByRole("listitem", { name: "Minimal budget planner" });
    expect(within(card).getByText(/Etsy · \$4\.50 · listing fee \$0\.20/)).toBeVisible();
    expect(within(card).getByText("products/planner.pdf")).toBeVisible();
    expect(within(card).getByText("planner, budget")).toBeVisible();
    await user.type(
      within(card).getByLabelText("After you publish it on Etsy, paste the listing address"),
      "https://www.etsy.com/listing/123",
    );
    await user.click(within(card).getByRole("button", { name: "Mark published" }));
    expect(listingsApi.markPublished).toHaveBeenCalledWith("l1", "https://www.etsy.com/listing/123");
    expect(listingsApi.list).toHaveBeenCalledTimes(2);
  });

  it("presents an approved revision as a change to the live Etsy listing and applies it without a fee", async () => {
    const user = userEvent.setup();
    vi.mocked(etsyApi.get).mockResolvedValue({ connected: true } as EtsySettings);
    vi.mocked(listingsApi.list).mockResolvedValue(
      overview([
        {
          ...base,
          id: "r1",
          title: "Minimal budget planner 2027",
          fee_minor: 0,
          revision_of: "l0",
          etsy_listing_id: "9001",
        },
        {
          ...base,
          id: "l0",
          status: "published",
          listing_url: "https://www.etsy.com/listing/9001",
          etsy_listing_id: "9001",
          etsy_state: "sold_out",
        },
      ]),
    );
    render(<ListingsPanel business="ventures" />);
    const ready = await screen.findByRole("region", { name: "Ready to publish" });
    const card = within(ready).getByRole("listitem", { name: "Minimal budget planner 2027" });
    expect(within(card).getByText(/change to a live listing/)).toBeVisible();
    expect(await within(card).findByText(/Approved change to live Etsy listing 9001/)).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Publish on Etsy" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Apply to Etsy now" }));
    expect(etsyApi.pushDraft).toHaveBeenCalledWith("r1");
    const published = screen.getByRole("region", { name: "Published" });
    expect(within(published).getByText(/on Etsy: sold out/)).toBeVisible();
  });

  it("shows who can approve a waiting package and lets the owner decide it", async () => {
    const user = userEvent.setup();
    vi.mocked(listingsApi.list).mockResolvedValue(
      overview([
        { ...base, id: "w1", status: "ready", approver: "owner", decided_by: null, title: "Over budget pack" },
        { ...base, id: "w2", status: "ready", approver: "vp", decided_by: null, title: "Free icon pack", fee_minor: 0 },
      ]),
    );
    render(<ListingsPanel business="ventures" />);
    const waiting = await screen.findByRole("region", { name: "Waiting for approval" });
    expect(within(waiting).getByText(/needs your approval/)).toBeVisible();
    expect(within(waiting).getByText(/listing fee free · the VPs can approve this/)).toBeVisible();
    const card = within(waiting).getByRole("listitem", { name: "Over budget pack" });
    await user.click(within(card).getByRole("button", { name: "Approve for publishing" }));
    expect(listingsApi.decide).toHaveBeenCalledWith("w1", true);
  });

  it("links to published listings and explains a failed change without losing the list", async () => {
    const user = userEvent.setup();
    vi.mocked(listingsApi.list).mockResolvedValue(
      overview([
        { ...base, id: "p1", status: "published", listing_url: "https://www.etsy.com/listing/9", title: "Live one" },
        { ...base, id: "r1", status: "rejected", title: "Rejected one" },
        base,
      ]),
    );
    vi.mocked(listingsApi.markPublished).mockRejectedValue(new Error("invalid_listing_url"));
    render(<ListingsPanel business="ventures" />);
    expect(await screen.findByRole("link", { name: "Open listing" })).toHaveAttribute(
      "href",
      "https://www.etsy.com/listing/9",
    );
    expect(screen.getByText("1 rejected or withdrawn package not shown.")).toBeVisible();
    const card = screen.getByRole("listitem", { name: "Minimal budget planner" });
    await user.type(within(card).getByLabelText(/paste the listing address/), "https://example.com/x");
    await user.click(within(card).getByRole("button", { name: "Mark published" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the full https:// address of the live listing.");
    expect(screen.getByRole("listitem", { name: "Live one" })).toBeVisible();
  });
});

describe("Today row for a listing", () => {
  const item: PendingApproval = {
    kind: "listing_publish",
    id: "l1",
    created_at: Date.now(),
    task_id: "task-1",
    task_title: "Make planner",
    agent_id: "maker",
    agent_name: "Maker",
    business: "ventures",
    platform: "etsy",
    title: "Minimal budget planner",
    description: "A one-page monthly budget planner.",
    tags: ["planner"],
    price_minor: 450,
    currency: "USD",
    files: ["products/planner.pdf"],
    mockups: [],
    fee_minor: 20,
    fee_currency: "USD",
    fee_over_budget: true,
  };

  it("shows the exact listing, its fee, and that approving does not publish", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <ul>
        <ApprovalRow item={item} onDecide={onDecide} onOpenHomelab={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("Listing to publish")).toBeVisible();
    expect(screen.getByText("Minimal budget planner")).toBeVisible();
    expect(screen.getByText(/Etsy · \$4\.50/)).toBeVisible();
    expect(
      screen.getByText(/costs a \$0\.20 platform fee, which is outside this month's listing fee budget/),
    ).toBeVisible();
    expect(screen.getByText(/Approving does not publish it/)).toBeVisible();
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);
    expect(onDecide).toHaveBeenCalledWith(item, true);
  });
});
