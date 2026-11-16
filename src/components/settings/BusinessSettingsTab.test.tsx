import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessApi, type BusinessProfile } from "../../api/business";
import { mailboxApi } from "../../api/business-mailboxes";
import { socialApi } from "../../api/business-social";
import BusinessSettingsTab from "./BusinessSettingsTab";
import BusinessMailboxes from "./BusinessMailboxes";

vi.mock("../../api/business", () => ({ businessApi: { profiles: { list: vi.fn(), update: vi.fn() } } }));
vi.mock("../../api/business-mailboxes", () => ({
  mailboxApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), save: vi.fn(), test: vi.fn() },
}));
vi.mock("../../api/business-social", () => ({ socialApi: { list: vi.fn() } }));
const profile: BusinessProfile = {
  business: "tech",
  name: "Small Business Tech",
  website: "",
  email: "",
  service_area: "",
  hours: "",
  brand_voice: "",
  social_profiles: "",
  services: "",
  workflow_notes: "",
  updated_at: 1,
};
const mailbox = {
  id: "tech",
  is_default: true,
  business: "tech" as const,
  email: "info@example.com",
  username: "info@example.com",
  imap_host: "mail.example.com",
  imap_port: 993,
  smtp_host: "mail.example.com",
  smtp_port: 465,
  has_password: true,
  updated_at: 1,
  last_test_at: null,
  last_test_ok: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(businessApi.profiles.list).mockResolvedValue([profile]);
  vi.mocked(mailboxApi.list).mockResolvedValue([mailbox]);
  vi.mocked(socialApi.list).mockResolvedValue([]);
});

describe("business settings", () => {
  it("preserves a newly selected default when its connection test finishes", async () => {
    const sales = { ...mailbox, id: "sales", email: "sales@example.com", is_default: false };
    vi.mocked(mailboxApi.list)
      .mockResolvedValueOnce([mailbox, sales])
      .mockResolvedValue([
        { ...mailbox, is_default: false },
        { ...sales, is_default: true },
      ]);
    vi.mocked(mailboxApi.update).mockResolvedValue({ ...sales, is_default: true });
    vi.mocked(mailboxApi.test).mockResolvedValue({ ok: true, imap: { ok: true }, smtp: { ok: true }, tested_at: 2 });
    const user = userEvent.setup();
    render(<BusinessMailboxes />);
    await user.click(screen.getByText("Mailcow connections", { exact: true }));
    const summary = await screen.findByText("sales@example.com", { selector: "summary", exact: false });
    await user.click(summary);
    const details = within(summary.closest("details")!);
    await user.click(details.getByRole("button", { name: "Use as default sender" }));
    await waitFor(() => expect(summary).toHaveTextContent("Default"));
    await user.click(details.getByRole("button", { name: "Test saved connection" }));
    await details.findByText(/IMAP: Connected/);
    expect(summary).toHaveTextContent("Default");
    expect(screen.getAllByText("Default", { exact: true })).toHaveLength(1);
  });
  it("adds an extra mailbox using the same server settings without changing the existing account", async () => {
    const user = userEvent.setup();
    render(<BusinessMailboxes />);
    await user.click(screen.getByText("Mailcow connections", { exact: true }));
    const tech = await screen.findByRole("region", { name: "Tech mailboxes" });
    await user.click(within(tech).getByRole("button", { name: "Add mailbox" }));
    const form = within(tech.querySelector("#mailbox-new-tech-email")!.closest("form")!);
    expect(form.getByLabelText("IMAP hostname")).toHaveValue("mail.example.com");
    expect(form.getByLabelText("Mailbox password", { exact: true })).toHaveValue("");
    await user.type(form.getByLabelText("Mailbox address", { exact: true }), "sales@example.com");
    vi.mocked(mailboxApi.create).mockResolvedValue({
      ...mailbox,
      id: "sales",
      email: "sales@example.com",
      is_default: false,
      has_password: false,
    });
    await user.click(form.getByRole("button", { name: "Add mailbox" }));
    expect(await screen.findByText("sales@example.com", { selector: "summary", exact: false })).toBeInTheDocument();
    expect(mailboxApi.create).toHaveBeenCalledWith(
      "tech",
      expect.objectContaining({ email: "sales@example.com", imap_host: "mail.example.com" }),
    );
    expect(mailboxApi.update).not.toHaveBeenCalled();
    expect(screen.getByText("Default", { exact: true }).closest("summary")).toHaveTextContent("info@example.com");
  });
  it("saves owner profile edits and retains them when a save fails", async () => {
    const user = userEvent.setup();
    render(<BusinessSettingsTab />);
    await user.click(screen.getByText("Business profiles", { exact: true }));
    await user.click(await screen.findByText("Small Business Tech", { exact: true, selector: "summary" }));
    const voice = await screen.findByLabelText("Brand voice");
    await user.type(voice, "Friendly and practical");
    vi.mocked(businessApi.profiles.update).mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    expect(await screen.findByText(/Could not save this profile/)).toBeInTheDocument();
    expect(voice).toHaveValue("Friendly and practical");
    vi.mocked(businessApi.profiles.update).mockResolvedValueOnce({ ...profile, brand_voice: "Friendly and practical" });
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    expect(await screen.findByText("Business profile saved.")).toBeInTheDocument();
    expect(businessApi.profiles.update).toHaveBeenLastCalledWith(
      "tech",
      expect.objectContaining({ brand_voice: "Friendly and practical" }),
    );
  });

  it("keeps saved passwords blank, tests saved settings only, and clears a replacement after saving", async () => {
    const user = userEvent.setup();
    render(<BusinessMailboxes />);
    await user.click(screen.getByText("Mailcow connections", { exact: true }));
    const summary = (await screen.findByText("Default", { exact: true })).closest("summary")!;
    await user.click(summary);
    const form = within(summary.closest("details")!.querySelector("form")!);
    const password = form.getByLabelText("Mailbox password");
    expect(password).toHaveValue("");
    vi.mocked(mailboxApi.test).mockResolvedValue({
      ok: true,
      imap: { ok: true },
      smtp: { ok: false, error: "authentication_failed" },
      tested_at: 2,
    });
    await user.click(form.getByRole("button", { name: "Test saved connection" }));
    expect(await form.findByText(/SMTP: Failed/)).toHaveTextContent("authentication_failed");
    await user.type(password, "replacement-password");
    expect(form.getByRole("button", { name: "Test saved connection" })).toBeDisabled();
    vi.mocked(mailboxApi.update).mockResolvedValue(mailbox);
    await user.click(form.getByRole("button", { name: "Save mailbox" }));
    await waitFor(() => expect(password).toHaveValue(""));
    expect(mailboxApi.update).toHaveBeenCalledWith(
      "tech",
      expect.objectContaining({ password: "replacement-password" }),
    );
    await user.click(form.getByRole("button", { name: "Save mailbox" }));
    await waitFor(() => expect(mailboxApi.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mailboxApi.update).mock.calls[1][1]).not.toHaveProperty("password");
  });

  it("recovers from a profile load failure", async () => {
    vi.mocked(businessApi.profiles.list).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([profile]);
    render(<BusinessSettingsTab />);
    await userEvent.click(screen.getByText("Business profiles", { exact: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await userEvent.click(await screen.findByText("Small Business Tech", { exact: true, selector: "summary" }));
    expect(await screen.findByLabelText("Business name")).toHaveValue("Small Business Tech");
  });
});
