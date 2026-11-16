import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ApprovalRow from "./ApprovalRow";
import type { PendingApproval } from "../../api";

const ssh: PendingApproval = {
  kind: "ssh_command",
  id: "a1",
  created_at: Date.now(),
  task_id: "t1",
  task_title: "Weekly homelab health check",
  agent_id: "turbo",
  agent_name: "Turbo",
  target_id: "h1",
  target_name: "pve-dns-01",
  target_host: "10.0.0.5",
  command: "systemctl restart pihole-FTL",
};

function renderRow(item: PendingApproval) {
  const onDecide = vi.fn().mockResolvedValue(undefined);
  const onOpenHomelab = vi.fn();
  render(
    <ul>
      <ApprovalRow item={item} onDecide={onDecide} onOpenHomelab={onOpenHomelab} />
    </ul>,
  );
  return { onDecide, onOpenHomelab };
}

describe("ApprovalRow", () => {
  it("shows the exact email envelope and body before offering approve and send", async () => {
    const email: PendingApproval = {
      kind: "business_email",
      id: "e1",
      created_at: Date.now(),
      task_id: "t1",
      task_title: "Test email",
      agent_id: "worker",
      agent_name: "Felix",
      business: "tech",
      sender: "info@example.com",
      recipient: "owner@example.net",
      subject: "Connection check",
      body: "This is the exact test message.",
    };
    const { onDecide } = renderRow(email);
    expect(screen.getByText("From: info@example.com")).toBeInTheDocument();
    expect(screen.getByText("To: owner@example.net")).toBeInTheDocument();
    expect(screen.getByText("Subject: Connection check")).toBeInTheDocument();
    expect(screen.getByText(email.body)).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Approve and send" }));
    expect(onDecide).toHaveBeenCalledWith(email, true);
    expect(screen.getByRole("button", { name: "Approve and send" })).toBeDisabled();
  });
  it("shows the exact SSH command and only approves after the confirm prompt", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onDecide } = renderRow(ssh);
    expect(screen.getByText("systemctl restart pihole-FTL")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(onDecide).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve once" }));
    expect(confirm.mock.calls[1][0]).toContain("systemctl restart pihole-FTL");
    expect(onDecide).toHaveBeenCalledWith(ssh, true);
  });

  it("denies without a prompt", async () => {
    const user = userEvent.setup();
    const { onDecide } = renderRow(ssh);
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith(ssh, false);
  });

  it("never offers approval when the command can't be shown", async () => {
    const user = userEvent.setup();
    const { onOpenHomelab } = renderRow({ ...ssh, command: null });
    expect(screen.queryByRole("button", { name: "Approve once" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Homelab" }));
    expect(onOpenHomelab).toHaveBeenCalled();
  });

  it("shows the requested model and reason for an upgrade", () => {
    renderRow({
      kind: "model_upgrade",
      id: "u1",
      created_at: Date.now(),
      task_id: "t2",
      task_title: "Delgado Plumbing site",
      agent_id: "bolt",
      agent_name: "Bolt",
      requested_model: "gpt-5",
      requested_reasoning_level: "high",
      reason: "layout refactor failed twice",
    });
    expect(screen.getByText(/gpt-5 · high/)).toBeInTheDocument();
    expect(screen.getByText(/layout refactor failed twice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("shows what an agent suggests and why, and adds it to tasks or dismisses it", async () => {
    const user = userEvent.setup();
    const proposal: PendingApproval = {
      kind: "task_proposal",
      id: "s1",
      created_at: Date.now(),
      task_id: null,
      task_title: null,
      agent_id: "marcus",
      agent_name: "Marcus",
      title: "Audit expiring TLS certificates",
      description: "List every certificate that expires in the next 30 days.",
      reason: "Two services went down last month from expired certs.",
      project_id: "p1",
      project_name: "Homelab",
    };
    const { onDecide } = renderRow(proposal);
    expect(screen.getByText("Suggested task")).toBeInTheDocument();
    expect(screen.getByText("Audit expiring TLS certificates")).toBeInTheDocument();
    expect(screen.getByText("Homelab")).toBeInTheDocument();
    expect(screen.getByText(/expired certs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Add to tasks" }));
    expect(onDecide).toHaveBeenCalledWith(proposal, true);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });
});
