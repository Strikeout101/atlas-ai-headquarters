import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../api/core";
import VpDecisions from "./VpDecisions";

vi.mock("../../api/core", () => ({ request: vi.fn() }));
describe("VP decisions", () => {
  it("shows denied requests and the independent reasons", async () => {
    vi.mocked(request).mockResolvedValueOnce({
      items: [
        {
          approval_kind: "task_proposal",
          approval_id: "review-19",
          status: "decided",
          outcome: "deny",
          reason: "atlas-vp-codex: deny: Duplicate work\natlas-vp-claude: deny: Already complete",
          updated_at: 1731000000000,
          reviews: [],
        },
      ],
    });
    render(<VpDecisions />);
    expect(await screen.findByText(/Duplicate work/)).toHaveTextContent("Already complete");
    expect(screen.getByText("deny")).toBeInTheDocument();
  });
  it("shows loading and an actionable error instead of hiding a failed log request", async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error("Session expired"));
    render(<VpDecisions />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(await screen.findByRole("alert")).toHaveTextContent("Session expired");
  });
});
