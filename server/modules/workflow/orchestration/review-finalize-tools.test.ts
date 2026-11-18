import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewFinalizeTools } from "./review-finalize-tools.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup({ github = false, delegated = false, worktree = true } = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT, department_id TEXT,
      source_task_id TEXT, project_id TEXT, project_path TEXT,
      completed_at INTEGER, updated_at INTEGER, created_at INTEGER
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, github_repo TEXT);
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY, task_id TEXT, status TEXT, completed_at INTEGER,
      blocked_reason TEXT, delegated_task_id TEXT
    );
    INSERT INTO projects VALUES ('project', NULL);
    INSERT INTO tasks VALUES ('task', 'Website fix', 'review', 'dev', NULL, 'project', '/repo', NULL, 0, 0);
  `);
  if (github) db.prepare("UPDATE projects SET github_repo = ?").run("primroseevents/website");
  if (delegated) db.prepare("UPDATE tasks SET source_task_id = 'parent'").run();
  const next = vi.fn();
  const subtaskNext = vi.fn();
  const deps = {
    db,
    nowMs: () => 1000,
    resolveLang: () => "en",
    l: (en: string[]) => en,
    pickL: (pool: string[]) => pool[0],
    appendTaskLog: vi.fn(),
    notifyCeo: vi.fn(),
    broadcast: vi.fn(),
    projectReviewGateNotifiedAt: new Map(),
    taskWorktrees: new Map(worktree ? [["task", { projectPath: "/repo", branchName: "climpire/task" }]] : []),
    mergeWorktree: vi.fn(() => ({ success: true, message: "Merged" })),
    mergeToDevAndCreatePR: vi.fn(() => ({ success: true, message: "Merged to dev" })),
    cleanupWorktree: vi.fn(),
    findTeamLeader: () => null,
    setTaskCreationAuditCompletion: vi.fn(),
    endTaskExecutionSession: vi.fn(),
    notifyTaskStatus: vi.fn(),
    refreshCliUsageData: vi.fn(async () => ({})),
    shouldDeferTaskReportUntilPlanningArchive: () => false,
    emitTaskReportEvent: vi.fn(),
    formatTaskSubtaskProgressSummary: () => "",
    reviewRoundState: new Map([["task", 1]]),
    reviewInFlight: new Set(["task"]),
    archivePlanningConsolidatedReport: vi.fn(),
    crossDeptNextCallbacks: new Map([["task", next]]),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map([["task", subtaskNext]]),
    startReviewConsensusMeeting: vi.fn((_id: string, _title: string, _dept: string, approve: () => void) => approve()),
  };
  const tools = createReviewFinalizeTools(deps);
  const finish = () => tools.finishReview("task", "Website fix", { bypassProjectDecisionGate: true });
  const task = () => db.prepare("SELECT status, completed_at FROM tasks WHERE id = 'task'").get();
  return { db, deps, finish, task, next, subtaskNext };
}

describe("review finalization integration gate", () => {
  it.each([false, true])("holds a failed merge and can retry successfully (GitHub=%s)", (github) => {
    const { deps, finish, task, next, subtaskNext } = setup({ github });
    const merge = github ? deps.mergeToDevAndCreatePR : deps.mergeWorktree;
    merge.mockReturnValueOnce({ success: false, message: "Pre-merge auto-commit failed" });

    finish();

    expect(task()).toEqual({ status: "review", completed_at: null });
    expect(deps.taskWorktrees.has("task")).toBe(true);
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.setTaskCreationAuditCompletion).not.toHaveBeenCalled();
    expect(deps.endTaskExecutionSession).not.toHaveBeenCalled();
    expect(deps.notifyTaskStatus).not.toHaveBeenCalled();
    expect(deps.emitTaskReportEvent).not.toHaveBeenCalled();
    expect(deps.archivePlanningConsolidatedReport).not.toHaveBeenCalled();
    expect(deps.refreshCliUsageData).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(subtaskNext).not.toHaveBeenCalled();
    expect(deps.crossDeptNextCallbacks.has("task")).toBe(true);
    expect(deps.subtaskDelegationCallbacks.has("task")).toBe(true);
    expect(deps.reviewInFlight.has("task")).toBe(false);
    expect(deps.reviewRoundState.has("task")).toBe(true);
    expect(deps.notifyCeo).toHaveBeenCalledWith(
      expect.stringContaining(
        "Task remains in Review; resolve the failure and approve again.\nPre-merge auto-commit failed",
      ),
      "task",
    );

    finish();

    expect(task()).toEqual({ status: "done", completed_at: 1000 });
    expect(deps.cleanupWorktree).toHaveBeenCalledOnce();
    expect(deps.setTaskCreationAuditCompletion).toHaveBeenCalledWith("task", true);
    expect(deps.endTaskExecutionSession).toHaveBeenCalledWith("task", "task_done");
    expect(deps.notifyTaskStatus).toHaveBeenCalledWith("task", "Website fix", "done", "en");
    expect(deps.emitTaskReportEvent).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(subtaskNext).toHaveBeenCalledOnce();
  });

  it("preserves delegated tasks and reports conflicting files", () => {
    const { deps, finish, task } = setup({ delegated: true });
    deps.mergeWorktree.mockReturnValueOnce({
      success: false,
      message: "Merge conflict",
      conflicts: ["src/app.ts"],
    } as ReturnType<typeof deps.mergeWorktree>);
    finish();
    expect(task()).toEqual({ status: "review", completed_at: null });
    expect(deps.startReviewConsensusMeeting).not.toHaveBeenCalled();
    expect(deps.notifyCeo).toHaveBeenCalledWith(expect.stringContaining("Conflicting files: src/app.ts"), "task");
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
  });

  it("does not finalize collaboration children when the parent merge fails", () => {
    const { db, deps, finish, task } = setup();
    db.exec(`INSERT INTO tasks VALUES ('child', 'Child fix', 'review', 'dev', 'task', 'project', '/repo', NULL, 0, 1)`);
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "Merge conflict" });
    finish();
    expect(task()).toEqual({ status: "review", completed_at: null });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'child'").get()).toEqual({ status: "review" });
    expect(deps.mergeWorktree).toHaveBeenCalledOnce();
    expect(deps.archivePlanningConsolidatedReport).not.toHaveBeenCalled();
  });

  it("still completes tasks without a worktree", () => {
    const { deps, finish, task } = setup({ worktree: false });
    finish();
    expect(task()).toEqual({ status: "done", completed_at: 1000 });
    expect(deps.mergeWorktree).not.toHaveBeenCalled();
    expect(deps.mergeToDevAndCreatePR).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.emitTaskReportEvent).toHaveBeenCalledOnce();
  });

  it("holds a parent whose merge succeeded until a child merge succeeds", () => {
    const { db, deps, finish, task, next } = setup();
    db.exec(`INSERT INTO tasks VALUES ('child', 'Child fix', 'review', 'dev', 'task', 'project', '/repo', NULL, 0, 1)`);
    deps.taskWorktrees.set("child", { projectPath: "/repo", branchName: "climpire/child" });
    deps.mergeWorktree.mockReturnValueOnce({ success: true, message: "Parent merged" });
    deps.mergeWorktree.mockReturnValueOnce({ success: false, message: "Child conflict" });
    finish();
    expect(task()).toEqual({ status: "review", completed_at: null });
    expect(db.prepare("SELECT status FROM tasks WHERE id='child'").get()).toEqual({ status: "review" });
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.setTaskCreationAuditCompletion).not.toHaveBeenCalled();
    expect(deps.archivePlanningConsolidatedReport).not.toHaveBeenCalled();
    expect(deps.emitTaskReportEvent).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    finish();
    expect(task()).toEqual({ status: "done", completed_at: 1000 });
    expect(db.prepare("SELECT status FROM tasks WHERE id='child'").get()).toEqual({ status: "done" });
    expect(deps.cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(deps.archivePlanningConsolidatedReport).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
