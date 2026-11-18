import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildYoloDecisionReplyPayload,
  readYoloModeEnabled,
  runYoloDecisionAutopilot,
  type DecisionApplyResult,
} from "./yolo-mode.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

function createItem(overrides: Partial<DecisionInboxRouteItem>): DecisionInboxRouteItem {
  return {
    id: "decision-1",
    kind: "project_review_ready",
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
  it("project_review_ready picks start_project_review after the owner pick", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        kind: "project_review_ready",
        options: [
          { number: 1, action: "start_project_review", label: "Start" },
          { number: 2, action: "add_followup_request", label: "Follow-up" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 1 });
  });

  it("project_review_ready prefers the owner pick when both it and start are offered", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        kind: "project_review_ready",
        options: [
          { number: 1, action: "start_project_review", label: "Start" },
          { number: 2, action: "approve_task_review:task-a", label: "A" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2 });
  });

  it("review_round_pick applies the recommended numbers from the summary as a multi-pick", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        id: "decision-round",
        kind: "review_round_pick",
        summary: "Recommended picks: 2 and 1",
        task_id: "task-1",
        task_title: "Task",
        meeting_id: "meeting-1",
        review_round: 1,
        options: [
          { number: 1, action: "apply_review_pick", label: "one" },
          { number: 2, action: "apply_review_pick", label: "two" },
          { number: 3, action: "skip_to_next_round", label: "skip" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2, selected_option_numbers: [2, 1] });
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

describe("runYoloDecisionAutopilot", () => {
  it("runs from the project owner pick through to the meeting start on its own", () => {
    const selected = new Set<string>();
    let started = false;

    const getDecisionInboxItems = (): DecisionInboxRouteItem[] => {
      if (started) return [];
      if (selected.size < 2) {
        const options = [
          !selected.has("task-a") ? { number: 1, action: "approve_task_review:task-a", label: "A" } : null,
          !selected.has("task-b") ? { number: 2, action: "approve_task_review:task-b", label: "B" } : null,
          { number: 3, action: "add_followup_request", label: "Follow-up" },
        ].filter(Boolean) as Array<{ number: number; action: string; label: string }>;

        return [
          createItem({
            id: "project-review-ready:1",
            kind: "project_review_ready",
            options,
          }),
        ];
      }

      return [
        createItem({
          id: "project-review-ready:1",
          kind: "project_review_ready",
          options: [
            { number: 1, action: "start_project_review", label: "Start" },
            { number: 2, action: "add_followup_request", label: "Follow-up" },
          ],
        }),
      ];
    };

    const applyDecisionReply = (decisionId: string, body: Record<string, unknown>): DecisionApplyResult => {
      expect(decisionId).toBe("project-review-ready:1");
      const option = Number(body.option_number);
      if (option === 1 && selected.size < 2) {
        selected.add("task-a");
        return { status: 200, payload: { ok: true, resolved: false } };
      }
      if (option === 2 && selected.size < 2) {
        selected.add("task-b");
        return { status: 200, payload: { ok: true, resolved: false } };
      }
      if (option === 1 && selected.size >= 2) {
        started = true;
        return { status: 200, payload: { ok: true, resolved: true } };
      }
      return { status: 400, payload: { error: "unexpected_option" } };
    };

    const applied = runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 10,
    });

    expect(applied).toBe(3);
    expect(selected.size).toBe(2);
    expect(started).toBe(true);
  });

  it("retries a temporary 409 (project_not_ready_for_review_meeting) in the same cycle", () => {
    let attempts = 0;
    let resolved = false;
    const getDecisionInboxItems = (): DecisionInboxRouteItem[] =>
      resolved
        ? []
        : [
            createItem({
              id: "project-review-ready:retry",
              kind: "project_review_ready",
              options: [{ number: 1, action: "start_project_review", label: "Start" }],
            }),
          ];

    const applyDecisionReply = (): DecisionApplyResult => {
      attempts += 1;
      if (attempts < 3) {
        return { status: 409, payload: { error: "project_not_ready_for_review_meeting" } };
      }
      resolved = true;
      return { status: 200, payload: { ok: true, resolved: true } };
    };

    const applied = runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 5,
    });

    expect(attempts).toBe(3);
    expect(applied).toBe(1);
  });

  it("leaves items with shouldSkipItem=true out of automatic decisions", () => {
    let attempts = 0;
    const getDecisionInboxItems = (): DecisionInboxRouteItem[] => [
      createItem({
        id: "video-review",
        kind: "project_review_ready",
        options: [{ number: 1, action: "start_project_review", label: "Start" }],
      }),
    ];

    const applyDecisionReply = (): DecisionApplyResult => {
      attempts += 1;
      return { status: 200, payload: { ok: true } };
    };

    const applied = runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 3,
      shouldSkipItem: () => true,
    });

    expect(applied).toBe(0);
    expect(attempts).toBe(0);
  });
});
