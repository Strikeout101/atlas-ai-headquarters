import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import AppHeaderBar from "./AppHeaderBar";
import { NAV_ITEMS, VIEW_PATHS, viewFromPath } from "./routes";
import { filterCommands, type CommandItem } from "../components/command/CommandPalette";
import type { View } from "./types";

const ALL_VIEWS: View[] = [
  "office",
  "agents",
  "dashboard",
  "tasks",
  "tech",
  "events",
  "outreach",
  "homelab",
  "model_director",
  "skills",
  "settings",
];

describe("view routes", () => {
  it("gives every view a unique address and a nav entry, so nothing becomes unreachable", () => {
    const paths = ALL_VIEWS.map((view) => VIEW_PATHS[view]);
    expect(new Set(paths).size).toBe(ALL_VIEWS.length);
    expect(NAV_ITEMS.map((item) => item.view).sort()).toEqual([...ALL_VIEWS].sort());
    for (const view of ALL_VIEWS) expect(viewFromPath(VIEW_PATHS[view])).toBe(view);
  });

  it("tolerates trailing slashes and case, and sends unknown paths to Today", () => {
    expect(viewFromPath("/Work/")).toBe("tasks");
    expect(viewFromPath("/team/library")).toBe("skills");
    expect(viewFromPath("/nope")).toBe("dashboard");
    expect(viewFromPath("/business")).toBe("tech");
    expect(viewFromPath("/")).toBe("dashboard");
  });
});

describe("command bar search", () => {
  const item = (id: string, group: CommandItem["group"], label: string, keywords = ""): CommandItem => ({
    id,
    group,
    label,
    keywords,
    run: vi.fn(),
  });
  const items = [
    item("nav:tasks", "navigate", "Work", "tasks board"),
    item("nav:settings", "navigate", "Settings", "security password"),
    item("action:reports", "actions", "Reports"),
    item("agent:1", "agents", "Turbo", "homelab"),
    item("task:1", "tasks", "Weekly homelab health check"),
  ];

  it("lists pages and actions but hides agents and tasks until you type", () => {
    expect(filterCommands(items, "").map((i) => i.id)).toEqual(["nav:tasks", "nav:settings", "action:reports"]);
  });

  it("matches labels and keywords, every word must match", () => {
    expect(filterCommands(items, "password").map((i) => i.id)).toEqual(["nav:settings"]);
    expect(filterCommands(items, "homelab").map((i) => i.id)).toEqual(["agent:1", "task:1"]);
    expect(filterCommands(items, "homelab weekly").map((i) => i.id)).toEqual(["task:1"]);
  });
});

describe("AppHeaderBar more menu", () => {
  function props(): ComponentProps<typeof AppHeaderBar> {
    return {
      currentView: "dashboard",
      connected: true,
      viewTitle: "Today",
      tasksPrimaryLabel: "Tasks",
      decisionLabel: "Decisions",
      decisionInboxLoading: false,
      decisionInboxCount: 2,
      agentStatusLabel: "Agent Status",
      reportLabel: "Reports",
      announcementLabel: "Announcement",
      roomManagerLabel: "Office Manager",
      officePackControl: null,
      theme: "dark",
      mobileHeaderMenuOpen: true,
      onOpenMobileNav: vi.fn(),
      onOpenTasks: vi.fn(),
      onOpenDecisionInbox: vi.fn(),
      onOpenAgentStatus: vi.fn(),
      onOpenReportHistory: vi.fn(),
      onOpenAnnouncement: vi.fn(),
      onOpenRoomManager: vi.fn(),
      onToggleTheme: vi.fn(),
      onToggleMobileHeaderMenu: vi.fn(),
      onCloseMobileHeaderMenu: vi.fn(),
    };
  }

  it("keeps agent status, reports and office manager reachable from the menu", async () => {
    const user = userEvent.setup();
    const p = props();
    render(<AppHeaderBar {...p} />);
    await user.click(screen.getByRole("menuitem", { name: /Agent Status/ }));
    await user.click(screen.getByRole("menuitem", { name: /Reports/ }));
    await user.click(screen.getByRole("menuitem", { name: /Office Manager/ }));
    expect(p.onOpenAgentStatus).toHaveBeenCalled();
    expect(p.onOpenReportHistory).toHaveBeenCalled();
    expect(p.onOpenRoomManager).toHaveBeenCalled();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
