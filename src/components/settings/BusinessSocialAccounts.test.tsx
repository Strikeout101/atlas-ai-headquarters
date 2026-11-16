import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { socialApi, type SocialAccount } from "../../api/business-social";
import BusinessSocialAccounts from "./BusinessSocialAccounts";

vi.mock("../../api/business-social", () => ({
  socialApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), test: vi.fn(), disconnect: vi.fn(), media: vi.fn() },
}));
const account: SocialAccount = {
  id: "primrose",
  business: "rental",
  platform: "instagram",
  username: "primroseevents_",
  profile_url: "https://www.instagram.com/primroseevents_/",
  has_access_token: false,
  connection_status: "not_connected",
  provider_user_id: null,
  display_name: null,
  last_test_at: null,
  last_test_ok: null,
  updated_at: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(socialApi.list).mockResolvedValue([account]);
});
describe("Instagram settings", () => {
  it("keeps planning-only profiles clearly disconnected and never calls Instagram automatically", async () => {
    const user = userEvent.setup();
    render(<BusinessSocialAccounts />);
    await user.click(screen.getByText("Social accounts", { exact: true }));
    const summary = await screen.findByText("@primroseevents_", { exact: false, selector: "summary" });
    expect(summary).toHaveTextContent("Not connected");
    await user.click(summary);
    expect(screen.getByRole("button", { name: "Verify saved connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load recent posts" })).toBeDisabled();
    expect(socialApi.test).not.toHaveBeenCalled();
    expect(socialApi.media).not.toHaveBeenCalled();
  });
  it("stores replacement tokens only on save, clears the field, and does not invent verified status", async () => {
    const user = userEvent.setup();
    render(<BusinessSocialAccounts />);
    await user.click(screen.getByText("Social accounts", { exact: true }));
    await user.click(await screen.findByText("@primroseevents_", { exact: false, selector: "summary" }));
    const token = screen.getByLabelText("Access token (optional)");
    await user.type(token, "owner-entered-token");
    vi.mocked(socialApi.update).mockResolvedValue({
      ...account,
      has_access_token: true,
      connection_status: "configured",
    });
    await user.click(screen.getByRole("button", { name: "Save Instagram account" }));
    await waitFor(() => expect(token).toHaveValue(""));
    expect(socialApi.update).toHaveBeenCalledWith("primrose", {
      username: "primroseevents_",
      access_token: "owner-entered-token",
    });
    expect(screen.getByText(/Token saved · verify account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load recent posts" })).toBeDisabled();
  });
  it("loads only on request and states that captions are unavailable", async () => {
    vi.mocked(socialApi.list).mockResolvedValue([
      { ...account, connection_status: "verified", has_access_token: true },
    ]);
    vi.mocked(socialApi.media).mockResolvedValue({
      ok: true,
      items: [
        {
          id: "post",
          caption: null,
          media_type: "IMAGE",
          permalink: "https://www.instagram.com/p/test/",
          timestamp: "2026-11-15T12:00:00Z",
        },
      ],
    });
    render(<BusinessSocialAccounts />);
    await userEvent.click(screen.getByText("Social accounts", { exact: true }));
    await userEvent.click(await screen.findByText("@primroseevents_", { exact: false, selector: "summary" }));
    await userEvent.click(screen.getByRole("button", { name: "Load recent posts" }));
    expect(await screen.findByText(/Caption unavailable through this connection/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on Instagram" })).toHaveAttribute(
      "href",
      "https://www.instagram.com/p/test/",
    );
    expect(socialApi.media).toHaveBeenCalledTimes(1);
    const username = screen.getByLabelText("Instagram username");
    await userEvent.clear(username);
    await userEvent.type(username, "primrose_new");
    vi.mocked(socialApi.update).mockResolvedValue({
      ...account,
      username: "primrose_new",
      connection_status: "configured",
      has_access_token: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Instagram account" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "View on Instagram" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Load recent posts" })).toBeDisabled();
  });
});
