import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAutonomy, saveAutonomy, saveAutonomyConfig, type AutonomyOverview } from "../../api/autonomy";
import { getProjects } from "../../api/organization-projects";
import { ApiRequestError } from "../../api/core";
import AutonomyWorkspace from "./AutonomyWorkspace";

vi.mock("../../api/autonomy", () => ({ getAutonomy: vi.fn(), saveAutonomy: vi.fn(), saveAutonomyConfig: vi.fn() }));
vi.mock("../../api/organization-projects", () => ({ getProjects: vi.fn() }));
const overview: AutonomyOverview = {
  goals: [],
  opportunities: [],
  schedules: [],
  ledger: [],
  config: { daily_start_cap: 6, usage_threshold: 0.8, failure_limit: 3, planning_interval_minutes: 360 },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAutonomy).mockResolvedValue(overview);
  vi.mocked(getProjects).mockResolvedValue({
    projects: [
      {
        id: "project-1",
        name: "Local research",
        project_path: "C:/Projects/research",
        core_goal: "Research",
        assignment_mode: "auto",
        last_used_at: null,
        created_at: 1,
        updated_at: 1,
      },
    ],
    page: 1,
    page_size: 100,
    total: 1,
    total_pages: 1,
  });
  vi.mocked(saveAutonomy).mockResolvedValue({ ok: true });
});

describe("autonomy planning", () => {
  it("shows the per-host invocation limit and persists the owner's cap including zero", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAutonomyConfig).mockResolvedValue({ ok: true });
    render(<AutonomyWorkspace departments={[]} />);
    await user.click(await screen.findByText("Operating limits"));
    const cap = screen.getByLabelText("Daily local provider invocations (per host)");
    expect(cap).toHaveValue(20);
    fireEvent.change(cap, { target: { value: "0" } });
    await user.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() =>
      expect(saveAutonomyConfig).toHaveBeenCalledWith(expect.objectContaining({ local_provider_daily_run_cap: 0 })),
    );
    expect(screen.getByText(/Autonomous paid API calls remain blocked/)).toBeVisible();
  });
  it("requires financial targets to respect their currency's minor-unit precision", async () => {
    const user = userEvent.setup();
    render(<AutonomyWorkspace departments={[]} />);
    await user.click(await screen.findByRole("button", { name: "Add goals" }));
    const form = screen.getByRole("form", { name: "Add goals" });
    await user.selectOptions(within(form).getByLabelText("Project"), "project-1");
    await user.selectOptions(within(form).getByLabelText("Metric"), "verified_revenue");
    await user.selectOptions(within(form).getByLabelText("Currency (financial goals)"), "JPY");
    const target = within(form).getByLabelText("Target");
    await user.clear(target);
    await user.type(target, "4.31");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("0 decimal places for JPY");
    expect(saveAutonomy).not.toHaveBeenCalled();
    await user.clear(target);
    await user.type(target, "431");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveAutonomy).toHaveBeenCalledWith(
        "goals",
        expect.objectContaining({ metric: "verified_revenue", currency: "JPY", target: 431 }),
        undefined,
      ),
    );
  });
  it("requires an explicit project and saves the lead preset disabled with drafts-only instructions", async () => {
    const user = userEvent.setup();
    render(<AutonomyWorkspace departments={[]} />);
    await user.click(await screen.findByRole("tab", { name: /Schedules/ }));
    await user.click(screen.getByRole("button", { name: "Lead research preset" }));
    const form = screen.getByRole("form", { name: "Add schedules" });
    expect(within(form).getByLabelText("Project")).toHaveValue("");
    expect(within(form).getByLabelText("Enable schedule")).not.toBeChecked();
    expect((within(form).getByLabelText("Description") as HTMLTextAreaElement).value).toContain("Do not send messages");
    expect(within(form).getByRole("combobox", { name: "Business" })).toHaveValue("tech");
    expect(within(form).queryByRole("option", { name: "Ventures" })).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText("Project"), "project-1");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveAutonomy).toHaveBeenCalledWith(
        "schedules",
        expect.objectContaining({
          project_id: "project-1",
          business: "tech",
          kind: "lead_research",
          enabled: false,
          interval_minutes: 1440,
        }),
        undefined,
      ),
    );
  });
  it("turns a days-and-time choice into a time-of-day rule in the chosen zone", async () => {
    const user = userEvent.setup();
    render(<AutonomyWorkspace departments={[]} />);
    await user.click(await screen.findByRole("tab", { name: /Schedules/ }));
    await user.click(screen.getByRole("button", { name: "Lead research preset" }));
    const form = screen.getByRole("form", { name: "Add schedules" });
    await user.selectOptions(within(form).getByLabelText("Project"), "project-1");
    await user.selectOptions(within(form).getByLabelText("Days"), "1-5");
    fireEvent.change(within(form).getByLabelText("Time"), { target: { value: "07:30" } });
    await user.clear(within(form).getByLabelText("Time zone"));
    await user.type(within(form).getByLabelText("Time zone"), "Europe/London");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveAutonomy).toHaveBeenCalledWith(
        "schedules",
        expect.objectContaining({ cron: "30 7 * * 1-5", timezone: "Europe/London" }),
        undefined,
      ),
    );
    const saved = vi.mocked(saveAutonomy).mock.calls[0][1] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("tod_days");
    expect(saved).not.toHaveProperty("cron_advanced");
  });
  it("keeps a rejected owner mutation editable and tells the owner where to sign in", async () => {
    vi.mocked(saveAutonomy).mockRejectedValue(
      new ApiRequestError("Forbidden", { status: 403, code: "owner_session_required", url: "/api/autonomy/goals" }),
    );
    const user = userEvent.setup();
    render(<AutonomyWorkspace departments={[]} />);
    await user.click(await screen.findByRole("button", { name: "Add goals" }));
    const form = screen.getByRole("form", { name: "Add goals" });
    await user.selectOptions(within(form).getByLabelText("Project"), "project-1");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings > Security");
    expect(screen.getByRole("form", { name: "Add goals" })).toBeVisible();
  });
  it("shows unavailable metrics honestly instead of claiming income", async () => {
    vi.mocked(getAutonomy).mockResolvedValue({
      ...overview,
      goals: [
        {
          id: "g",
          business: "ventures",
          project_id: "project-1",
          metric: "verified_revenue",
          target: 500,
          period_start: 1,
          period_end: 2,
          progress: null,
        },
      ],
    });
    render(<AutonomyWorkspace departments={[]} />);
    expect(await screen.findByText(/Not measured yet/)).toBeVisible();
  });
});
