import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger } from "./autonomy-store.ts";
import { isBusinessKey } from "./businesses.ts";
import { createOrgRequest } from "./org-requests.ts";

/**
 * Leads and seniors (work restructure, phase 5; plan section 5). Owner rules:
 *   - every department has a lead (Codex) and a senior (Claude); more are hired when both are overloaded;
 *   - leads do IMPORTANT work themselves, at most 2 at a time; ROUTINE work goes to the senior (and other staff);
 *   - with 3 or more important tasks waiting in a department, the lead hands important ones to the senior too,
 *     keeping the most important for themselves.
 * Assignment happens when a task is created and is rebalanced on every engine tick for tasks that have not started
 * yet (retries and tasks sent back by a review stay with their agent).
 */
type Db = DatabaseSync;
type Row = Record<string, any>;

export const LEAD_IMPORTANT_MAX = 2;
export const DELEGATE_AT = 3;
/** Waiting tasks in a department, with everyone in it busy, before a hire is requested. */
export const HIRE_AT = 4;
const DAY_MS = 86_400_000;
const ACTIVE = ["planned", "in_progress"];

function members(db: Db, departmentId: string, exclude: string[] = []): Row[] {
  return (
    db
      .prepare(
        "SELECT * FROM agents WHERE department_id=? AND COALESCE(role,'')<>'vp' AND COALESCE(status,'idle')<>'offline' ORDER BY created_at, id",
      )
      .all(departmentId) as Row[]
  ).filter((agent) => !exclude.includes(String(agent.id)));
}

const isLead = (agent: Row) => agent.role === "team_leader";

/** An agent's current work: tasks waiting for or being run by them. */
export function agentLoad(db: Db, agentId: string): { important: number; total: number; running: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN importance='important' THEN 1 ELSE 0 END) AS important,
              SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS running
       FROM tasks WHERE assigned_agent_id=? AND status IN (${ACTIVE.map(() => "?").join(",")})`,
    )
    .get(agentId, ...ACTIVE) as Row;
  return { important: Number(row.important ?? 0), total: Number(row.total ?? 0), running: Number(row.running ?? 0) };
}

function waitingImportant(db: Db, departmentId: string, excludeTaskId?: string): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE department_id=? AND status='planned' AND importance='important' AND id<>?",
        )
        .get(departmentId, excludeTaskId ?? "") as Row
    ).n,
  );
}

function leastLoaded(db: Db, agents: Row[]): Row | undefined {
  return [...agents].sort((a, b) => agentLoad(db, String(a.id)).total - agentLoad(db, String(b.id)).total)[0];
}

/**
 * Who should take a new task in a department. A model preference (research angles split between Codex and Claude)
 * narrows the choice first when someone on that model exists.
 */
export function chooseAssignee(
  db: Db,
  departmentId: string,
  opts: { importance: "important" | "routine"; provider?: string | null; exclude?: string[]; taskId?: string },
): Row | null {
  let pool = members(db, departmentId, opts.exclude);
  if (!pool.length) return null;
  if (opts.provider) {
    const onModel = pool.filter((agent) => agent.cli_provider === opts.provider);
    if (onModel.length) pool = onModel;
  }
  const leads = pool.filter(isLead);
  const staff = pool.filter((agent) => !isLead(agent));
  if (opts.importance === "routine") return leastLoaded(db, staff) ?? leastLoaded(db, leads) ?? null;
  const freeLead = leads.find((lead) => agentLoad(db, String(lead.id)).important < LEAD_IMPORTANT_MAX);
  const crowded = waitingImportant(db, departmentId, opts.taskId) >= DELEGATE_AT;
  if (freeLead && !crowded) return freeLead;
  return leastLoaded(db, staff) ?? freeLead ?? leastLoaded(db, leads) ?? null;
}

function note(
  db: Db,
  event: string,
  message: string,
  ref: { business?: unknown; sourceId?: string; taskId?: string },
  now: number,
) {
  try {
    appendAutonomyLedger(
      db,
      {
        event,
        business: isBusinessKey(ref.business) ? ref.business : null,
        sourceId: ref.sourceId ?? null,
        taskId: ref.taskId ?? null,
        message,
      },
      now,
    );
  } catch {
    /* ledger is optional in small test databases */
  }
}

/** Tasks that may still change hands: waiting, never started, first attempt, not sent back by a review. */
function movable(db: Db, departmentId: string): Row[] {
  const columns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name));
  const reviewFilter = columns.has("review_state") ? "AND review_state IS NULL" : "";
  return db
    .prepare(
      `SELECT * FROM tasks WHERE department_id=? AND status='planned' AND origin='autonomy' AND started_at IS NULL
         AND COALESCE(attempt,1)=1 AND playbook_step IS NOT NULL AND playbook_step NOT LIKE 'research:%'
         AND playbook_step<>'operations:idea' ${reviewFilter}
       ORDER BY COALESCE(priority,0) DESC, created_at, rowid`,
    )
    .all(departmentId) as Row[];
}

/**
 * Applies the lead/senior rules to a department's waiting tasks. The lead keeps the most important work up to their
 * limit; the rest goes to the least-loaded staff. Returns the moves made.
 */
export function rebalanceDepartment(
  db: Db,
  departmentId: string,
  now = Date.now(),
): Array<{ taskId: string; from: string | null; to: string }> {
  const leads = members(db, departmentId).filter(isLead);
  const staff = members(db, departmentId).filter((agent) => !isLead(agent));
  if (!staff.length) return [];
  const lead = leads[0];
  const tasks = movable(db, departmentId);
  const important = tasks.filter((task) => task.importance === "important");
  const routine = tasks.filter((task) => task.importance !== "important");
  const leadRunning = lead
    ? Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE assigned_agent_id=? AND status='in_progress' AND importance='important'",
            )
            .get(String(lead.id)) as Row
        ).n,
      )
    : 0;
  // The lead's slots go to the most important waiting work; with 3+ waiting, the rest is delegated.
  const leadSlots = lead ? Math.max(0, LEAD_IMPORTANT_MAX - leadRunning) : 0;
  const wanted = new Map<string, string>();
  important.forEach((task, index) => {
    if (lead && index < leadSlots) wanted.set(String(task.id), String(lead.id));
  });
  const delegated = [...important.filter((task) => !wanted.has(String(task.id))), ...routine];
  const counts = new Map(staff.map((agent) => [String(agent.id), agentLoad(db, String(agent.id)).total]));
  // Count only work that is not being moved, so it spreads evenly.
  for (const task of delegated) {
    const current = String(task.assigned_agent_id ?? "");
    if (counts.has(current)) counts.set(current, (counts.get(current) ?? 1) - 1);
  }
  for (const task of delegated) {
    const target = [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
    wanted.set(String(task.id), target);
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const moves: Array<{ taskId: string; from: string | null; to: string }> = [];
  for (const task of tasks) {
    const to = wanted.get(String(task.id));
    if (!to || to === task.assigned_agent_id) continue;
    db.prepare(
      "UPDATE tasks SET assigned_agent_id=?, updated_at=? WHERE id=? AND status='planned' AND started_at IS NULL",
    ).run(to, now, String(task.id));
    moves.push({ taskId: String(task.id), from: (task.assigned_agent_id as string | null) ?? null, to });
    const name = (id: string | null) =>
      id ? String((db.prepare("SELECT name FROM agents WHERE id=?").get(id) as Row | undefined)?.name ?? id) : "nobody";
    const why =
      task.importance === "important"
        ? important.length >= DELEGATE_AT
          ? `${important.length} important tasks are waiting`
          : "the lead is at their limit"
        : "routine work goes to the senior";
    note(
      db,
      "reassigned",
      `${name(task.assigned_agent_id)} → ${name(to)}: "${String(task.title).slice(0, 80)}" (${why})`,
      { business: task.business, sourceId: task.initiative_id ?? task.goal_id ?? undefined, taskId: String(task.id) },
      now,
    );
  }
  return moves;
}

/**
 * When a department's queue keeps growing with everyone in it busy, its lead asks for a hire (the usual org request,
 * reviewed by both VPs). At most one open request per department, and not more than one a day.
 */
export function maybeRequestHire(db: Db, departmentId: string, now = Date.now()): string | null {
  const team = members(db, departmentId);
  const lead = team.find(isLead);
  if (!lead || !team.length) return null;
  const waiting = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE department_id=? AND status='planned'").get(departmentId) as Row)
      .n,
  );
  if (waiting < HIRE_AT) return null;
  if (!team.every((agent) => agentLoad(db, String(agent.id)).running > 0)) return null;
  try {
    const recent = db
      .prepare(
        "SELECT 1 FROM org_requests WHERE kind='hire_agent' AND json_extract(payload,'$.department_id')=? AND (status='pending' OR created_at>?) LIMIT 1",
      )
      .get(departmentId, now - DAY_MS);
    if (recent) return null;
  } catch {
    /* no org_requests table yet: createOrgRequest makes it */
  }
  const department = db.prepare("SELECT name FROM departments WHERE id=?").get(departmentId) as Row | undefined;
  const deptName = String(department?.name ?? departmentId);
  const codex = team.filter((agent) => agent.cli_provider === "codex").length;
  const claude = team.filter((agent) => agent.cli_provider === "claude").length;
  try {
    const request = createOrgRequest(db, "hire_agent", String(lead.id), {
      name: `${deptName} hire ${team.length + 1}`,
      department_id: departmentId,
      role: "senior",
      // Keep both models on the team: hire the one it has fewer of (Claude when tied, like the seniors).
      cli_provider: codex < claude ? "codex" : "claude",
      reason: `${waiting} tasks are waiting in ${deptName} and all ${team.length} of us are busy.`,
    });
    note(
      db,
      "hire_requested",
      `${String(lead.name)} asked for a hire in ${deptName} (${waiting} tasks waiting, everyone busy)`,
      {},
      now,
    );
    return String(request.id);
  } catch {
    return null;
  }
}

/** Every department with waiting autonomous work: rebalance, then check whether it needs a hire. */
export function runStaffing(db: Db, now = Date.now()): void {
  const departments = (
    db
      .prepare("SELECT DISTINCT department_id FROM tasks WHERE status='planned' AND department_id IS NOT NULL")
      .all() as Row[]
  ).map((row) => String(row.department_id));
  for (const department of departments) {
    rebalanceDepartment(db, department, now);
    maybeRequestHire(db, department, now);
  }
}
