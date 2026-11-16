import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SquareSettings from "./SquareSettings";
import {
  getSquareSettings,
  updateSquareSettings,
  updateSquareMappings,
  testSquare,
  syncSquare,
  type SquareConnection,
} from "../../api/square";
vi.mock("../../api/square", () => ({
  getSquareSettings: vi.fn(),
  updateSquareSettings: vi.fn(),
  updateSquareMappings: vi.fn(),
  testSquare: vi.fn(),
  syncSquare: vi.fn(),
}));
const base: SquareConnection = {
  environment: "production",
  token_configured: true,
  enabled: false,
  history_since: "2020-01-01T00:00:00Z",
  locations: [{ id: "loc", name: "Ventures location", currency: "USD", status: "ACTIVE" }],
  mappings: [{ business: "ventures", location_id: "loc" }],
  last_test_at: null,
  last_sync_at: null,
  last_sync_error: null,
  watermark: null,
  fee_unknown: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSquareSettings).mockResolvedValue({ ok: true, connection: base });
  vi.mocked(updateSquareSettings).mockResolvedValue({ ok: true, connection: base });
  vi.mocked(updateSquareMappings).mockResolvedValue({ ok: true, connection: base });
  vi.mocked(testSquare).mockResolvedValue({ ok: true, connection: base });
  vi.mocked(syncSquare).mockResolvedValue({ ok: true, imported: 3, settings: base });
});
async function open() {
  const user = userEvent.setup();
  render(<SquareSettings />);
  await user.click(screen.getByText("Square payments"));
  await screen.findByLabelText("Square access token");
  return user;
}
describe("Square connection settings", () => {
  it("loads lazily, never reveals a saved token, and preserves it when saving blank", async () => {
    render(<SquareSettings />);
    expect(getSquareSettings).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByText("Square payments"));
    const token = await screen.findByLabelText("Square access token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Save Square connection" }));
    await waitFor(() =>
      expect(updateSquareSettings).toHaveBeenCalledWith({
        environment: "production",
        history_since: "2020-01-01T00:00:00.000Z",
      }),
    );
  });
  it("shows separate explicit read-only test, location mapping, and sync actions", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Test and load locations" }));
    await waitFor(() => expect(testSquare).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Save Square locations" }));
    await waitFor(() =>
      expect(updateSquareMappings).toHaveBeenCalledWith([{ business: "ventures", location_id: "loc" }]),
    );
    await user.click(screen.getByRole("button", { name: "Sync Square payments now" }));
    await screen.findByText("Square sync completed: 3 payment records read.");
    expect(syncSquare).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Cash, external records, sandbox payments/)).toBeVisible();
  });
  it("clears a saved token only with explicit owner confirmation and explains retained history", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Clear Square token" }));
    expect(updateSquareSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear Square token" }));
    await waitFor(() => expect(updateSquareSettings).toHaveBeenCalledWith({ clear_token: true }));
    vi.restoreAllMocks();
  });
});
