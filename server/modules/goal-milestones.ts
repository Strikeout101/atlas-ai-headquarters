import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger, autonomyOverview, ensureAutonomySchema } from "./autonomy-store.ts";
import { isBusinessKey } from "./businesses.ts";

/**
 * Milestones: steps under a goal. A "progress" milestone is done when the goal's measured progress (verified money,
 * counted records) reaches its target; a "manual" milestone is done only when the owner confirms it. Nothing an agent
 * or a finished task says can complete one, so a milestone means something actually happened.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export interface GoalMilestone {
  id: string;
  goal_id: string;
  title: string;
  kind: "progress" | "manual";
  target: number | null;
  status: "open" | "done";
  done_by: "verified" | "owner" | null;
  done_at: number | null;
  sort: number;
  created_at: number;
}

export function ensureMilestoneSchema(db: Db): void {
  ensureAutonomySchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS goal_milestones (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES business_goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('progress','manual')), target REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')), done_by TEXT CHECK(done_by IN ('verified','owner')),
    done_at INTEGER, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    CHECK(kind != 'progress' OR target IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal ON goal_milestones(goal_id, sort);`);
}

function fail(message: string): never {
  throw new Error(message);
}

export function listMilestones(db: Db, goalId?: string): GoalMilestone[] {
  ensureMilestoneSchema(db);
  return (goalId
    ? db.prepare("SELECT * FROM goal_milestones WHERE goal_id=? ORDER BY sort, created_at").all(goalId)
    : db
        .prepare("SELECT * FROM goal_milestones ORDER BY goal_id, sort, created_at")
        .all()) as unknown as GoalMilestone[];
}

/** Owner: add a milestone. Progress milestones need a target in the goal's own unit (e.g. USD for revenue). */
export function addMilestone(db: Db, goalId: string, input: Row, now = Date.now()): GoalMilestone {
  ensureMilestoneSchema(db);
  const goal = db.prepare("SELECT * FROM business_goals WHERE id=?").get(goalId) as Row | undefined;
  if (!goal) fail("goal_not_found");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 2 || title.length > 200) fail("invalid_title");
  const kind = input.kind === "manual" ? "manual" : input.kind === "progress" ? "progress" : fail("invalid_kind");
  let target: number | null = null;
  if (kind === "progress") {
    if (typeof input.target !== "number" || !Number.isFinite(input.target) || input.target <= 0 || input.target > 1e12)
      fail("invalid_target");
    target = input.target;
  }
  const sort = Number(
    (
      db.prepare("SELECT COALESCE(MAX(sort),0)+1 AS n FROM goal_milestones WHERE goal_id=?").get(goalId) as {
        n: number;
      }
    ).n,
  );
  const id = randomUUID();
  db.prepare(
    "INSERT INTO goal_milestones(id,goal_id,title,kind,target,status,sort,created_at) VALUES (?,?,?,?,?,'open',?,?)",
  ).run(id, goalId, title, kind, target, sort, now);
  evaluateMilestones(db, now);
  return db.prepare("SELECT * FROM goal_milestones WHERE id=?").get(id) as unknown as GoalMilestone;
}

/** Owner only: confirm a manual milestone happened (or reopen one). */
export function setMilestoneDone(db: Db, id: string, done: unknown, now = Date.now()): GoalMilestone {
  ensureMilestoneSchema(db);
  const milestone = db.prepare("SELECT * FROM goal_milestones WHERE id=?").get(id) as GoalMilestone | undefined;
  if (!milestone) fail("milestone_not_found");
  if (milestone.kind !== "manual") fail("progress_milestones_complete_from_data");
  if (typeof done !== "boolean") fail("invalid_done");
  db.prepare("UPDATE goal_milestones SET status=?, done_by=?, done_at=? WHERE id=?").run(
    done ? "done" : "open",
    done ? "owner" : null,
    done ? now : null,
    id,
  );
  return db.prepare("SELECT * FROM goal_milestones WHERE id=?").get(id) as unknown as GoalMilestone;
}

export function deleteMilestone(db: Db, id: string): void {
  ensureMilestoneSchema(db);
  if (!db.prepare("DELETE FROM goal_milestones WHERE id=?").run(id).changes) fail("milestone_not_found");
}

/**
 * Completes progress milestones whose goal's measured progress reached their target. Progress is never taken from
 * agents: it comes from verified money or counted records (autonomy-store goalProgress). Returns completed ids.
 */
export function evaluateMilestones(db: Db, now = Date.now()): string[] {
  ensureMilestoneSchema(db);
  const open = db
    .prepare("SELECT * FROM goal_milestones WHERE status='open' AND kind='progress'")
    .all() as unknown as GoalMilestone[];
  if (!open.length) return [];
  const goals = new Map((autonomyOverview(db).goals as Row[]).map((goal) => [String(goal.id), goal]));
  const done: string[] = [];
  for (const milestone of open) {
    const goal = goals.get(milestone.goal_id);
    const progress = goal?.progress;
    if (typeof progress !== "number" || milestone.target === null || progress < milestone.target) continue;
    db.prepare(
      "UPDATE goal_milestones SET status='done', done_by='verified', done_at=? WHERE id=? AND status='open'",
    ).run(now, milestone.id);
    appendAutonomyLedger(
      db,
      {
        event: "milestone_reached",
        business: isBusinessKey(goal?.business) ? goal.business : null,
        sourceId: milestone.goal_id,
        message: `Milestone reached (verified): ${milestone.title}`,
      },
      now,
    );
    done.push(milestone.id);
  }
  return done;
}
