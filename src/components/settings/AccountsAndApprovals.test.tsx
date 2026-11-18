import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BusinessApprovals from "./BusinessApprovals";
import GitHubAccounts from "./GitHubAccounts";
import SpendingBudgets from "./SpendingBudgets";
import ApprovalRow from "../today/ApprovalRow";
import {
  githubAccountsApi,
  policiesApi,
  spendBudgetsApi,
  trustOffersApi,
  type BusinessPolicy,
  type GitHubAccount,
  type SpendBudget,
} from "../../api/accounts";
import type { PendingApproval } from "../../api";

vi.mock("../../api/accounts", () => ({
  policiesApi: { list: vi.fn(), update: vi.fn() },
  githubAccountsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), test: vi.fn(), remove: vi.fn() },
  trustOffersApi: { list: vi.fn(), answer: vi.fn() },
  spendBudgetsApi: { list: vi.fn(), save: vi.fn() },
}));

const limits = {
  owner_amount_minor: 100000,
  amount_currency: "USD",
  tier_to_owner: "important",
  trust_ramp_after: 20,
} as const;
const policies: BusinessPolicy[] = [
  { business: "tech", customer_sends: "owner", record_changes: "none", code_pushes: "none", ...limits, updated_at: 0 },
  {
    business: "rental",
    customer_sends: "owner",
    record_changes: "owner",
    code_pushes: "none",
    ...limits,
    updated_at: 0,
  },
  { business: "ventures", customer_sends: "vp", record_changes: "none", code_pushes: "none", ...limits, updated_at: 0 },
];
const account: GitHubAccount = {
  id: "g1",
  label: "Primrose GitHub",
  business: "rental",
  login: "primrose-bot",
  is_default: 1,
  has_token: true,
  last_test_at: 1,
  last_test_ok: 1,
  last_error: null,
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  localStorage.setItem("climpire.language", "en");
  vi.mocked(policiesApi.list).mockReset().mockResolvedValue(policies);
  vi.mocked(policiesApi.update).mockReset();
  for (const fn of Object.values(githubAccountsApi)) vi.mocked(fn).mockReset();
  vi.mocked(githubAccountsApi.list).mockResolvedValue([account]);
  vi.mocked(trustOffersApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(trustOffersApi.answer).mockReset();
  vi.mocked(spendBudgetsApi.list).mockReset();
  vi.mocked(spendBudgetsApi.save).mockReset();
});

describe("Approvals settings", () => {
  it("shows each business's levels and saves a change", async () => {
    const user = userEvent.setup();
    vi.mocked(policiesApi.update).mockResolvedValue({ ...policies[1], record_changes: "vp" });
    render(<BusinessApprovals />);
    await user.click(screen.getByText("Approvals"));
    const rental = await screen.findByRole("group", { name: "Events and rentals approvals" });
    const records = within(rental).getByLabelText("Agent changes to contacts, tickets, quotes and deals");
    expect(records).toHaveValue("owner");
    expect(within(rental).getByLabelText("Emails, posts and listings customers see")).toHaveValue("owner");
    await user.selectOptions(records, "vp");
    expect(policiesApi.update).toHaveBeenCalledWith("rental", { record_changes: "vp" });
    expect(await screen.findByText("Events and rentals approvals saved.")).toBeVisible();
    expect(
      screen.getByText(/Spending money, paid accounts, accepting terms and destructive SSH always need you/),
    ).toBeVisible();
  });

  it("explains when the owner must sign in", async () => {
    const user = userEvent.setup();
    vi.mocked(policiesApi.update).mockRejectedValue(new Error("owner_session_required"));
    render(<BusinessApprovals />);
    await user.click(screen.getByText("Approvals"));
    const tech = await screen.findByRole("group", { name: "Tech services approvals" });
    await user.selectOptions(within(tech).getByLabelText("Pushing reviewed code to GitHub"), "owner");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in with your password");
  });

  it("saves the deal-size limit in whole dollars and the client tier rule", async () => {
    const user = userEvent.setup();
    vi.mocked(policiesApi.update).mockImplementation(async (_business, input) => ({ ...policies[0], ...input }));
    render(<BusinessApprovals />);
    await user.click(screen.getByText("Approvals"));
    const tech = await screen.findByRole("group", { name: "Tech services approvals" });
    const limit = within(tech).getByLabelText("Deals and quotes this big come to me");
    expect(limit).toHaveValue("1000");
    await user.clear(limit);
    await user.type(limit, "2500{Enter}");
    expect(policiesApi.update).toHaveBeenCalledWith("tech", { owner_amount_minor: 250000 });
    await user.selectOptions(within(tech).getByLabelText("Important clients"), "vip");
    expect(policiesApi.update).toHaveBeenCalledWith("tech", { tier_to_owner: "vip" });
  });

  it("shows a trust-ramp suggestion and only changes the setting when accepted", async () => {
    const user = userEvent.setup();
    const offer = {
      business: "rental" as const,
      kind: "record_changes" as const,
      streak: 20,
      approved: 24,
      denied: 1,
      agents: [],
    };
    vi.mocked(trustOffersApi.list).mockResolvedValue([offer]);
    vi.mocked(trustOffersApi.answer).mockResolvedValue({
      ok: true,
      policy: { ...policies[1], record_changes: "vp" },
      items: [],
    });
    render(<BusinessApprovals />);
    await user.click(screen.getByText("Approvals"));
    const card = await screen.findByRole("listitem", { name: "Events and rentals agent changes to records" });
    expect(card).toHaveTextContent("you approved 20 agent changes to records in a row");
    expect(policiesApi.update).not.toHaveBeenCalled();
    await user.click(within(card).getByRole("button", { name: "Let VPs approve" }));
    expect(trustOffersApi.answer).toHaveBeenCalledWith("rental", "record_changes", true);
    expect(
      await screen.findByText("Both VPs now approve agent changes to records for Events and rentals."),
    ).toBeVisible();
    expect(
      within(screen.getByRole("group", { name: "Events and rentals approvals" })).getByLabelText(
        "Agent changes to contacts, tickets, quotes and deals",
      ),
    ).toHaveValue("vp");
  });
});

describe("Spending budgets", () => {
  const budget = (category: SpendBudget["category"], monthly = 0): SpendBudget => ({
    business: "tech",
    category,
    currency: "USD",
    monthly_cap_minor: monthly,
    per_item_cap_minor: 0,
    used_minor: 0,
    remaining_minor: monthly,
    month: "2026-11",
    updated_at: 0,
  });

  it("starts at $0 and saves a budget in whole dollars", async () => {
    const user = userEvent.setup();
    vi.mocked(spendBudgetsApi.list).mockResolvedValue([budget("ai_tools"), budget("hosting")]);
    vi.mocked(spendBudgetsApi.save).mockResolvedValue({ ...budget("hosting", 5000), per_item_cap_minor: 2000 });
    render(<SpendingBudgets />);
    expect(await screen.findByText("All $0 · every spend request comes to you")).toBeInTheDocument();
    await user.click(screen.getByText("Spending budgets"));
    const hosting = screen.getByRole("form", { name: "Hosting and domains budget" });
    await user.clear(within(hosting).getByLabelText("Monthly budget (USD)"));
    await user.type(within(hosting).getByLabelText("Monthly budget (USD)"), "50");
    await user.clear(within(hosting).getByLabelText("Per item (USD)"));
    await user.type(within(hosting).getByLabelText("Per item (USD)"), "20");
    await user.click(within(hosting).getByRole("button", { name: "Save" }));
    expect(spendBudgetsApi.save).toHaveBeenCalledWith({
      business: "tech",
      category: "hosting",
      currency: "USD",
      monthly_cap_minor: 5000,
      per_item_cap_minor: 2000,
    });
    expect(await screen.findByText("Hosting and domains budget saved.")).toBeVisible();
    expect(screen.getByText(/ATLAS never pays for anything itself/)).toBeVisible();
  });
});

describe("GitHub accounts settings", () => {
  it("lists accounts with who they belong to, without any token", async () => {
    const user = userEvent.setup();
    render(<GitHubAccounts />);
    await user.click(screen.getByText("GitHub accounts"));
    const card = await screen.findByRole("listitem", { name: "Primrose GitHub" });
    expect(within(card).getByText("Events and rentals · default")).toBeVisible();
    expect(within(card).getByText("Signed in as primrose-bot")).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Make default" })).toBeNull();
  });

  it("adds an account, tests it right away, and reports the result", async () => {
    const user = userEvent.setup();
    vi.mocked(githubAccountsApi.create).mockResolvedValue({ ...account, id: "g2", label: "Personal", business: null });
    vi.mocked(githubAccountsApi.test).mockResolvedValue({
      ok: true,
      connected: true,
      login: "Strikeout101",
      error: null,
      account,
    });
    render(<GitHubAccounts />);
    await user.click(screen.getByText("GitHub accounts"));
    const form = await screen.findByRole("form", { name: "Add GitHub account" });
    await user.type(within(form).getByLabelText("Account name"), "Personal");
    await user.type(within(form).getByLabelText("Fine-grained token"), "github_pat_example");
    expect(within(form).getByLabelText("Fine-grained token")).toHaveAttribute("type", "password");
    await user.click(within(form).getByRole("button", { name: "Add and test account" }));
    expect(githubAccountsApi.create).toHaveBeenCalledWith({
      label: "Personal",
      business: "personal",
      token: "github_pat_example",
    });
    expect(await screen.findByText("Personal added and signed in as Strikeout101.")).toBeVisible();
    await waitFor(() => expect(within(form).getByLabelText("Fine-grained token")).toHaveValue(""));
  });

  it("explains a rejected token in plain words", async () => {
    const user = userEvent.setup();
    vi.mocked(githubAccountsApi.test).mockResolvedValue({
      ok: true,
      connected: false,
      login: null,
      error: "github_token_rejected",
      account,
    });
    render(<GitHubAccounts />);
    await user.click(screen.getByText("GitHub accounts"));
    const card = await screen.findByRole("listitem", { name: "Primrose GitHub" });
    await user.click(within(card).getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub rejected the token");
  });
});

describe("Today rows", () => {
  const base = {
    created_at: Date.now(),
    task_id: "task-1",
    task_title: "Follow up",
    agent_id: "worker",
    agent_name: "Worker",
    decide_path: "",
  };
  it("shows a held record change with what would change, and approves it", async () => {
    const user = userEvent.setup();
    const item: PendingApproval = {
      ...base,
      kind: "record_change",
      id: "r1",
      business: "rental",
      resource: "contacts",
      action: "update",
      target_id: "c1",
      summary: 'Change contact "Lee"',
      payload: { phone: "555-0100" },
      current: { phone: "555-0000", name: "Lee" },
      client_tier: "vip",
      deal_amount_minor: 250000,
      deal_currency: "USD",
    };
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <ul>
        <ApprovalRow item={item} onDecide={onDecide} onOpenHomelab={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("Record change")).toBeVisible();
    expect(screen.getByText("VIP client")).toBeVisible();
    expect(screen.getByText(/deal \$2,500/)).toBeVisible();
    expect(screen.getByText('Change contact "Lee"')).toBeVisible();
    expect(screen.getByText("555-0000")).toHaveClass("line-through");
    expect(screen.getByText(/Approving applies exactly this/)).toBeVisible();
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);
    expect(onDecide).toHaveBeenCalledWith(item, true);
  });

  it("shows a held code push with the repo and the account that will push it", () => {
    const item: PendingApproval = {
      ...base,
      kind: "code_push",
      id: "p1",
      business: "rental",
      project_id: "proj",
      project_name: "Primrose site",
      github_repo: "primrose/site",
      branch: "dev",
      account_label: "Primrose GitHub",
      account_login: "primrose-bot",
      title: "New flower wall section",
    };
    render(
      <ul>
        <ApprovalRow item={item} onDecide={vi.fn()} onOpenHomelab={vi.fn()} />
      </ul>,
    );
    expect(screen.getByText("Code push")).toBeVisible();
    expect(screen.queryByText(/client/)).toBeNull();
    expect(screen.getByText("New flower wall section")).toBeVisible();
    expect(screen.getByText("primrose/site")).toBeVisible();
    expect(
      screen.getByText(/Pushes with Primrose GitHub \(primrose-bot\) and opens a pull request to main/),
    ).toBeVisible();
  });
});
