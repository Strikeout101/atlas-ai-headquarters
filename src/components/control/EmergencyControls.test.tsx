import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmergencyBanner, EmergencyButtons } from "./EmergencyControls";
import { applyControlState, resetControlStoreForTests } from "../../app/controlStore";
import type { ControlMode } from "../../api/control";

const api = vi.hoisted(() => ({
  getControlState: vi.fn(),
  setControlMode: vi.fn(),
}));
vi.mock("../../api/control", () => api);

const stateOf = (mode: ControlMode) => ({ mode, changed_at: 1, reason: null });

function renderBoth() {
  return render(
    <>
      <EmergencyButtons />
      <EmergencyBanner />
    </>,
  );
}

beforeEach(() => {
  localStorage.setItem("atlas.language", "en");
  resetControlStoreForTests();
  api.getControlState.mockReset().mockResolvedValue(stateOf("running"));
  api.setControlMode.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("emergency controls", () => {
  it("shows both buttons and no banner while everything is running", async () => {
    renderBoth();
    expect(await screen.findByRole("button", { name: "Pause autonomy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop everything" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pauses autonomy after a confirm, then offers to resume it", async () => {
    const user = userEvent.setup();
    api.setControlMode.mockResolvedValue({ ok: true, state: stateOf("autonomy_paused") });
    renderBoth();
    await user.click(await screen.findByRole("button", { name: "Pause autonomy" }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.setControlMode).toHaveBeenCalledWith("autonomy_paused");
    expect(await screen.findByText("Autonomy is paused")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Resume autonomy" }).length).toBeGreaterThan(0);
    // Stopping everything stays one click away while autonomy is paused.
    expect(screen.getByRole("button", { name: "Stop everything" })).toBeInTheDocument();
  });

  it("does nothing when the confirm is declined", async () => {
    const user = userEvent.setup();
    vi.mocked(window.confirm).mockReturnValue(false);
    renderBoth();
    await user.click(await screen.findByRole("button", { name: "Stop everything" }));
    expect(api.setControlMode).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stops everything and then offers both ways back", async () => {
    const user = userEvent.setup();
    api.setControlMode.mockResolvedValueOnce({ ok: true, state: stateOf("stopped") });
    renderBoth();
    await user.click(await screen.findByRole("button", { name: "Stop everything" }));

    expect(api.setControlMode).toHaveBeenCalledWith("stopped");
    expect(await screen.findByText("Everything is stopped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause autonomy" })).not.toBeInTheDocument();

    api.setControlMode.mockResolvedValueOnce({ ok: true, state: stateOf("autonomy_paused") });
    await user.click(screen.getByRole("button", { name: "Resume my work only" }));
    expect(api.setControlMode).toHaveBeenLastCalledWith("autonomy_paused");
    expect(await screen.findByText("Autonomy is paused")).toBeInTheDocument();
  });

  it("follows a change made from another tab or device", async () => {
    renderBoth();
    await screen.findByRole("button", { name: "Pause autonomy" });
    act(() => applyControlState(stateOf("stopped")));
    expect(await screen.findByText("Everything is stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume everything" })).toBeInTheDocument();
    act(() => applyControlState({ mode: "nonsense" }));
    expect(screen.getByText("Everything is stopped")).toBeInTheDocument();
  });

  it("says so when the change did not reach the server, and keeps the real state", async () => {
    const user = userEvent.setup();
    api.setControlMode.mockRejectedValue(new Error("offline"));
    renderBoth();
    await user.click(await screen.findByRole("button", { name: "Stop everything" }));
    expect(await screen.findByText(/did not go through/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop everything" })).toBeEnabled());
    expect(screen.queryByText("Everything is stopped")).not.toBeInTheDocument();
  });
});
