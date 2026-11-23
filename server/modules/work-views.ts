import type { DatabaseSync } from "node:sqlite";
import { getPlaybook } from "./playbooks.ts";
import { getHandoff } from "./work-model.ts";

/**
 * Read models for the work screens (work restructure, phase 7; plan section 9):
 *   - the Work board, grouped goal → initiative, plus Operations, in five columns;
 *   - an initiative's page: its playbook steps as a timeline with each step's task, hand-off and reviews;
 *   - "Behind the scenes": one card per agent with what they are doing, their queue, recent hand-offs, the reviews
 *     they are doing, their model and any model fixes the VPs made.
 * Read only. Built from the task rows the work engine writes (no separate state).
 */
type Db = DatabaseSync;
type Row = Record<string, any>;

export const BOARD_COLUMNS = ["waiting", "working", "in_review", "needs_you", "done"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
const DAY_MS = 86_400_000;
const DONE_WINDOW_MS = 7 * DAY_MS;

function hasColumn(db: Db, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  } catch {
    return false;
  }
}
function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** Which column a task belongs in. "Needs you" holds only owner decisions. */
export function boardColumn(task: Row, ownerBlocked = false): BoardColumn | null {
  if (task.status === "cancelled") return null;
  if (task.review_state === "owner" || ownerBlocked) return "needs_you";
  if (task.status === "done") return "done";
  if (task.status === "review") return "in_review";
  if (task.status === "in_progress" || task.status === "collaborating") return "working";
  return "waiting";
}

export interface BoardCard {
  id: string;
  title: string;
  column: BoardColumn;
  status: string;
  work_type: string | null;
  importance: string | null;
  playbook_step: string | null;
  attempt: number;
  review_state: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_provider: string | null;
  updated_at: number;
}

function card(task: Row, column: BoardColumn, agents: Map<string, Row>): BoardCard {
  const agent = task.assigned_agent_id ? agents.get(String(task.assigned_agent_id)) : undefined;
  return {
    id: String(task.id),
    title: String(task.title ?? ""),
    column,
    status: String(task.status),
    work_type: (task.work_type as string | null) ?? null,
    importance: (task.importance as string | null) ?? null,
    playbook_step: (task.playbook_step as string | null) ?? null,
    attempt: Number(task.attempt ?? 1),
    review_state: (task.review_state as string | null) ?? null,
    agent_id: (task.assigned_agent_id as string | null) ?? null,
    agent_name: agent ? String(agent.name) : null,
    agent_provider: agent ? ((agent.cli_provider as string | null) ?? null) : null,
    updated_at: Number(task.updated_at ?? task.created_at ?? 0),
  };
}

function agentMap(db: Db): Map<string, Row> {
  return new Map(
    (db.prepare("SELECT id, name, cli_provider, role, department_id FROM agents").all() as Row[]).map((a) => [
      String(a.id),
      a,
    ]),
  );
}

/** Tasks worth showing: everything open, plus what finished in the last week. */
function boardTasks(db: Db, now: number): Row[] {
  const cols = [
    "goal_id",
    "initiative_id",
    "business",
    "work_type",
    "importance",
    "playbook_step",
    "attempt",
    "review_state",
  ];
  const select = cols.map((c) => (hasColumn(db, "tasks", c) ? c : `NULL AS ${c}`)).join(", ");
  const visible = hasColumn(db, "tasks", "hidden") ? "COALESCE(hidden,0)=0 AND" : "";
  return db
    .prepare(
      `SELECT id, title, status, assigned_agent_id, department_id, created_at, updated_at, completed_at, ${select}
       FROM tasks WHERE ${visible} status<>'cancelled' AND (status<>'done' OR COALESCE(completed_at, updated_at)>?)
       ORDER BY updated_at DESC LIMIT 600`,
    )
    .all(now - DONE_WINDOW_MS) as Row[];
}

export interface BoardGroup {
  kind: "initiative" | "goal" | "operations";
  id: string;
  title: string;
  status: string | null;
  playbook_stage: string | null;
  blocked_reason: string | null;
  business: string | null;
  cards: BoardCard[];
}

/** The Work board: goals with their initiatives (and goal-level research), then Operations, each split into columns. */
export function workBoard(db: Db, now = Date.now()) {
  const agents = agentMap(db);
  const tasks = boardTasks(db, now);
  const goals = hasTable(db, "business_goals")
    ? (db.prepare("SELECT * FROM business_goals ORDER BY period_end DESC, created_at DESC").all() as Row[])
    : [];
  const initiatives = hasTable(db, "initiatives")
    ? (db.prepare("SELECT * FROM initiatives ORDER BY updated_at DESC").all() as Row[])
    : [];
  const ownerBlocked = new Set(
    initiatives.filter((i) => i.status === "blocked" && i.escalation === "owner").map((i) => String(i.id)),
  );
  const byInitiative = new Map<string, BoardCard[]>();
  const byGoal = new Map<string, BoardCard[]>();
  const operations: BoardCard[] = [];
  for (const task of tasks) {
    const initiativeId = task.initiative_id ? String(task.initiative_id) : null;
    const column = boardColumn(task, Boolean(initiativeId && ownerBlocked.has(initiativeId) && task.status !== "done"));
    if (!column) continue;
    const c = card(task, column, agents);
    if (initiativeId) byInitiative.set(initiativeId, [...(byInitiative.get(initiativeId) ?? []), c]);
    else if (task.goal_id) byGoal.set(String(task.goal_id), [...(byGoal.get(String(task.goal_id)) ?? []), c]);
    else operations.push(c);
  }
  const goalGroups = goals.map((goal) => {
    const goalInitiatives = initiatives.filter(
      (i) =>
        String(i.goal_id) === String(goal.id) &&
        (byInitiative.has(String(i.id)) ||
          ["approved", "in_progress", "blocked", "launched", "measuring"].includes(String(i.status))),
    );
    const groups: BoardGroup[] = [];
    const research = byGoal.get(String(goal.id)) ?? [];
    if (research.length)
      groups.push({
        kind: "goal",
        id: String(goal.id),
        title: "Research and strategy",
        status: null,
        playbook_stage: null,
        blocked_reason: null,
        business: String(goal.business),
        cards: research,
      });
    for (const initiative of goalInitiatives)
      groups.push({
        kind: "initiative",
        id: String(initiative.id),
        title: String(initiative.title),
        status: String(initiative.status),
        playbook_stage: (initiative.playbook_stage as string | null) ?? null,
        blocked_reason: (initiative.blocked_reason as string | null) ?? null,
        business: String(initiative.business),
        cards: byInitiative.get(String(initiative.id)) ?? [],
      });
    return {
      id: String(goal.id),
      title: String(goal.title || goal.metric),
      business: String(goal.business),
      metric: String(goal.metric),
      target: Number(goal.target),
      period_end: Number(goal.period_end),
      live: Number(goal.period_start) <= now && Number(goal.period_end) > now,
      groups,
    };
  });
  const counts = Object.fromEntries(BOARD_COLUMNS.map((column) => [column, 0])) as Record<BoardColumn, number>;
  for (const list of [...byInitiative.values(), ...byGoal.values(), operations])
    for (const c of list) counts[c.column] += 1;
  return {
    columns: BOARD_COLUMNS,
    counts,
    goals: goalGroups.filter((goal) => goal.live || goal.groups.some((g) => g.cards.length)),
    operations: { kind: "operations" as const, id: "operations", title: "Operations", cards: operations },
  };
}

function reviewsFor(db: Db, taskId: string) {
  if (!hasTable(db, "task_reviews")) return [];
  return (db.prepare("SELECT * FROM task_reviews WHERE task_id=? ORDER BY created_at, rowid").all(taskId) as Row[]).map(
    (r) => ({
      round: Number(r.round),
      status: String(r.status),
      reviewer_agent_id: (r.reviewer_agent_id as string | null) ?? null,
      reviewer_provider: (r.reviewer_provider as string | null) ?? null,
      same_model: Boolean(r.same_model),
      summary: String(r.summary ?? ""),
      items: JSON.parse(String(r.items_json || "[]")) as string[],
      created_at: Number(r.created_at),
    }),
  );
}

/** An initiative's page: goal, brief, and its playbook steps as a timeline (task, hand-off, reviews per step). */
export function initiativeDetail(db: Db, initiativeId: string) {
  const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined;
  if (!initiative) return null;
  const goal = db.prepare("SELECT * FROM business_goals WHERE id=?").get(String(initiative.goal_id)) as Row | undefined;
  const playbook = initiative.playbook ? getPlaybook(db, String(initiative.playbook)) : null;
  const agents = agentMap(db);
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE initiative_id=? ORDER BY created_at, rowid")
    .all(initiativeId) as Row[];
  const stage = String(initiative.playbook_stage ?? "");
  const stepState = (key: string, index: number, task: Row | undefined): string => {
    if (stage === `awaiting_${key}`) return "waiting_owner";
    if (task) return task.status === "done" ? "done" : task.status === "cancelled" ? "skipped" : "current";
    const currentIndex = playbook?.steps.findIndex((s) => s.key === stage || `awaiting_${s.key}` === stage) ?? -1;
    if (stage === "steps_done" || (currentIndex >= 0 && index < currentIndex)) return "done";
    return "upcoming";
  };
  const steps = (playbook?.steps ?? []).map((step, index) => {
    const task = [...tasks].reverse().find((t) => t.playbook_step === step.key);
    const handoff = task ? getHandoff(db, String(task.id)) : null;
    return {
      key: step.key,
      title: step.title.replace(/\{title\}/g, String(initiative.title)),
      kind: step.kind ?? "task",
      work_type: step.work_type ?? null,
      department_id: step.department_id,
      state: stepState(step.key, index, task),
      task: task ? card(task, boardColumn(task) ?? "done", agents) : null,
      handoff,
      reviews: task ? reviewsFor(db, String(task.id)) : [],
    };
  });
  const extra = tasks
    .filter((t) => !playbook?.steps.some((s) => s.key === t.playbook_step))
    .map((t) => card(t, boardColumn(t) ?? "done", agents));
  return {
    initiative: {
      id: String(initiative.id),
      title: String(initiative.title),
      description: String(initiative.description ?? ""),
      status: String(initiative.status),
      playbook: playbook ? playbook.title : null,
      playbook_stage: (initiative.playbook_stage as string | null) ?? null,
      blocked_reason: (initiative.blocked_reason as string | null) ?? null,
      escalation: (initiative.escalation as string | null) ?? null,
      budget: Number(initiative.budget ?? 0),
      task_cap_daily: Number(initiative.task_cap_daily ?? 0),
      business: String(initiative.business),
    },
    goal: goal
      ? { id: String(goal.id), title: String(goal.title || goal.metric), business: String(goal.business) }
      : null,
    steps,
    other_tasks: extra,
  };
}

/** One card per agent: what they're doing now, their queue, recent hand-offs, reviews, model and VP fixes. */
export function behindTheScenes(db: Db, now = Date.now()) {
  const agents = db
    .prepare(
      "SELECT a.*, d.name AS department_name FROM agents a LEFT JOIN departments d ON d.id=a.department_id ORDER BY COALESCE(d.sort_order, 99), CASE a.role WHEN 'vp' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END, a.created_at, a.id",
    )
    .all() as Row[];
  const map = agentMap(db);
  const taskCols = ["work_type", "importance", "playbook_step", "attempt", "review_state"]
    .map((c) => (hasColumn(db, "tasks", c) ? c : `NULL AS ${c}`))
    .join(", ");
  const fixes = hasTable(db, "autonomy_ledger")
    ? (db
        .prepare(
          "SELECT message, created_at FROM autonomy_ledger WHERE event='vp_model_fix' AND created_at>? ORDER BY id DESC LIMIT 200",
        )
        .all(now - 14 * DAY_MS) as Row[])
    : [];
  return agents.map((agent) => {
    const id = String(agent.id);
    const current = agent.current_task_id
      ? (db
          .prepare(
            `SELECT id, title, status, assigned_agent_id, updated_at, created_at, ${taskCols} FROM tasks WHERE id=?`,
          )
          .get(String(agent.current_task_id)) as Row | undefined)
      : undefined;
    const queue = db
      .prepare(
        `SELECT id, title, status, assigned_agent_id, updated_at, created_at, ${taskCols} FROM tasks
         WHERE assigned_agent_id=? AND status IN ('planned','inbox','pending') ORDER BY CASE importance WHEN 'important' THEN 0 ELSE 1 END, created_at LIMIT 8`,
      )
      .all(id) as Row[];
    const recent = db
      .prepare(
        "SELECT id, title FROM tasks WHERE assigned_agent_id=? AND status IN ('done','review') ORDER BY updated_at DESC LIMIT 3",
      )
      .all(id) as Row[];
    const reviewing = hasTable(db, "task_reviews")
      ? (db
          .prepare(
            "SELECT r.task_id, r.round, t.title FROM task_reviews r JOIN tasks t ON t.id=r.task_id WHERE r.reviewer_agent_id=? AND r.status='running' ORDER BY r.created_at DESC LIMIT 3",
          )
          .all(id) as Row[])
      : [];
    const name = String(agent.name ?? "");
    return {
      id,
      name,
      role: String(agent.role ?? ""),
      department_id: (agent.department_id as string | null) ?? null,
      department_name: (agent.department_name as string | null) ?? null,
      status: String(agent.status ?? "idle"),
      provider: (agent.cli_provider as string | null) || null,
      model: (agent.cli_model as string | null) || null,
      current: current ? card(current, boardColumn(current) ?? "working", map) : null,
      queue: queue.map((t) => card(t, boardColumn(t) ?? "waiting", map)),
      recent_handoffs: recent
        .map((t) => ({ task_id: String(t.id), title: String(t.title), handoff: getHandoff(db, String(t.id)) }))
        .filter((r) => r.handoff),
      reviewing: reviewing.map((r) => ({ task_id: String(r.task_id), title: String(r.title), round: Number(r.round) })),
      model_fixes: fixes
        .filter((f) => name && String(f.message).includes(name))
        .slice(0, 3)
        .map((f) => ({ message: String(f.message), at: Number(f.created_at) })),
    };
  });
}
