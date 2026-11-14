import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveEscalatedContextRollover,
  claimContextRolloverResume,
  ensureContextRolloverSchema,
  getContextRollover,
  holdContextRollover,
  listPendingContextRollovers,
  markContextRolloverComplete,
  markContextRolloverManualResume,
  markContextRolloverStarted,
  recordContextRollover,
  requeueOrphanContextRollover,
  releaseStaleContextRolloverClaims,
  setContextRolloverProcessPid,
} from "./context-rollover-store.ts";

const openDbs: DatabaseSync[] = [];

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  openDbs.push(db);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, assigned_agent_id TEXT);
    INSERT INTO tasks (id, status, assigned_agent_id) VALUES ('task-1', 'in_progress', 'agent-1');
  `);
  ensureContextRolloverSchema(db);
  ensureContextRolloverSchema(db);
  return db;
}

function record(db: DatabaseSync, attemptId: string, fingerprint = "fingerprint-a") {
  return recordContextRollover(db, {
    taskId: "task-1",
    agentId: "agent-1",
    model: "qwen-local",
    attemptId,
    reason: "near_limit",
    checkpointText: "Goal: finish the task. Completed: first file. Remaining: tests.",
    progressFingerprint: fingerprint,
    now: Number(attemptId.slice(1)) * 1000,
  });
}

function startNextAttempt(db: DatabaseSync, now: number): void {
  db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
  expect(claimContextRolloverResume(db, "task-1", now)).toBe(true);
  expect(claimContextRolloverResume(db, "task-1", now)).toBe(false);
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
  expect(markContextRolloverStarted(db, "task-1", now + 1)).toBe(true);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

describe("context rollover store", () => {
  it("keeps the checkpoint, claims one resume, and ignores a duplicate completion", () => {
    const db = createDb();
    const first = record(db, "a1");
    expect(first).toEqual({ status: "pending_resume", rolloverCount: 1, stalledCount: 0, duplicate: false });
    expect(record(db, "a1")).toEqual({ ...first, duplicate: true });
    expect(getContextRollover(db, "task-1")?.checkpointText).toContain("Remaining: tests");
    expect(listPendingContextRollovers(db)).toEqual([]);

    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
    expect(listPendingContextRollovers(db)).toHaveLength(1);
    expect(claimContextRolloverResume(db, "task-1", 2000)).toBe(true);
    expect(claimContextRolloverResume(db, "task-1", 2001)).toBe(false);
    expect(getContextRollover(db, "task-1")?.status).toBe("resuming");
  });

  it("escalates after two unchanged transitions and resets the stall counter on progress", () => {
    const db = createDb();
    expect(record(db, "a1").stalledCount).toBe(0);
    startNextAttempt(db, 2000);
    expect(record(db, "a2").stalledCount).toBe(1);
    startNextAttempt(db, 3000);
    expect(record(db, "a3", "fingerprint-b").stalledCount).toBe(0);
    startNextAttempt(db, 4000);
    expect(record(db, "a4", "fingerprint-b").stalledCount).toBe(1);
    startNextAttempt(db, 5000);
    expect(record(db, "a5", "fingerprint-b")).toEqual({
      status: "escalated",
      rolloverCount: 5,
      stalledCount: 2,
      duplicate: false,
    });
    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
    expect(claimContextRolloverResume(db, "task-1", 6000)).toBe(false);
    expect(approveEscalatedContextRollover(db, "task-1", 6000)).toBe(true);
    expect(getContextRollover(db, "task-1")).toMatchObject({
      status: "pending_resume",
      rolloverCount: 5,
      stalledCount: 0,
    });
    expect(claimContextRolloverResume(db, "task-1", 6001)).toBe(true);
  });

  it("caps automatic resumes after six rollovers even when work changes", () => {
    const db = createDb();
    for (let i = 1; i <= 7; i += 1) {
      if (i > 1) startNextAttempt(db, i * 1000);
      const result = record(db, `a${i}`, `fingerprint-${i}`);
      expect(result.status).toBe(i <= 6 ? "pending_resume" : "escalated");
    }
  });

  it("recovers an orphaned claim and respects a user hold", () => {
    const db = createDb();
    record(db, "a1");
    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
    expect(claimContextRolloverResume(db, "task-1", 2000)).toBe(true);
    expect(releaseStaleContextRolloverClaims(db, 3000)).toBe(1);
    expect(listPendingContextRollovers(db)).toHaveLength(1);
    holdContextRollover(db, "task-1", 4000);
    expect(listPendingContextRollovers(db)).toEqual([]);
    expect(claimContextRolloverResume(db, "task-1", 5000)).toBe(false);
  });

  it("requeues a crashed running attempt only after its task is pending", () => {
    const db = createDb();
    record(db, "a1");
    startNextAttempt(db, 2000);
    expect(setContextRolloverProcessPid(db, "task-1", 12345, 2500)).toBe(true);
    expect(getContextRollover(db, "task-1")?.processPid).toBe(12345);
    expect(requeueOrphanContextRollover(db, "task-1", 3000)).toBe(false);
    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
    expect(requeueOrphanContextRollover(db, "task-1", 3000)).toBe(true);
    expect(getContextRollover(db, "task-1")?.processPid).toBeNull();
    expect(requeueOrphanContextRollover(db, "task-1", 3001)).toBe(false);
    expect(listPendingContextRollovers(db)).toHaveLength(1);
  });

  it("rejects stale records after cancellation and marks a completed run", () => {
    const db = createDb();
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task-1'").run();
    expect(() => record(db, "a1")).toThrow("context_rollover_task_not_active");
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
    record(db, "a1");
    startNextAttempt(db, 2000);
    markContextRolloverComplete(db, "task-1", 3000);
    expect(getContextRollover(db, "task-1")?.status).toBe("complete");
  });

  it.each(["pending_resume", "resuming", "held", "escalated"] as const)(
    "allows explicit user resume from %s while retaining the checkpoint and count",
    (status) => {
      const db = createDb();
      record(db, "a1");
      db.prepare("UPDATE task_context_rollovers SET status = ?, stalled_count = 2 WHERE task_id = 'task-1'").run(
        status,
      );
      expect(markContextRolloverManualResume(db, "task-1", 2000)).toBe(true);
      expect(getContextRollover(db, "task-1")).toMatchObject({
        status: "running",
        rolloverCount: 1,
        stalledCount: 0,
        checkpointText: "Goal: finish the task. Completed: first file. Remaining: tests.",
      });
      expect(markContextRolloverManualResume(db, "task-1", 3000)).toBe(false);
    },
  );
});
