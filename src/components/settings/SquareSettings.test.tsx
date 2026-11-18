import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SquareSettings from "./SquareSettings";
import { squareAccountsApi, type SquareAccount } from "../../api/square";

vi.mock("../../api/square", () => ({
  squareAccountsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    mappings: vi.fn(),
    test: vi.fn(),
    sync: vi.fn(),
    remove: vi.fn(),
  },
}));
const main: SquareAccount = {
  id: 1,
  label: "Main Square account",
  receipts: 4,
  environment: "production",
  token_configured: true,
  enabled: false,
  history_since: "2020-01-01T00:00:00Z",
  locations: [
    { id: "loc", name: "Ventures location", currency: "USD", status: "ACTIVE" },
    { id: "loc-tech", name: "Tech location", currency: "USD", status: "ACTIVE" },
  ],
  mappings: [{ business: "ventures", location_id: "loc" }],
  last_test_at: null,
  last_sync_at: null,
  last_sync_error: null,
  watermark: null,
  fee_unknown: 0,
};
const primrose: SquareAccount = {
  ...main,
  id: 2,
  label: "Primrose Events",
  receipts: 0,
  locations: [{ id: "loc-p", name: "Primrose", currency: "USD", status: "ACTIVE" }],
  mappings: [{ business: "rental", location_id: "loc-p" }],
};
const api = vi.mocked(squareAccountsApi);
beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([main]);
  api.update.mockResolvedValue(main);
  api.mappings.mockResolvedValue(main);
  api.test.mockResolvedValue(main);
  api.sync.mockResolvedValue({ ok: true, imported: 3, settings: main });
  api.create.mockResolvedValue(primrose);
  api.remove.mockResolvedValue(undefined);
});
async function open() {
  const user = userEvent.setup();
  render(<SquareSettings />);
  await user.click(screen.getByText("Square payments"));
  await screen.findByLabelText("Square access token");
  return user;
}
describe("Square account settings", () => {
  it("loads lazily, never reveals a saved token, and preserves it when saving blank", async () => {
    render(<SquareSettings />);
    expect(api.list).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByText("Square payments"));
    const token = await screen.findByLabelText("Square access token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Save Square account" }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(1, {
        label: "Main Square account",
        environment: "production",
        history_since: "2020-01-01T00:00:00.000Z",
      }),
    );
  });
  it("shows separate explicit read-only test, location mapping, and sync actions", async () => {
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Test and load locations" }));
    await waitFor(() => expect(api.test).toHaveBeenCalledWith(1));
    await user.click(screen.getByRole("button", { name: "Save Square locations" }));
    await waitFor(() => expect(api.mappings).toHaveBeenCalledWith(1, [{ business: "ventures", location_id: "loc" }]));
    await user.click(screen.getByRole("button", { name: "Sync Square payments now" }));
    await screen.findByText("Square sync completed: 3 payment records read.");
    expect(api.sync).toHaveBeenCalledWith(1);
  });
  it("clears a saved token only with explicit owner confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Clear Square token" }));
    expect(api.update).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear Square token" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(1, { clear_token: true }));
    vi.restoreAllMocks();
  });
  it("shows each Square account separately and blocks a business that another account already has", async () => {
    api.list.mockResolvedValue([main, primrose]);
    const user = userEvent.setup();
    render(<SquareSettings />);
    await user.click(screen.getByText("Square payments"));
    const primroseCard = await screen.findByRole("region", { name: "Primrose Events" });
    const mainCard = screen.getByRole("region", { name: "Main Square account" });
    expect(within(primroseCard).getByText(/0 payment records/)).toBeVisible();
    // Ventures is connected in the main account, so the Primrose account cannot take it, and vice versa for rental.
    expect(within(primroseCard).getByLabelText("Ventures")).toBeDisabled();
    expect(within(mainCard).getByLabelText("Events and rentals")).toBeDisabled();
    // Only an account with no imported payments can be removed.
    expect(within(mainCard).queryByRole("button", { name: "Remove account" })).toBeNull();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(primroseCard).getByRole("button", { name: "Remove account" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(2));
    vi.restoreAllMocks();
  });
  it("adds another Square account by name", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Primrose Events");
    const user = await open();
    api.list.mockResolvedValue([main, primrose]);
    await user.click(screen.getByRole("button", { name: "Add another Square account" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ label: "Primrose Events" }));
    expect(await screen.findByRole("region", { name: "Primrose Events" })).toBeVisible();
    vi.restoreAllMocks();
  });
  it("explains a refused mapping in plain words", async () => {
    api.mappings.mockRejectedValue(new Error("square_business_mapped_in_other_account"));
    const user = await open();
    await user.click(screen.getByRole("button", { name: "Save Square locations" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already connected to a location in another Square account",
    );
  });
});
