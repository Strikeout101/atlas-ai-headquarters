import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EtsySettings from "./settings/EtsySettings";
import StudioSettings from "./settings/StudioSettings";
import ProfitPanel from "./revenue/ProfitPanel";
import PlaybooksPanel from "./autonomy/PlaybooksPanel";
import { etsyApi, type EtsySettings as EtsyState } from "../api/etsy";
import { studioApi, type StudioSettings as StudioState } from "../api/studio";
import * as finance from "../api/finance";
import * as autonomy from "../api/autonomy";

vi.mock("../api/etsy", () => ({
  etsyApi: {
    get: vi.fn(),
    save: vi.fn(),
    connect: vi.fn(),
    complete: vi.fn(),
    test: vi.fn(),
    sync: vi.fn(),
    disconnect: vi.fn(),
    pushDraft: vi.fn(),
    publish: vi.fn(),
  },
}));
vi.mock("../api/studio", () => ({
  studioApi: { get: vi.fn(), save: vi.fn(), test: vi.fn(), media: vi.fn(), fileUrl: (id: string) => `/f/${id}` },
}));
vi.mock("../api/finance", async (original) => ({
  ...(await original<typeof import("../api/finance")>()),
  saveRecurringCost: vi.fn(),
  deleteRecurringCost: vi.fn(),
  setCostsComplete: vi.fn(),
}));
vi.mock("../api/autonomy", async (original) => ({
  ...(await original<typeof import("../api/autonomy")>()),
  savePlaybook: vi.fn(),
  resetPlaybook: vi.fn(),
  addPlaybookResearchSchedule: vi.fn(),
}));

const etsy: EtsyState = {
  business: "ventures",
  keystring: "",
  shared_secret_set: false,
  redirect_uri: "",
  connected: false,
  shop_id: null,
  shop_name: null,
  expires_at: null,
  auto_publish: false,
  sync_enabled: true,
  last_test_at: null,
  last_test_ok: null,
  last_error: null,
  last_sync_at: null,
  last_sync_error: null,
  scopes: ["listings_r"],
};
const studio: StudioState = {
  provider: "none",
  base_url: "",
  api_key_set: false,
  model: "",
  image_size: "1024x1024",
  cost_per_image_minor: 0,
  monthly_cap_minor: 0,
  enabled: false,
  chrome_path: "",
  license_note: "",
  spent_this_month_minor: 0,
  renderer_browser: "C:/Chrome/chrome.exe",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(etsyApi.get).mockResolvedValue(etsy);
  vi.mocked(studioApi.get).mockResolvedValue(studio);
});

describe("Etsy card", () => {
  it("saves the app details without echoing the secret, and finishes connecting from the pasted address", async () => {
    const user = userEvent.setup();
    vi.mocked(etsyApi.save).mockResolvedValue({
      ...etsy,
      keystring: "abc",
      shared_secret_set: true,
      redirect_uri: "https://localhost/atlas-etsy",
    });
    vi.mocked(etsyApi.complete).mockResolvedValue({
      ...etsy,
      connected: true,
      shop_id: "777",
      shop_name: "EduardoCapital",
    });
    render(<EtsySettings />);
    const app = await screen.findByRole("form", { name: "Etsy app" });
    await user.type(within(app).getByLabelText("App keystring"), "abc");
    await user.type(within(app).getByLabelText(/Shared secret/), "s3cret");
    await user.click(within(app).getByRole("button", { name: "Save app details" }));
    expect(etsyApi.save).toHaveBeenCalledWith({
      keystring: "abc",
      redirect_uri: "https://localhost/atlas-etsy",
      shared_secret: "s3cret",
    });
    expect(within(app).getByLabelText(/Shared secret \(saved/)).toHaveValue("");
    await user.type(screen.getByLabelText("Address after approving"), "https://localhost/atlas-etsy?code=c&state=s");
    await user.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(etsyApi.complete).toHaveBeenCalledWith("https://localhost/atlas-etsy?code=c&state=s");
    expect(await screen.findByText(/Connected to EduardoCapital/)).toBeVisible();
    expect(screen.getByLabelText(/Publish approved listings automatically/)).not.toBeChecked();
  });

  it("explains a state mismatch in plain words", async () => {
    const user = userEvent.setup();
    vi.mocked(etsyApi.complete).mockRejectedValue(new Error("etsy_state_mismatch"));
    render(<EtsySettings />);
    await user.type(await screen.findByLabelText("Address after approving"), "https://x/?code=1&state=2");
    await user.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different connect attempt");
  });
});

describe("Studio card", () => {
  it("shows the free renderer is ready and saves a provider with a monthly cap in cents", async () => {
    const user = userEvent.setup();
    vi.mocked(studioApi.save).mockResolvedValue({
      ...studio,
      provider: "openai_compatible",
      base_url: "https://img/v1",
      model: "m",
      monthly_cap_minor: 1500,
    });
    render(<StudioSettings />);
    expect(await screen.findByText(/ready, using C:\/Chrome\/chrome.exe/)).toBeVisible();
    const form = screen.getByRole("form", { name: "Image studio settings" });
    await user.type(within(form).getByLabelText(/Image service address/), "https://img/v1");
    await user.type(within(form).getByLabelText("Model"), "m");
    await user.clear(within(form).getByLabelText("Monthly cap (USD)"));
    await user.type(within(form).getByLabelText("Monthly cap (USD)"), "15");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(studioApi.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai_compatible", monthly_cap_minor: 1500 }),
    );
  });
});

describe("Profit panel", () => {
  it("shows profit per business, adds a monthly cost and confirms costs are complete", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <ProfitPanel
        locale="en-US"
        busy={false}
        onChanged={onChanged}
        onError={vi.fn()}
        profit={{
          from: 0,
          to: 1,
          costs_complete: false,
          lines: [
            {
              business: "ventures",
              currency: "USD",
              revenue_minor: 5000,
              expense_minor: 500,
              recurring_minor: 1000,
              profit_minor: 3500,
            },
          ],
          recurring_costs: [],
        }}
      />,
    );
    expect(screen.getByText("Profit (estimate)")).toBeVisible();
    expect(screen.getByText("$35.00")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add a monthly cost" }));
    const form = screen.getByRole("form", { name: "Add a monthly cost" });
    await user.type(within(form).getByLabelText("Name"), "Claude Max");
    await user.type(within(form).getByLabelText("USD a month"), "100");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(finance.saveRecurringCost).toHaveBeenCalledWith({
      label: "Claude Max",
      business: null,
      category: "ai_tools",
      amount_minor: 10000,
      currency: "USD",
    });
    await user.click(screen.getByLabelText(/My monthly costs are complete/));
    expect(finance.setCostsComplete).toHaveBeenCalledWith(true);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

describe("Playbooks panel", () => {
  it("edits a step and adds the research schedule for a project", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn(async (action: () => Promise<unknown>) => void (await action()));
    const step = (key: string) => ({ key, title: `${key} {title}`, department_id: "design", instructions: "Do it" });
    render(
      <PlaybooksPanel
        busy={false}
        mutate={mutate}
        departments={
          [
            { id: "design", name: "Design" },
            { id: "planning", name: "Planning" },
          ] as never
        }
        projects={[{ id: "p1", name: "Etsy shop" }] as never}
        playbooks={[
          {
            key: "etsy_digital",
            title: "Etsy digital products",
            business: "ventures",
            research: { ...step("research"), department_id: "planning" },
            steps: [step("build")],
            updated_at: 0,
          },
        ]}
      />,
    );
    const save = screen.getByRole("button", { name: "Save playbook" });
    expect(save).toBeDisabled();
    const titles = screen.getAllByLabelText(/Task title/);
    await user.clear(titles[1]);
    await user.type(titles[1], "Make {{title}");
    await user.click(save);
    expect(autonomy.savePlaybook).toHaveBeenCalledWith(
      "etsy_digital",
      expect.objectContaining({ steps: [expect.objectContaining({ title: "Make {title}" })] }),
    );
    await user.selectOptions(screen.getByLabelText("Project for the research schedule"), "p1");
    await user.click(screen.getByRole("button", { name: /Add weekly research schedule/ }));
    expect(autonomy.addPlaybookResearchSchedule).toHaveBeenCalledWith("etsy_digital", "p1");
  });
});
