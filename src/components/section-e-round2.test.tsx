import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StreamsPanel from "./revenue/StreamsPanel";
import GoalMilestones from "./autonomy/GoalMilestones";
import ApprovalRow from "./today/ApprovalRow";
import * as autonomy from "../api/autonomy";
import type { StreamOverview } from "../api/autonomy";
import type { PendingApproval } from "../api";

vi.mock("../api/autonomy", async (original) => ({
  ...(await original<typeof import("../api/autonomy")>()),
  getStream: vi.fn(),
  addMilestone: vi.fn(),
  setMilestoneDone: vi.fn(),
  deleteMilestone: vi.fn(),
}));

const stream = (business: StreamOverview["business"]): StreamOverview => ({
  business,
  businesses: ["tech", "rental", "ventures"],
  goals: [
    {
      id: "g1",
      business,
      project_id: "p1",
      metric: "verified_revenue",
      target: 100,
      period_start: Date.UTC(2026, 10, 1),
      period_end: Date.UTC(2026, 10, 30),
      progress: 40,
      milestones: [
        {
          id: "m1",
          goal_id: "g1",
          title: "First sale",
          kind: "progress",
          target: 1,
          status: "done",
          done_by: "verified",
          done_at: 1,
        },
      ],
    },
  ],
  pipeline: { building: 1 },
  initiatives: [
    {
      id: "o1",
      business,
      project_id: "p1",
      goal_id: null,
      title: business === "ventures" ? "Budget planner" : "Website care plan",
      description: "",
      demand_score: 5,
      revenue_score: 5,
      cost_score: 5,
      difficulty_score: 5,
      time_to_launch_score: 5,
      budget: 5,
      status: "in_progress",
      results: {
        spent_usd: 2,
        earned_usd: 12,
        budget_usd: 5,
        days_live: null,
        tasks_in_window: 1,
        task_limit: 10,
        playbook_stage: "mockups",
        stop_reason: null,
        variants: [{ variable: "price", value: "4.99", days: 3, sales: 1, revenue_usd: 4.99, active: true }],
      },
    },
  ],
  next: [
    {
      id: "w1",
      status: "planned",
      initiative_id: "o1",
      playbook_step: "listing",
      title: "Write the listing",
      created_at: 1,
    },
  ],
  listings: { draft: 1 },
  schedules: [],
  month: {
    from: 0,
    to: 1,
    costs_complete: false,
    lines: [{ currency: "USD", revenue_minor: 1200, expense_minor: 200, recurring_minor: 0, profit_minor: 1000 }],
  },
  recent: [],
});

beforeEach(() => {
  vi.mocked(autonomy.getStream).mockImplementation(async (business) => stream(business));
  vi.mocked(autonomy.addMilestone).mockResolvedValue({} as never);
  vi.mocked(autonomy.setMilestoneDone).mockResolvedValue({} as never);
});

describe("income stream page", () => {
  it("shows goals, money, next work and ideas for the chosen business, and switches business", async () => {
    const user = userEvent.setup();
    render(<StreamsPanel locale="en-US" />);
    expect(await screen.findByText("Budget planner")).toBeInTheDocument();
    expect(screen.getByText("40 / 100")).toBeInTheDocument();
    expect(screen.getByText(/First sale/)).toHaveTextContent("verified");
    expect(screen.getByText(/profit \(estimate\)/)).toBeInTheDocument();
    const next = screen.getByRole("region", { name: "Next" });
    expect(within(next).getByText(/Write the listing · step listing/)).toBeInTheDocument();
    expect(within(next).getByText("waiting to start")).toBeInTheDocument();
    expect(screen.getByText("price: 4.99")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tech Services" }));
    expect(await screen.findByText("Website care plan")).toBeInTheDocument();
    expect(autonomy.getStream).toHaveBeenLastCalledWith("tech");
  });
});

describe("goal milestones", () => {
  it("lets the owner confirm manual milestones but never tick progress ones, and adds new ones", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn(async (action: () => Promise<unknown>) => {
      await action();
    });
    render(
      <GoalMilestones
        goalId="g1"
        busy={false}
        mutate={mutate}
        milestones={[
          {
            id: "m1",
            goal_id: "g1",
            title: "Ten sales",
            kind: "progress",
            target: 10,
            status: "open",
            done_by: null,
            done_at: null,
          },
          {
            id: "m2",
            goal_id: "g1",
            title: "Shop looks right",
            kind: "manual",
            target: null,
            status: "open",
            done_by: null,
            done_at: null,
          },
        ]}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "Confirm Ten sales" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Confirm Shop looks right" }));
    expect(autonomy.setMilestoneDone).toHaveBeenCalledWith("m2", true);
    await user.click(screen.getByRole("button", { name: "Add a milestone" }));
    const form = screen.getByRole("form", { name: "Add milestone" });
    await user.type(within(form).getByLabelText("Milestone"), "First sale");
    await user.type(within(form).getByLabelText("Target"), "1");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(autonomy.addMilestone).toHaveBeenCalledWith("g1", { title: "First sale", kind: "progress", target: 1 }),
    );
  });
});

describe("approval from a task that read suspicious content", () => {
  it("is marked so the owner checks it carefully", () => {
    const item: PendingApproval = {
      kind: "spend_request",
      id: "spend-1",
      created_at: Date.now(),
      task_id: "t1",
      task_title: "Research planners",
      agent_id: "worker",
      agent_name: "Iris",
      business: "ventures",
      amount_minor: 500,
      currency: "USD",
      purpose: "Font license",
      initiative_id: null,
      untrusted_content: true,
    };
    render(
      <ul>
        <ApprovalRow item={item} onDecide={vi.fn()} onOpenHomelab={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("Read suspicious content")).toBeInTheDocument();
  });
});
