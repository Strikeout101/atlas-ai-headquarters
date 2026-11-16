import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAutonomy, saveAutonomy, type AutonomyOverview } from "../../api/autonomy";
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
