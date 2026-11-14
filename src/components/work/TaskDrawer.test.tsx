import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import type { Task } from "../../types";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  getTaskModelRoute: vi.fn(),
  getTerminal: vi.fn(),
}));

import * as api from "../../api";
import TaskDrawer from "./TaskDrawer";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Delgado Plumbing site",
    description: "Build the services page",
    department_id: null,
    assigned_agent_id: null,
    status: "inbox",
    priority: 2,
    task_type: "development",
    project_path: "C:/work/delgado",
    result: null,
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as Task;
}

function setup(overrides: Partial<ComponentProps<typeof TaskDrawer>> = {}) {
  const props: ComponentProps<typeof TaskDrawer> = {
    task: task(),
    agents: [],
    departments: [],
    subtasks: [],
    approvals: [],
    onClose: vi.fn(),
    onUpdateTask: vi.fn(),
    onAssignTask: vi.fn(),
    onRunTask: vi.fn(),
    onStopTask: vi.fn(),
    onPauseTask: vi.fn(),
    onResumeTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onOpenTerminal: vi.fn(),
    onOpenMeetingMinutes: vi.fn(),
    onOpenReport: vi.fn(),
    onDecideApproval: vi.fn().mockResolvedValue(undefined),
    onOpenHomelab: vi.fn(),
    ...overrides,
  };
  render(<TaskDrawer {...props} />);
  return props;
}

describe("TaskDrawer", () => {
  const originalConfirm = window.confirm;
  beforeEach(() => {
    window.confirm = vi.fn(() => true);
    vi.mocked(api.getTaskModelRoute).mockResolvedValue({ ok: true, route: null, candidates: [], requests: [] });
    vi.mocked(api.getTerminal).mockResolvedValue({
      ok: true,
      exists: true,
      path: "",
      text: "line one\nline two",
      task_logs: [{ id: 1, kind: "system", message: "Run started", created_at: Date.now() }],
    });
  });
  afterEach(() => {
    window.confirm = originalConfirm;
  });

  it("shows details and refuses to run without an agent", async () => {
    const user = userEvent.setup();
    const props = setup();
    expect(screen.getByRole("dialog", { name: "Delgado Plumbing site" })).toBeInTheDocument();
    expect(screen.getByText("Build the services page")).toBeInTheDocument();
    expect(screen.getByText("C:/work/delgado")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Run/ }));
    expect(props.onRunTask).not.toHaveBeenCalled();
    expect(screen.getByText("Please assign an agent!")).toBeInTheDocument();
  });

  it("offers log, minutes, diff and report for a task in review, and recent activity", async () => {
    const user = userEvent.setup();
    const props = setup({ task: task({ status: "review", assigned_agent_id: "a1" }) });
    await user.click(screen.getByRole("button", { name: /Full log/ }));
    await user.click(screen.getByRole("button", { name: /Minutes/ }));
    await user.click(screen.getByRole("button", { name: /Report/ }));
    expect(props.onOpenTerminal).toHaveBeenCalledWith("t1");
    expect(props.onOpenMeetingMinutes).toHaveBeenCalledWith("t1");
    expect(props.onOpenReport).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: /Diff · merge/ })).toBeInTheDocument();
    expect(await screen.findByText("Run started")).toBeInTheDocument();
  });

  it("asks before stopping a running task and closes on Escape", async () => {
    const user = userEvent.setup();
    const props = setup({ task: task({ status: "in_progress", assigned_agent_id: "a1", started_at: Date.now() }) });
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onStopTask).toHaveBeenCalledWith("t1");
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("lists approvals waiting on this task", () => {
    setup({
      approvals: [
        {
          kind: "ssh_command",
          id: "s1",
          created_at: Date.now(),
          task_id: "t1",
          task_title: "Delgado Plumbing site",
          agent_id: "a1",
          agent_name: "Turbo",
          target_id: "h1",
          target_name: "pve-dns-01",
          target_host: null,
          command: "systemctl restart nginx",
        },
      ],
    });
    expect(screen.getByText("systemctl restart nginx")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeInTheDocument();
  });
});
