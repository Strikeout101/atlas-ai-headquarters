import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAutonomyDigest } from "../../api/autonomy";
import AutonomyDigest from "./AutonomyDigest";
vi.mock("../../api/autonomy", () => ({ getAutonomyDigest: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});
describe("while you were away", () => {
  it("keeps the digest unread across reloads and advances the cursor only after Mark read", async () => {
    vi.mocked(getAutonomyDigest).mockResolvedValueOnce({
      events: [{ id: "1", event: "schedule_skipped", message: "Usage ceiling reached", created_at: 1234 }],
      counts: { schedule_skipped: 1 },
    });
    render(<AutonomyDigest />);
    expect(await screen.findByText("Usage ceiling reached")).toBeVisible();
    expect(localStorage.getItem("atlas.autonomyDigest.acknowledgedAt")).toBeNull();
    cleanup();
    vi.mocked(getAutonomyDigest)
      .mockResolvedValueOnce({
        events: [{ id: "1", event: "schedule_skipped", message: "Usage ceiling reached", created_at: 1234 }],
        counts: { schedule_skipped: 1 },
      })
      .mockResolvedValue({ events: [], counts: {} });
    render(<AutonomyDigest />);
    await userEvent.click(await screen.findByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(getAutonomyDigest).toHaveBeenLastCalledWith(1234));
    expect(localStorage.getItem("atlas.autonomyDigest.acknowledgedAt")).toBe("1234");
  });
});
