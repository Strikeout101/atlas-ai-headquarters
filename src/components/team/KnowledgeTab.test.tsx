import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KnowledgeTab from "./KnowledgeTab";
import MarkdownView from "./MarkdownView";
import { knowledgeApi, type AgentMemory } from "../../api/knowledge";

vi.mock("../../api/knowledge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/knowledge")>()),
  knowledgeApi: {
    document: vi.fn(),
    memories: vi.fn(),
    review: vi.fn(),
    setStatus: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
}));

const memory = (overrides: Partial<AgentMemory> = {}): AgentMemory => ({
  id: "m1",
  kind: "lesson",
  scope: "business",
  business: "rental",
  project_id: null,
  title: "Flower wall photos",
  body: "Use the white flower wall photos.",
  source_agent_id: "worker",
  source_agent_name: "Iris",
  source_task_id: "t1",
  source_task_title: "Improve flower wall page",
  status: "active",
  reviewed_at: null,
  reviewed_by: null,
  use_count: 3,
  last_used_at: 1,
  created_at: Date.UTC(2026, 10, 17),
  updated_at: 1,
  ...overrides,
});

beforeEach(() => {
  localStorage.setItem("climpire.language", "en");
  for (const fn of Object.values(knowledgeApi)) vi.mocked(fn).mockReset();
  vi.mocked(knowledgeApi.memories).mockResolvedValue({
    ok: true,
    items: [
      memory(),
      memory({
        id: "m2",
        title: "Mailcow hosts",
        scope: "global",
        business: null,
        reviewed_at: 5,
        kind: "fact",
        source_agent_name: null,
        source_task_title: null,
      }),
    ],
    counts: { active: 2, unreviewed: 1, archived: 0 },
  });
  for (const fn of [knowledgeApi.review, knowledgeApi.setStatus, knowledgeApi.update, knowledgeApi.create])
    vi.mocked(fn).mockResolvedValue(memory());
});

describe("Knowledge tab", () => {
  it("lists memories with where they came from and which need review", async () => {
    render(<KnowledgeTab />);
    const card = await screen.findByRole("listitem", { name: "Flower wall photos" });
    expect(within(card).getByText("Needs review")).toBeVisible();
    expect(within(card).getByText(/Lesson · for Primrose Events|Lesson · for Events and Rentals/)).toBeVisible();
    expect(within(card).getByText(/from Iris on "Improve flower wall page"/)).toBeVisible();
    expect(within(card).getByText(/used 3 times/)).toBeVisible();
    const reviewed = screen.getByRole("listitem", { name: "Mailcow hosts" });
    expect(within(reviewed).getByText("Reviewed")).toBeVisible();
    expect(within(reviewed).getByText(/for Everyone · added by you/)).toBeVisible();
    expect(within(reviewed).queryByRole("button", { name: "Looks right" })).toBeNull();
    expect(screen.getByText("2 in use · 1 need review · 0 archived")).toBeVisible();
  });

  it("confirms, archives and edits a memory, reloading after each change", async () => {
    const user = userEvent.setup();
    render(<KnowledgeTab />);
    const card = await screen.findByRole("listitem", { name: "Flower wall photos" });
    await user.click(within(card).getByRole("button", { name: "Looks right" }));
    expect(knowledgeApi.review).toHaveBeenCalledWith("m1");
    await user.click(
      within(screen.getByRole("listitem", { name: "Flower wall photos" })).getByRole("button", { name: "Archive" }),
    );
    expect(knowledgeApi.setStatus).toHaveBeenCalledWith("m1", "archived");
    await user.click(
      within(screen.getByRole("listitem", { name: "Flower wall photos" })).getByRole("button", { name: "Edit" }),
    );
    const text = screen.getByLabelText("Text");
    await user.clear(text);
    await user.type(text, "Use white photos only.");
    await user.click(screen.getByRole("button", { name: "Save and mark reviewed" }));
    expect(knowledgeApi.update).toHaveBeenCalledWith("m1", {
      title: "Flower wall photos",
      body: "Use white photos only.",
    });
    expect(vi.mocked(knowledgeApi.memories).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("filters to memories needing review and adds an owner memory for one business", async () => {
    const user = userEvent.setup();
    render(<KnowledgeTab />);
    await screen.findByRole("listitem", { name: "Flower wall photos" });
    await user.selectOptions(screen.getByLabelText("Show"), "Needs review");
    expect(knowledgeApi.memories).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "active", reviewed: "no" }),
    );
    await user.click(screen.getByRole("button", { name: "Add a memory" }));
    const form = screen.getByRole("form", { name: "New memory" });
    await user.type(within(form).getByLabelText("Title"), "Website pricing");
    await user.type(within(form).getByLabelText("What agents should know"), "Websites start at $500 + $80/month.");
    await user.selectOptions(within(form).getByLabelText("For"), "tech");
    await user.click(within(form).getByRole("button", { name: "Save memory" }));
    expect(knowledgeApi.create).toHaveBeenCalledWith({
      kind: "fact",
      scope: "business",
      business: "tech",
      title: "Website pricing",
      body: "Websites start at $500 + $80/month.",
    });
  });

  it("explains a refused change instead of losing it", async () => {
    const user = userEvent.setup();
    vi.mocked(knowledgeApi.review).mockRejectedValue(new Error("owner_session_required"));
    render(<KnowledgeTab />);
    const card = await screen.findByRole("listitem", { name: "Flower wall photos" });
    await user.click(within(card).getByRole("button", { name: "Looks right" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in with your password");
  });

  it("shows the systems registry and the checklist read-only", async () => {
    const user = userEvent.setup();
    vi.mocked(knowledgeApi.document).mockImplementation(async (topic) => ({
      ok: true,
      topic,
      available: topic === "systems",
      text: topic === "systems" ? "# Systems registry\n\n## Summary\n\n- Media host at 10.0.60.35" : "",
    }));
    render(<KnowledgeTab />);
    await user.click(screen.getByRole("tab", { name: "Systems" }));
    expect(await screen.findByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByText("Media host at 10.0.60.35")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Checklist" }));
    expect(await screen.findByText("CHECKLIST.md was not found in the ATLAS folder.")).toBeVisible();
  });
});

describe("Markdown view", () => {
  it("renders headings, tables, checklists and links without injecting HTML", () => {
    render(
      <MarkdownView
        text={[
          "## Hosts",
          "",
          "| Host | Address |",
          "|---|---|",
          "| **Media** | `10.0.60.35` |",
          "",
          "- [x] Done item",
          "- [ ] **YOU** Open item",
          "",
          "See [Square](https://squareup.com) <img src=x onerror=alert(1)>",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { name: "Hosts" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Media" })).toBeVisible();
    expect(screen.getByText("Done:")).toBeInTheDocument();
    expect(screen.getByText("Open:")).toBeInTheDocument();
    expect(screen.getByText("YOU").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Square" })).toHaveAttribute("href", "https://squareup.com");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeVisible();
  });
});
