import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildYoloDecisionReplyPayload, readYoloModeEnabled } from "./yolo-mode.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

function createItem(overrides: Partial<DecisionInboxRouteItem>): DecisionInboxRouteItem {
  return {
    id: "decision-1",
    kind: "task_timeout_resume",
    created_at: 1,
    summary: "",
    project_id: "project-1",
    project_name: "Project",
    project_path: "/tmp/project",
    task_id: null,
    task_title: null,
    options: [],
    ...overrides,
  };
}

describe("readYoloModeEnabled", () => {
  it("turns on when settings.yoloMode=true", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO settings (key, value) VALUES ('yoloMode', 'true')").run();
      expect(readYoloModeEnabled(db as any)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("is off when the value is missing", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      expect(readYoloModeEnabled(db as any)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("buildYoloDecisionReplyPayload", () => {
  it("never auto-decides a review the VPs passed to the owner", () => {
    expect(
      buildYoloDecisionReplyPayload(
        createItem({
          kind: "review_owner",
          options: [
            { number: 1, action: "review_retry", label: "One more go" },
            { number: 2, action: "review_accept", label: "Accept" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("task_timeout_resume prefers the resume option", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        id: "decision-timeout",
        kind: "task_timeout_resume",
        task_id: "task-timeout",
        task_title: "Task timeout",
        options: [
          { number: 1, action: "keep_inbox", label: "Keep" },
          { number: 2, action: "resume_timeout_task", label: "Resume" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2 });
  });
});
