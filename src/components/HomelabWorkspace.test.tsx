import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/homelab";
import type { Agent } from "../types";
import HomelabWorkspace from "./HomelabWorkspace";

vi.mock("../api/homelab", () => ({
  getHomelabSshTargets: vi.fn(),
  getHomelabSshApprovals: vi.fn(),
  getHomelabApprovalPolicy: vi.fn(),
  getHomelabSshRuns: vi.fn(),
  updateHomelabSshTarget: vi.fn(),
  setHomelabSshGrants: vi.fn(),
}));

const host: api.HomelabSshTarget = {
  id: "media",
  name: "Media",
  host: "10.0.60.35",
  port: 22,
  ssh_user: "operator",
  enabled: true,
  restrict_agents: false,
  auth_method: "password",
  has_credential: true,
  has_passphrase: false,
  host_fingerprint: null,
  agent_ids: ["worker"],
  created_at: 1,
  updated_at: 1,
};
const agents = [{ id: "worker", name: "Marcus" }] as Agent[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getHomelabSshTargets).mockResolvedValue({ ok: true, targets: [host] });
  vi.mocked(api.getHomelabSshApprovals).mockResolvedValue({ approvals: [] });
  vi.mocked(api.getHomelabApprovalPolicy).mockResolvedValue({ ok: true, auto_approve_read_only: true });
  vi.mocked(api.getHomelabSshRuns).mockResolvedValue({ ok: true, runs: [] });
});

describe("SSH host access settings", () => {
  it("defaults to all agents, restores saved selections when restricted, and keeps them when reopened", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateHomelabSshTarget).mockImplementation(async (_id, input) => ({
      ok: true,
      target: { ...host, ...input },
    }));
    render(<HomelabWorkspace agents={agents} />);
    const toggle = await screen.findByRole("checkbox", { name: /Restrict to selected agents/ });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Marcus" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(api.updateHomelabSshTarget).toHaveBeenCalledWith("media", { restrict_agents: true });
    expect(await screen.findByRole("checkbox", { name: "Marcus" })).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByRole("checkbox", { name: "Marcus" })).not.toBeInTheDocument();
    expect(api.setHomelabSshGrants).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(await screen.findByRole("checkbox", { name: "Marcus" })).toBeChecked();
  });

  it("keeps the saved access mode when the server refuses a change", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateHomelabSshTarget).mockRejectedValue(new Error("Unable to save access"));
    render(<HomelabWorkspace agents={agents} />);
    const toggle = await screen.findByRole("checkbox", { name: /Restrict to selected agents/ });
    await user.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save access");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });
});
