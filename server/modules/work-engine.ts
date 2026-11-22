import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAutonomyAllowed, ensureControlStateSchema } from "./control-state.ts";
import { appendAutonomyLedger, autonomyConfig, autonomyOverview } from "./autonomy-store.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { isPasswordConfigured } from "../security/login-sessions.ts";
import {
  autonomyDay,
  autonomyTaskUsageBlockReason,
  ensureAutonomyEngineSchema,
  isResearchPhaseTask,
  nextScheduleRun,
} from "./autonomy-engine.ts";
import { evaluateInitiatives, initiativeBudgetBlock } from "./experiments.ts";
import { evaluateMilestones } from "./goal-milestones.ts";
import { fillStepText, getPlaybook, playbookForBusiness, type Playbook, type PlaybookStep } from "./playbooks.ts";
import {
  approvedStrategy,
  ensureGoalStrategySchema,
  goalLine,
  goalNeedsStrategy,
  RESEARCH_ANGLES,
  RESEARCH_MIN_ANGLES,
  RESEARCH_STEP_PREFIX,
  researchAngleDescription,
  researchTasks,
  STRATEGY_STEP,
  synthesisDescription,
} from "./goal-strategy.ts";
import { ensureWorkModelSchema, type TaskImportance, type WorkType } from "./bootstrap/schema/work-model-migration.ts";
import { formatHandoff, getHandoff } from "./work-model.ts";

/**
 * The work engine (work restructure, phase 3; plan section 12b). One step runner for all autonomous work:
 *
 *   goal → research phase (parallel angles, then a synthesis) → owner approves the strategy
 *        → owner approves initiatives (VPs set each plan once) → playbook steps run on their own
 *        → an owner-approval step (Etsy: publish) stops the initiative for the owner.
 *
 * Steps are ordinary task rows (origin 'autonomy') that carry their goal, initiative, playbook step and attempt.
 * Each step's brief holds the strategy, the initiative brief and every earlier step's hand-off. A failed step is
 * retried (same agent, then another agent on the other model), then escalated to the VPs, then to the owner. It
 * never silently ends. Caps: the daily start cap (research doesn't count), each initiative's daily cap and stop rules.
 */
type Db = DatabaseSync;
type Row = Record<string, any>;

export const MAX_STEP_ATTEMPTS = 3;
export const SHOP_SETUP_STEP = "shop_setup";
export const SCHEDULE_STEP_PREFIX = "schedule:";
/** Tasks the engine starts per tick, each on a different agent. */
export const STARTS_PER_TICK = 3;
/** Waiting tasks in one department before its leader is told to consider a hire. */
export const WORKLOAD_HINT_AT = 3;
const DAY_MS = 86_400_000;
const running = new WeakSet<Db>();

export function ensureWorkEngineSchema(db: Db): void {
  ensureAutonomyEngineSchema(db);
  ensureGoalStrategySchema(db);
  ensureControlStateSchema(db);
  ensureWorkModelSchema(db);
}

function fail(message: string): never {
  throw new Error(message);
}

function business(value: unknown): BusinessKey | null {
  return isBusinessKey(value) ? value : null;
}

/** Ledger entry; a repeated wait or block for the same thing is written once, not every tick. */
function note(
  db: Db,
  event: string,
  message: string,
  now: number,
  ref: { id?: string; business?: unknown; taskId?: string } = {},
) {
  const key = `log:${event}:${ref.id ?? "engine"}`;
  const last = db.prepare("SELECT value FROM autonomy_engine_state WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  if (last?.value === message && ["waiting", "blocked", "skipped"].includes(event)) return;
  appendAutonomyLedger(
    db,
    { event, business: business(ref.business), sourceId: ref.id ?? null, taskId: ref.taskId ?? null, message },
    now,
  );
  db.prepare(
    "INSERT INTO autonomy_engine_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, message);
}

// ── Who does a step ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Picks the agent for a step from its department. Important work goes to the lead, routine work to the senior
 * (phase 5 adds load-aware rules). A provider preference wins over the role, so research angles use both models.
 */
export function pickStepAgent(
  db: Db,
  departmentId: string,
  opts: { importance: TaskImportance; provider?: string | null; exclude?: string[] },
): Row | null {
  const members = (
    db
      .prepare(
        "SELECT * FROM agents WHERE department_id=? AND COALESCE(role,'')<>'vp' AND COALESCE(status,'idle')<>'offline' ORDER BY created_at, id",
      )
      .all(departmentId) as Row[]
  ).filter((agent) => !opts.exclude?.includes(String(agent.id)));
  if (!members.length) return null;
  const isLead = (agent: Row) => agent.role === "team_leader";
  const roleRank = (agent: Row) => (opts.importance === "important" ? (isLead(agent) ? 0 : 1) : isLead(agent) ? 1 : 0);
  const providerRank = (agent: Row) => (opts.provider && agent.cli_provider !== opts.provider ? 1 : 0);
  return [...members].sort((a, b) => providerRank(a) - providerRank(b) || roleRank(a) - roleRank(b))[0];
}

/** The department a research phase runs in: the playbook's research department, else Planning, else any staffed one. */
function researchDepartment(db: Db, goal: Row): string | null {
  const staffed = (
    db
      .prepare("SELECT DISTINCT department_id FROM agents WHERE department_id IS NOT NULL AND COALESCE(role,'')<>'vp'")
      .all() as Array<{ department_id: string }>
  ).map((row) => row.department_id);
  const preferred = playbookForBusiness(db, goal.business)?.research.department_id;
  for (const department of [preferred, "planning"]) if (department && staffed.includes(department)) return department;
  return staffed[0] ?? null;
}

// ── Creating step tasks ─────────────────────────────────────────────────────────────────────────────────────────

export interface WorkTaskInput {
  title: string;
  description: string;
  department_id: string;
  agent_id: string;
  business: string;
  goal_id?: string | null;
  initiative_id?: string | null;
  project_id?: string | null;
  work_type: WorkType;
  importance: TaskImportance;
  playbook_step: string;
}

/** Creates one autonomous step task, ready to start (status `planned`). The owner's approvals already cover it. */
export function createWorkTask(db: Db, input: WorkTaskInput, now = Date.now()): string {
  ensureWorkEngineSchema(db);
  if (!business(input.business)) fail("work_invalid_business");
  if (!input.title.trim() || !input.description.trim()) fail("work_invalid_task");
  const project = input.project_id
    ? (db.prepare("SELECT id, project_path FROM projects WHERE id=?").get(input.project_id) as Row | undefined)
    : undefined;
  const waiting = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE department_id=? AND origin='autonomy' AND status='planned'")
        .get(input.department_id) as Row
    ).n,
  );
  const description = [
    input.description.trim(),
    `Business: ${input.business}. Anything public, paid or customer-facing goes through its approval; budget figures are estimates and never permission to spend.`,
    waiting >= WORKLOAD_HINT_AT
      ? `Workload: ${waiting} other tasks are waiting for this department. If work keeps queuing, the lead can ask for a hire with org.request_hire (name, role, reason with these numbers); both VPs review it.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id,title,description,department_id,assigned_agent_id,project_id,project_path,status,priority,origin,
       business,goal_id,initiative_id,work_type,importance,playbook_step,attempt,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'planned',?,'autonomy',?,?,?,?,?,?,1,?,?)`,
  ).run(
    id,
    input.title.trim().slice(0, 200),
    description.slice(0, 20000),
    input.department_id,
    input.agent_id,
    project ? String(project.id) : null,
    project ? (project.project_path as string | null) : null,
    input.importance === "important" ? 2 : 1,
    input.business,
    input.goal_id ?? null,
    input.initiative_id ?? null,
    input.work_type,
    input.importance,
    input.playbook_step,
    now,
    now,
  );
  return id;
}

// ── Research phase ──────────────────────────────────────────────────────────────────────────────────────────────

function goalName(goal: Row): string {
  return String(goal.title || `${String(goal.business)} goal`).slice(0, 80);
}

/** Starts a goal's research phase: one task per angle, alternating Codex and Claude. Returns the task ids. */
export function startResearchPhase(db: Db, goal: Row, reason: string, now = Date.now()): string[] {
  const department = researchDepartment(db, goal) ?? fail("no_research_department");
  const providers = ["codex", "claude"];
  const ids = RESEARCH_ANGLES.map((angle, index) => {
    const agent =
      pickStepAgent(db, department, { importance: "routine", provider: providers[index % 2] }) ??
      fail("no_research_agent");
    return createWorkTask(
      db,
      {
        title: `Research (${angle.title}): ${goalName(goal)}`,
        description: researchAngleDescription(db, goal, angle, reason, now),
        department_id: department,
        agent_id: String(agent.id),
        business: String(goal.business),
        goal_id: String(goal.id),
        project_id: goal.project_id ?? null,
        work_type: "research",
        importance: "routine",
        playbook_step: `${RESEARCH_STEP_PREFIX}${angle.key}`,
      },
      now,
    );
  });
  note(db, "research_started", `Research started for "${goalName(goal)}" on ${ids.length} angles (${reason})`, now, {
    id: String(goal.id),
    business: goal.business,
  });
  return ids;
}

/** When every angle of the current phase is finished, the synthesis task merges them. Returns its id, or null. */
export function maybeStartSynthesis(db: Db, goal: Row, now = Date.now()): string | null {
  const tasks = researchTasks(db, String(goal.id));
  const lastSynthesis = tasks.find((task) => task.playbook_step === STRATEGY_STEP);
  const phase = tasks.filter(
    (task) =>
      String(task.playbook_step).startsWith(RESEARCH_STEP_PREFIX) &&
      (!lastSynthesis || Number(task.created_at) > Number(lastSynthesis.created_at)),
  );
  if (!phase.length || phase.some((task) => !["done", "cancelled"].includes(String(task.status)))) return null;
  const done = phase.filter((task) => task.status === "done");
  if (done.length < RESEARCH_MIN_ANGLES) {
    note(
      db,
      "blocked",
      `Research for "${goalName(goal)}" ended with only ${done.length} of ${phase.length} angles; it runs again tomorrow`,
      now,
      { id: String(goal.id), business: goal.business },
    );
    return null;
  }
  const handoffs = done
    .slice()
    .reverse()
    .map((task) => {
      const handoff = getHandoff(db, String(task.id));
      const heading = `[${String(task.title)}]`;
      return handoff ? formatHandoff(handoff, heading) : `${heading}\n(no hand-off saved; read its notes file)`;
    });
  const department = String(done[0].department_id ?? researchDepartment(db, goal));
  const agent = pickStepAgent(db, department, { importance: "important" }) ?? fail("no_research_agent");
  const reason = String(phase[0].description ?? "").match(/Why now: (.+?)\./)?.[1] ?? "the research phase finished";
  const id = createWorkTask(
    db,
    {
      title: `Strategy: how to reach "${goalName(goal)}"`,
      description: synthesisDescription(db, goal, handoffs, reason, now),
      department_id: department,
      agent_id: String(agent.id),
      business: String(goal.business),
      goal_id: String(goal.id),
      project_id: goal.project_id ?? null,
      work_type: "research",
      importance: "important",
      playbook_step: STRATEGY_STEP,
    },
    now,
  );
  note(
    db,
    "research_synthesis",
    `Research angles done (${done.length}); synthesis started for "${goalName(goal)}"`,
    now,
    {
      id: String(goal.id),
      business: goal.business,
    },
  );
  return id;
}

// ── Initiatives ─────────────────────────────────────────────────────────────────────────────────────────────────

const ACTIVE_BUILD = ["approved", "in_progress", "blocked"];

/**
 * The owner picks an initiative to build. The VPs' plan check runs once here: a playbook whose departments are
 * staffed, the playbook's caps and the budget. No task is voted on after this.
 */
export function approveInitiative(db: Db, initiativeId: string, approvedBy = "owner", now = Date.now()): Row {
  ensureWorkEngineSchema(db);
  const initiative =
    (db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined) ??
    fail("initiative_not_found");
  if (initiative.status !== "proposed") fail("initiative_not_proposed");
  const goal =
    (db.prepare("SELECT * FROM business_goals WHERE id=?").get(String(initiative.goal_id)) as Row | undefined) ??
    fail("goal_not_found");
  const strategy = approvedStrategy(db, String(goal.id)) ?? fail("strategy_not_approved");
  const active = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM initiatives WHERE goal_id=? AND status IN (${ACTIVE_BUILD.map(() => "?").join(",")})`,
        )
        .get(String(goal.id), ...ACTIVE_BUILD) as Row
    ).n,
  );
  if (active >= Number(goal.initiative_slots ?? 3)) fail("goal_slots_full");
  const playbook =
    (initiative.playbook ? getPlaybook(db, String(initiative.playbook)) : null) ??
    playbookForBusiness(db, initiative.business) ??
    fail("initiative_needs_playbook");
  for (const step of playbook.steps)
    if (step.kind !== "owner_approval" && !pickStepAgent(db, step.department_id, { importance: "routine" }))
      fail(`playbook_department_unstaffed: ${step.department_id}`);
  db.prepare(
    `UPDATE initiatives SET status='approved', playbook=?, playbook_stage=NULL, step_attempts=0, blocked_reason=NULL,
       escalation=NULL, task_cap_daily=?, strategy_id=?, approved_at=?, approved_by=?,
       window_started_at=COALESCE(window_started_at, ?), updated_at=? WHERE id=?`,
  ).run(playbook.key, playbook.caps.task_cap_daily, String(strategy.id), now, approvedBy, now, now, initiativeId);
  const steps = playbook.steps.map((step) => step.key).join(" → ");
  note(
    db,
    "initiative_approved",
    `Approved "${String(initiative.title).slice(0, 100)}". VPs set the plan: ${playbook.title} (${steps}), up to ${playbook.caps.task_cap_daily} tasks a day, budget $${Number(initiative.budget ?? 0).toFixed(0)}.`,
    now,
    { id: initiativeId, business: initiative.business },
  );
  return db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row;
}

function stepTask(db: Db, initiativeId: string, stepKey: string): Row | undefined {
  return db
    .prepare(
      "SELECT * FROM tasks WHERE initiative_id=? AND playbook_step=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(initiativeId, stepKey) as Row | undefined;
}

/** Every finished step of an initiative, as hand-offs for the next step and the reviewer. */
export function earlierHandoffs(db: Db, initiativeId: string): string[] {
  const done = db
    .prepare(
      "SELECT id, title, playbook_step FROM tasks WHERE initiative_id=? AND status='done' AND playbook_step IS NOT NULL ORDER BY COALESCE(completed_at, updated_at), rowid",
    )
    .all(initiativeId) as Row[];
  return done.map((task) => {
    const handoff = getHandoff(db, String(task.id));
    const heading = `[Earlier step: ${String(task.playbook_step)} - ${String(task.title)}]`;
    return handoff ? formatHandoff(handoff, heading) : `${heading}\n(no hand-off saved)`;
  });
}

function stepDescription(db: Db, goal: Row, initiative: Row, step: PlaybookStep, strategy: Row | null, now: number) {
  const handoffs = earlierHandoffs(db, String(initiative.id));
  return [
    fillStepText(step.instructions, initiative),
    goalLine(db, goal, now),
    `INITIATIVE BRIEF: ${String(initiative.title)}\n${String(initiative.description ?? "").slice(0, 3000)}`,
    strategy
      ? `STRATEGY (owner-approved v${Number(strategy.version ?? 1)}):\n${String(strategy.summary).slice(0, 2500)}`
      : "",
    handoffs.length ? `EARLIER STEPS (their files are in your working folder):\n${handoffs.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function setStage(db: Db, initiativeId: string, stage: string | null, now: number, extra = ""): void {
  db.prepare(
    `UPDATE initiatives SET playbook_stage=?, step_attempts=0, status=CASE WHEN status='approved' THEN 'in_progress' ELSE status END,
       updated_at=?${extra} WHERE id=?`,
  ).run(stage, now, initiativeId);
}

function openShopSetup(db: Db, businessKey: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM tasks WHERE business=? AND playbook_step=? AND status NOT IN ('done','cancelled') LIMIT 1",
      )
      .get(businessKey, SHOP_SETUP_STEP),
  );
}

/** Moves one initiative forward: starts its current step, or moves to the next one when the step is done. */
export function advanceInitiative(db: Db, initiativeId: string, now = Date.now()): string | null {
  for (let guard = 0; guard < 20; guard++) {
    const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined;
    if (!initiative || !["approved", "in_progress"].includes(String(initiative.status)) || initiative.escalation)
      return null;
    const playbook = initiative.playbook ? getPlaybook(db, String(initiative.playbook)) : null;
    const ref = { id: initiativeId, business: initiative.business };
    if (!playbook) {
      block(db, initiative, "its playbook no longer exists", "owner", now);
      return null;
    }
    const stage = initiative.playbook_stage ? String(initiative.playbook_stage) : null;
    if (stage?.startsWith("awaiting_")) return null; // waiting for the owner
    const index = stage ? playbook.steps.findIndex((step) => step.key === stage) : 0;
    if (index < 0) {
      block(db, initiative, `its current step "${stage}" is not in the playbook any more`, "owner", now);
      return null;
    }
    const step = playbook.steps[index];
    if (!step) {
      setStage(db, initiativeId, "steps_done", now);
      return null;
    }
    if (step.kind === "owner_approval") {
      setStage(db, initiativeId, `awaiting_${step.key}`, now);
      note(
        db,
        "awaiting_owner",
        `"${String(initiative.title).slice(0, 100)}" is ready: ${fillStepText(step.title, initiative)}`,
        now,
        ref,
      );
      return null;
    }
    const task = stepTask(db, initiativeId, step.key);
    if (!task) {
      if (step.wait_for === "shop_setup" && openShopSetup(db, String(initiative.business))) {
        note(db, "waiting", `Step ${step.key} waits for the shop setup to finish`, now, ref);
        return null;
      }
      const budget = initiativeBudgetBlock(db, initiativeId);
      if (budget) {
        note(db, "waiting", `Step ${step.key} not started: ${budget}`, now, ref);
        return null;
      }
      const agent = pickStepAgent(db, step.department_id, { importance: step.importance ?? "routine" });
      if (!agent) {
        block(db, initiative, `nobody in ${step.department_id} can do the ${step.key} step`, "vp", now);
        return null;
      }
      const goal = db.prepare("SELECT * FROM business_goals WHERE id=?").get(String(initiative.goal_id)) as Row;
      const strategy = approvedStrategy(db, String(initiative.goal_id));
      const id = createWorkTask(
        db,
        {
          title: fillStepText(step.title, initiative),
          description: stepDescription(db, goal, initiative, step, strategy, now),
          department_id: step.department_id,
          agent_id: String(agent.id),
          business: String(initiative.business),
          goal_id: String(initiative.goal_id),
          initiative_id: initiativeId,
          project_id: initiative.project_id ?? goal?.project_id ?? null,
          work_type: step.work_type ?? "product",
          importance: step.importance ?? "routine",
          playbook_step: step.key,
        },
        now,
      );
      setStage(db, initiativeId, step.key, now);
      note(
        db,
        "step_queued",
        `Step ${index + 1}/${playbook.steps.length} (${step.key}) queued for ${String(agent.name ?? agent.id)}`,
        now,
        {
          ...ref,
          taskId: id,
        },
      );
      return id;
    }
    if (task.status === "done") {
      const next = playbook.steps[index + 1];
      setStage(db, initiativeId, next ? next.key : "steps_done", now);
      if (!next) return null;
      continue; // start the next step in the same tick
    }
    if (task.status === "cancelled") {
      block(db, initiative, `the ${step.key} step was cancelled`, "owner", now);
      return null;
    }
    return null; // still running, waiting or being retried
  }
  return null;
}

function block(db: Db, initiative: Row, reason: string, escalation: "vp" | "owner", now: number): void {
  db.prepare("UPDATE initiatives SET status='blocked', blocked_reason=?, escalation=?, updated_at=? WHERE id=?").run(
    reason.slice(0, 1000),
    escalation,
    now,
    String(initiative.id),
  );
  note(
    db,
    "escalated",
    `"${String(initiative.title).slice(0, 100)}" is blocked (${reason.slice(0, 200)}); ${escalation === "vp" ? "the VPs are on it" : "it needs the owner"}`,
    now,
    { id: String(initiative.id), business: initiative.business },
  );
}

export type EscalationAction = "retry" | "skip" | "stop" | "owner";

/**
 * A decision on a blocked initiative, from the VPs or the owner. `retry` runs the step once more (with notes and,
 * optionally, another agent); the VPs may retry a step once, after that it goes to the owner. `skip` moves on.
 */
export function resolveEscalation(
  db: Db,
  initiativeId: string,
  input: { action: EscalationAction; notes?: string; agent_id?: string | null },
  decidedBy: "vp" | "owner",
  now = Date.now(),
): Row {
  ensureWorkEngineSchema(db);
  const initiative =
    (db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined) ??
    fail("initiative_not_found");
  if (initiative.status !== "blocked") fail("initiative_not_blocked");
  if (decidedBy === "vp" && initiative.escalation !== "vp") fail("escalation_is_with_the_owner");
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";
  const who = decidedBy === "vp" ? "VPs" : "Owner";
  const title = String(initiative.title).slice(0, 100);
  const ref = { id: initiativeId, business: initiative.business };
  const stage = String(initiative.playbook_stage ?? "");
  const task = stage ? stepTask(db, initiativeId, stage) : undefined;
  const unblock = (extra = "") =>
    db
      .prepare(
        `UPDATE initiatives SET status='in_progress', blocked_reason=NULL, escalation=NULL, updated_at=?${extra} WHERE id=?`,
      )
      .run(now, initiativeId);
  if (input.action === "retry") {
    if (decidedBy === "vp" && Number(initiative.step_attempts ?? 0) >= 1) fail("vp_retry_used");
    if (task && !["done"].includes(String(task.status))) {
      const agent =
        input.agent_id && db.prepare("SELECT 1 FROM agents WHERE id=?").get(input.agent_id)
          ? input.agent_id
          : task.assigned_agent_id;
      db.prepare(
        `UPDATE tasks SET status='planned', step_failure=NULL, attempt=?, assigned_agent_id=?, description=?, updated_at=? WHERE id=?`,
      ).run(
        MAX_STEP_ATTEMPTS,
        agent,
        `${String(task.description)}\n\n${who.toUpperCase()} SAY: try once more.${notes ? ` ${notes}` : ""} Earlier work is in your working folder.`,
        now,
        String(task.id),
      );
    }
    unblock(", step_attempts=step_attempts+1");
    note(db, "escalation_retry", `${who}: retry "${title}"${notes ? ` (${notes.slice(0, 160)})` : ""}`, now, ref);
  } else if (input.action === "skip") {
    if (task && !["done", "cancelled"].includes(String(task.status)))
      db.prepare("UPDATE tasks SET status='cancelled', step_failure=NULL, updated_at=? WHERE id=?").run(
        now,
        String(task.id),
      );
    const playbook = initiative.playbook ? getPlaybook(db, String(initiative.playbook)) : null;
    const index = playbook?.steps.findIndex((step) => step.key === stage) ?? -1;
    const next = playbook && index >= 0 ? playbook.steps[index + 1] : undefined;
    unblock(", step_attempts=0");
    setStage(db, initiativeId, next ? next.key : "steps_done", now);
    note(
      db,
      "escalation_skip",
      `${who}: skip the ${stage} step of "${title}"${notes ? ` (${notes.slice(0, 160)})` : ""}`,
      now,
      ref,
    );
  } else if (input.action === "stop") {
    db.prepare("UPDATE initiatives SET status='stopped', stop_reason=?, escalation=NULL, updated_at=? WHERE id=?").run(
      `${who}: ${notes || initiative.blocked_reason || "stopped"}`.slice(0, 500),
      now,
      initiativeId,
    );
    db.prepare(
      "UPDATE tasks SET status='cancelled', updated_at=? WHERE initiative_id=? AND status IN ('planned','inbox','pending')",
    ).run(now, initiativeId);
    note(db, "escalation_stop", `${who}: stop "${title}"${notes ? ` (${notes.slice(0, 160)})` : ""}`, now, ref);
  } else if (input.action === "owner") {
    db.prepare("UPDATE initiatives SET escalation='owner', blocked_reason=?, updated_at=? WHERE id=?").run(
      `${String(initiative.blocked_reason ?? "")}${notes ? `\nVPs recommend: ${notes}` : ""}`.slice(0, 1500),
      now,
      initiativeId,
    );
    note(db, "escalated", `VPs passed "${title}" to the owner${notes ? `: ${notes.slice(0, 160)}` : ""}`, now, ref);
  } else fail("invalid_action");
  return db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row;
}

// ── Failures and retries ────────────────────────────────────────────────────────────────────────────────────────

/** Called by the run handler when an autonomous step's run fails. The engine retries or escalates on its next tick. */
export function recordStepFailure(db: Db, taskId: string, reason: string, now = Date.now()): void {
  const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("step_failure") || !columns.includes("origin")) return;
  db.prepare(
    "UPDATE tasks SET step_failure=?, updated_at=? WHERE id=? AND origin='autonomy' AND playbook_step IS NOT NULL",
  ).run(reason.slice(0, 1000), now, taskId);
}

function otherProvider(provider: unknown): string | null {
  return provider === "codex" ? "claude" : provider === "claude" ? "codex" : null;
}

/** Applies the retry ladder to every failed step: same agent, then another agent on the other model, then escalate. */
export function handleStepFailures(db: Db, now = Date.now()): void {
  const failed = db
    .prepare(
      "SELECT * FROM tasks WHERE origin='autonomy' AND step_failure IS NOT NULL AND status IN ('inbox','pending') ORDER BY updated_at",
    )
    .all() as Row[];
  for (const task of failed) {
    const reason = String(task.step_failure);
    const step = String(task.playbook_step ?? "");
    const ref = {
      id: String(task.initiative_id ?? task.goal_id ?? task.id),
      business: task.business,
      taskId: String(task.id),
    };
    if (step.startsWith(SCHEDULE_STEP_PREFIX)) {
      scheduleFailed(db, task, reason, now);
      continue;
    }
    const attempt = Number(task.attempt ?? 1);
    if (attempt < MAX_STEP_ATTEMPTS) {
      const current = task.assigned_agent_id
        ? (db.prepare("SELECT * FROM agents WHERE id=?").get(String(task.assigned_agent_id)) as Row | undefined)
        : undefined;
      const other =
        attempt + 1 >= MAX_STEP_ATTEMPTS && task.department_id
          ? pickStepAgent(db, String(task.department_id), {
              importance: task.importance === "important" ? "important" : "routine",
              provider: otherProvider(current?.cli_provider),
              exclude: current ? [String(current.id)] : [],
            })
          : null;
      const agentId = other?.id ?? task.assigned_agent_id;
      const handover = other
        ? ` ${String(other.name ?? other.id)} takes over from ${String(current?.name ?? "the previous agent")}.`
        : "";
      db.prepare(
        "UPDATE tasks SET status='planned', step_failure=NULL, attempt=?, assigned_agent_id=?, description=?, updated_at=? WHERE id=?",
      ).run(
        attempt + 1,
        agentId,
        `${String(task.description)}\n\nATTEMPT ${attempt + 1} of ${MAX_STEP_ATTEMPTS}: the last run failed (${reason.slice(0, 400)}).${handover} Earlier work is kept in the working folder; fix the problem and finish.`,
        now,
        String(task.id),
      );
      note(
        db,
        "retry",
        `Retrying "${String(task.title).slice(0, 100)}" (attempt ${attempt + 1}${other ? `, ${String(other.name ?? other.id)}` : ""}): ${reason.slice(0, 160)}`,
        now,
        ref,
      );
      continue;
    }
    db.prepare("UPDATE tasks SET step_failure=NULL, updated_at=? WHERE id=?").run(now, String(task.id));
    if (task.initiative_id) {
      const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(String(task.initiative_id)) as
        | Row
        | undefined;
      if (
        initiative &&
        ["approved", "in_progress"].includes(String(initiative.status)) &&
        initiative.playbook_stage === step
      ) {
        block(db, initiative, `the ${step} step failed ${MAX_STEP_ATTEMPTS} times: ${reason}`, "vp", now);
        continue;
      }
    }
    // Research angles, the synthesis and shop setup: dropped after the last try; the goal moves on or retries later.
    db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id=?").run(now, String(task.id));
    note(
      db,
      "step_dropped",
      `Gave up on "${String(task.title).slice(0, 100)}" after ${MAX_STEP_ATTEMPTS} tries: ${reason.slice(0, 160)}`,
      now,
      ref,
    );
  }
}

// ── Schedules (Operations work) ─────────────────────────────────────────────────────────────────────────────────

function scheduleFailed(db: Db, task: Row, reason: string, now: number): void {
  const scheduleId = String(task.playbook_step).slice(SCHEDULE_STEP_PREFIX.length);
  db.prepare("UPDATE tasks SET status='cancelled', step_failure=NULL, updated_at=? WHERE id=?").run(
    now,
    String(task.id),
  );
  const limit = autonomyConfig(db).failure_limit;
  db.prepare(
    `UPDATE schedules SET consecutive_failures=consecutive_failures+1,
      enabled=CASE WHEN consecutive_failures+1>=? THEN 0 ELSE enabled END, updated_at=? WHERE id=?`,
  ).run(limit, now, scheduleId);
  const schedule = db.prepare("SELECT enabled, business FROM schedules WHERE id=?").get(scheduleId) as Row | undefined;
  note(
    db,
    schedule && !schedule.enabled ? "schedule_paused" : "failed",
    schedule && !schedule.enabled
      ? "Schedule paused after repeated run failures"
      : `Scheduled run failed: ${reason.slice(0, 160)}`,
    now,
    { id: `schedule:${scheduleId}`, business: schedule?.business, taskId: String(task.id) },
  );
}

/** Due schedules become Operations tasks (the owner made the schedule, so no further approval). */
export function enqueueSchedules(db: Db, now = Date.now()): string[] {
  // A finished scheduled run clears the failure count.
  db.exec(
    `UPDATE schedules SET consecutive_failures=0 WHERE consecutive_failures>0 AND last_task_id IN (SELECT id FROM tasks WHERE status='done')`,
  );
  const due = db
    .prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 8")
    .all(now) as Row[];
  const created: string[] = [];
  for (const schedule of due) {
    const claim = db
      .prepare("UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?")
      .run(nextScheduleRun(schedule, now), now, schedule.id, schedule.next_run_at);
    if (!claim.changes) continue;
    const ref = { id: `schedule:${String(schedule.id)}`, business: schedule.business };
    const open = schedule.last_task_id
      ? db
          .prepare("SELECT 1 FROM tasks WHERE id=? AND status NOT IN ('done','cancelled')")
          .get(String(schedule.last_task_id))
      : null;
    if (open) {
      note(db, "skipped", "Scheduled run skipped because the last one is still open", now, ref);
      continue;
    }
    try {
      const department = String(schedule.department_id ?? researchDepartment(db, schedule) ?? "planning");
      const agent = pickStepAgent(db, department, { importance: "routine" }) ?? fail("no_agent_for_schedule");
      const lead =
        schedule.kind === "lead_research"
          ? "Research relevant public lead sources, add qualified contacts with evidence to the business workspace, and prepare personalized message drafts. Preparation only; anything sent to customers goes through the owner's approval.\n\n"
          : "";
      const id = createWorkTask(
        db,
        {
          title: String(schedule.title),
          description: lead + String(schedule.description || schedule.title),
          department_id: department,
          agent_id: String(agent.id),
          business: String(schedule.business),
          project_id: schedule.project_id ?? null,
          work_type: schedule.kind === "lead_research" ? "outreach" : "research",
          importance: "routine",
          playbook_step: `${SCHEDULE_STEP_PREFIX}${String(schedule.id)}`,
        },
        now,
      );
      db.prepare("UPDATE schedules SET last_task_id=?, updated_at=? WHERE id=?").run(id, now, schedule.id);
      created.push(id);
    } catch (error) {
      note(
        db,
        "skipped",
        `Scheduled run could not be created: ${error instanceof Error ? error.message : "error"}`,
        now,
        ref,
      );
    }
  }
  return created;
}

// ── Planning goals ──────────────────────────────────────────────────────────────────────────────────────────────

/** Goals in their period that are not reached yet. */
export function liveGoals(db: Db, now = Date.now()): Row[] {
  return (autonomyOverview(db).goals as Row[]).filter(
    (goal) =>
      Number(goal.period_start) <= now &&
      Number(goal.period_end) > now &&
      (goal.progress === null || Number(goal.progress) < Number(goal.target)),
  );
}

/** One goal's planning step: research phase, synthesis, shop setup, then its approved initiatives. */
export function planGoal(db: Db, goalId: string, now = Date.now(), hooks: GoalHooks = {}): void {
  const goal = db.prepare("SELECT * FROM business_goals WHERE id=?").get(goalId) as Row | undefined;
  if (!goal) return;
  const reason = goalNeedsStrategy(db, goal, now);
  if (reason) {
    startResearchPhase(db, goal, reason, now);
    return;
  }
  maybeStartSynthesis(db, goal, now);
  const strategy = approvedStrategy(db, goalId);
  if (!strategy) return;
  hooks.shopSetup?.(db, goal, String(strategy.summary), now);
  const initiatives = db
    .prepare(
      "SELECT id FROM initiatives WHERE goal_id=? AND status IN ('approved','in_progress') ORDER BY approved_at, created_at",
    )
    .all(goalId) as Row[];
  for (const initiative of initiatives) advanceInitiative(db, String(initiative.id), now);
}

export interface GoalHooks {
  /** Etsy: queues the once-per-shop setup task (etsy-shop.ts). Injected to keep this module free of Etsy code. */
  shopSetup?: (db: Db, goal: Row, strategySummary: string, now: number) => unknown;
}

// ── Starting tasks ──────────────────────────────────────────────────────────────────────────────────────────────

export type StartTask = (taskId: string, agent: Row, deptId: string | null, deptName: string) => Promise<unknown>;

/** Why this initiative's next task must wait, or null: its status, stop rules and daily cap. */
export function initiativeStartBlock(db: Db, initiativeId: string, now = Date.now()): string | null {
  const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined;
  if (!initiative) return "initiative not found";
  if (!["approved", "in_progress", "launched", "measuring"].includes(String(initiative.status)))
    return `initiative is ${String(initiative.status)}`;
  const budget = initiativeBudgetBlock(db, initiativeId);
  if (budget) return budget;
  const startedToday = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE initiative_id=? AND started_at>?")
        .get(initiativeId, now - DAY_MS) as Row
    ).n,
  );
  const cap = Number(initiative.task_cap_daily ?? 3);
  if (startedToday >= cap) return `daily cap reached (${cap} tasks in 24 hours)`;
  return null;
}

/** Starts planned autonomous tasks: important first, one per agent, within every cap. Returns started task ids. */
export async function startPlannedWork(db: Db, startTask: StartTask, now = Date.now()): Promise<string[]> {
  const planned = db
    .prepare(
      `SELECT * FROM tasks WHERE origin='autonomy' AND status='planned' AND assigned_agent_id IS NOT NULL AND playbook_step IS NOT NULL
       ORDER BY CASE importance WHEN 'important' THEN 0 ELSE 1 END, created_at, rowid LIMIT 40`,
    )
    .all() as Row[];
  const config = autonomyConfig(db);
  const used = new Set<string>();
  const started: string[] = [];
  for (const task of planned) {
    if (started.length >= STARTS_PER_TICK) break;
    const ref = {
      id: String(task.initiative_id ?? task.goal_id ?? task.id),
      business: task.business,
      taskId: String(task.id),
    };
    if (task.initiative_id) {
      const blocked = initiativeStartBlock(db, String(task.initiative_id), now);
      if (blocked) {
        note(db, "waiting", `"${String(task.title).slice(0, 80)}" waits: ${blocked}`, now, ref);
        continue;
      }
    }
    if (!isResearchPhaseTask(task)) {
      const starts = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations WHERE day=?").get(autonomyDay(now)) as Row)
          .n,
      );
      if (starts >= config.daily_start_cap) {
        note(db, "blocked", "Daily autonomous start cap reached", now);
        continue;
      }
    }
    const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(String(task.assigned_agent_id)) as Row | undefined;
    if (
      !agent ||
      used.has(String(agent.id)) ||
      agent.current_task_id ||
      !["idle", null, undefined].includes(agent.status)
    )
      continue;
    const usage = autonomyTaskUsageBlockReason(db, String(task.id), now);
    if (usage) {
      note(db, "blocked", usage, now, ref);
      continue;
    }
    used.add(String(agent.id));
    const department = db
      .prepare("SELECT name FROM departments WHERE id=?")
      .get(String(agent.department_id ?? task.department_id)) as Row | undefined;
    try {
      const result = (await startTask(
        String(task.id),
        agent,
        (agent.department_id as string | null) ?? (task.department_id as string | null),
        String(department?.name ?? agent.department_id ?? ""),
      )) as { ok?: boolean; error?: string } | undefined;
      if (result && result.ok === false) {
        note(db, "waiting", `"${String(task.title).slice(0, 80)}" not started: ${result.error ?? "refused"}`, now, ref);
        continue;
      }
      started.push(String(task.id));
      note(
        db,
        "started",
        `Started "${String(task.title).slice(0, 100)}" with ${String(agent.name ?? agent.id)}`,
        now,
        ref,
      );
    } catch (error) {
      note(
        db,
        "waiting",
        `"${String(task.title).slice(0, 80)}" launch failed: ${error instanceof Error ? error.message : "error"}`,
        now,
        ref,
      );
    }
  }
  return started;
}

// ── The tick ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WorkEngineDeps {
  db: Db;
  startTask: StartTask;
  now?: () => number;
  ownerSecurityReady?: () => boolean;
  broadcast?: (event: string, payload: unknown) => void;
  hooks?: GoalHooks;
}

export async function runWorkEngineTick(deps: WorkEngineDeps): Promise<void> {
  const { db } = deps;
  if (running.has(db)) return;
  running.add(db);
  try {
    ensureWorkEngineSchema(db);
    const now = deps.now?.() ?? Date.now();
    // The owner's stop rules and verified milestones, even while paused.
    evaluateInitiatives(db, now);
    evaluateMilestones(db, now);
    handleStepFailures(db, now);
    if (!isAutonomyAllowed()) return;
    if (!(deps.ownerSecurityReady ?? isPasswordConfigured)()) {
      note(db, "blocked", "Owner password setup is required for autonomous work", now);
      return;
    }
    enqueueSchedules(db, now);
    for (const goal of liveGoals(db, now)) {
      try {
        planGoal(db, String(goal.id), now, deps.hooks);
      } catch (error) {
        note(
          db,
          "blocked",
          `Planning "${goalName(goal)}" failed: ${error instanceof Error ? error.message : "error"}`,
          now,
          {
            id: String(goal.id),
            business: goal.business,
          },
        );
      }
    }
    const started = await startPlannedWork(db, deps.startTask, now);
    for (const id of started) deps.broadcast?.("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
  } finally {
    running.delete(db);
  }
}

export type { Playbook };
