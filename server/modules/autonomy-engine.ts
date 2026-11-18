import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isAutonomyAllowed } from "./control-state.ts";
import { ensureAgentProposalSchema } from "./agent-proposals.ts";
import { ensureAutonomySchema, autonomyConfig, appendAutonomyLedger } from "./autonomy-store.ts";
import { isPasswordConfigured } from "../security/login-sessions.ts";
import { configuredLocalTaskProvider } from "./model-routing.ts";

type Row = Record<string, any>;
const running = new WeakSet<DatabaseSync>();
export const AUTONOMY_TIMEZONE = "America/New_York";
export const USAGE_MAX_AGE_MS = 10 * 60_000;

export function ensureAutonomyEngineSchema(db: DatabaseSync): void {
  ensureAutonomySchema(db);
  ensureAgentProposalSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS autonomy_engine_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_start_reservations(work_id TEXT PRIMARY KEY,day TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS autonomy_work_snapshots(work_id TEXT PRIMARY KEY,proposal_hash TEXT NOT NULL,source_hash TEXT);`);
}

export function autonomyDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTONOMY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function usageHeadroomBlockReason(
  db: DatabaseSync,
  now = Date.now(),
  providers: Iterable<string> = ["codex", "claude"],
): string | null {
  const config = autonomyConfig(db);
  for (const provider of new Set(providers)) {
    // Subscription windows apply to the provider actually being called. A local
    // model must not be blocked by an unrelated, disconnected subscription.
    if (provider !== "codex" && provider !== "claude") continue;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cli_usage_cache'").get())
      return "Subscription usage is not available yet";
    const row = db.prepare("SELECT data_json,updated_at FROM cli_usage_cache WHERE provider=?").get(provider) as
      | Row
      | undefined;
    if (
      !row ||
      !Number.isFinite(row.updated_at) ||
      row.updated_at > now + 60_000 ||
      now - row.updated_at > USAGE_MAX_AGE_MS
    )
      return `${provider} subscription usage needs refreshing`;
    try {
      const entry = JSON.parse(row.data_json);
      if (entry.error || !Array.isArray(entry.windows) || !entry.windows.length)
        return `${provider} subscription usage is unavailable`;
      for (const window of entry.windows) {
        if (!Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 1)
          return `${provider} subscription usage is invalid`;
        if (window.utilization >= config.usage_threshold)
          return `${provider} subscription window reached the autonomy threshold`;
      }
    } catch {
      return `${provider} subscription usage is invalid`;
    }
  }
  return null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function proposalHash(row: Row): string {
  return hash([row.agent_id, row.project_id, row.title, row.description, row.reason]);
}
function scheduleHash(row: Row): string {
  return hash([
    row.business,
    row.project_id,
    row.department_id,
    row.title,
    row.description,
    row.kind,
    row.interval_minutes,
  ]);
}
function table(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function ledger(db: DatabaseSync, event: string, message: string, now: number, work?: Row): void {
  // Repeated headroom/busy waits should not flood the owner's digest.
  const key = `log:${event}:${work?.id ?? "engine"}`;
  const last = db.prepare("SELECT value FROM autonomy_engine_state WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  if (last?.value === message && ["skipped", "waiting", "blocked"].includes(event)) return;
  appendAutonomyLedger(
    db,
    { event, business: work?.business, sourceId: work?.id, taskId: work?.task_id, message },
    now,
  );
  db.prepare(
    "INSERT INTO autonomy_engine_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, message);
}

export interface QueueAutonomyWork {
  business: string;
  project_id: string;
  department_id: string;
  title: string;
  description: string;
  reason: string;
  opportunity_id?: string | null;
  schedule_id?: string | null;
}

/** Queue a bounded, reviewable request. This never starts a task or approves its own proposal. */
export function queueAutonomyWork(db: DatabaseSync, input: QueueAutonomyWork, now = Date.now()): string {
  ensureAutonomyEngineSchema(db);
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(input.project_id) as Row | undefined;
  if (!project || typeof project.project_path !== "string" || !path.isAbsolute(project.project_path))
    throw new Error("autonomy_project_path_required");
  if (!["tech", "rental", "ventures"].includes(input.business)) throw new Error("autonomy_invalid_business");
  const leader = db
    .prepare("SELECT * FROM agents WHERE role='team_leader' AND department_id=? ORDER BY created_at,id LIMIT 1")
    .get(input.department_id) as Row | undefined;
  if (!leader) throw new Error("autonomy_team_leader_required");
  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    !input.description.trim() ||
    input.description.length > 12000 ||
    !input.reason.trim()
  )
    throw new Error("autonomy_invalid_work");
  const pending = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM agent_task_proposals WHERE status='pending'").get() as Row).n,
  );
  if (pending >= 12) throw new Error("autonomy_review_queue_full");
  const id = randomUUID(),
    proposalId = randomUUID();
  const description = [
    input.description,
    `Business: ${input.business}. Preparation and implementation must use the existing business approval gateway for external actions.`,
    input.business !== "ventures"
      ? "Scope: research, contacts, demos and drafts. Customer-facing delivery requires the owner through the approval gateway."
      : "Scope: ventures research and implementation. External delivery requires its separate approval gateway.",
    "Budget figures are estimates only; they do not authorize purchases.",
  ].join("\n\n");
  db.exec("SAVEPOINT autonomy_queue");
  try {
    db.prepare(
      `INSERT INTO agent_task_proposals(id,agent_id,department_id,project_id,title,description,reason,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)`,
    ).run(
      proposalId,
      leader.id,
      input.department_id,
      input.project_id,
      input.title.trim(),
      description,
      input.reason,
      now,
    );
    db.prepare(
      `INSERT INTO autonomy_work(id,business,project_id,opportunity_id,schedule_id,proposal_id,task_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,NULL,'pending',?,?)`,
    ).run(
      id,
      input.business,
      input.project_id,
      input.opportunity_id ?? null,
      input.schedule_id ?? null,
      proposalId,
      now,
      now,
    );
    const proposal = db.prepare("SELECT * FROM agent_task_proposals WHERE id=?").get(proposalId) as Row;
    const schedule = input.schedule_id
      ? (db.prepare("SELECT * FROM schedules WHERE id=?").get(input.schedule_id) as Row)
      : null;
    db.prepare("INSERT INTO autonomy_work_snapshots(work_id,proposal_hash,source_hash) VALUES(?,?,?)").run(
      id,
      proposalHash(proposal),
      schedule ? scheduleHash(schedule) : null,
    );
    ledger(db, "proposed", `Queued for independent approval: ${input.title.trim()}`, now, {
      id,
      business: input.business,
    });
    db.exec("RELEASE autonomy_queue");
    return id;
  } catch (error) {
    db.exec("ROLLBACK TO autonomy_queue; RELEASE autonomy_queue");
    throw error;
  }
}

/** Headroom and emergency controls for every task in an autonomous delegation tree. */
export function autonomyTaskUsageBlockReason(db: DatabaseSync, taskId: string, now = Date.now()): string | null {
  if (!table(db, "autonomy_config")) return null;
  const task = db.prepare("SELECT origin FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (task?.origin !== "autonomy") return null;
  if (!isAutonomyAllowed()) return "Autonomy is paused";
  const route = table(db, "task_model_routes")
    ? (db.prepare("SELECT provider FROM task_model_routes WHERE task_id=?").get(taskId) as Row | undefined)
    : undefined;
  const assigned = db
    .prepare("SELECT a.cli_provider FROM agents a JOIN tasks t ON t.assigned_agent_id=a.id WHERE t.id=?")
    .get(taskId) as Row | undefined;
  const provider = route?.provider ?? configuredLocalTaskProvider(db, taskId) ?? assigned?.cli_provider;
  if (typeof provider !== "string" || !provider) return "Autonomous worker provider is not configured";
  if (!["codex", "claude", "gemini", "kimi", "opencode", "copilot", "antigravity", "api"].includes(provider))
    return "Autonomous worker provider is not supported";
  return usageHeadroomBlockReason(db, now, [provider]);
}

/** Reserve every new autonomous task, including delegates, once; continuations reuse their reservation. */
export function admitAutonomyTaskStart(db: DatabaseSync, taskId: string, now = Date.now()): string | null {
  if (!table(db, "autonomy_start_reservations")) return null;
  const usage = autonomyTaskUsageBlockReason(db, taskId, now);
  if (usage) return usage;
  const task = db.prepare("SELECT origin FROM tasks WHERE id=?").get(taskId) as Row | undefined;
  if (task?.origin !== "autonomy") return null;
  const source = autonomyTaskStartBlockReason(db, taskId, now);
  if (source) return source;
  const work = db.prepare("SELECT id FROM autonomy_work WHERE task_id=?").get(taskId) as Row | undefined;
  const key = work?.id ?? `task:${taskId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM autonomy_start_reservations WHERE work_id=?").get(key)) {
      db.exec("COMMIT");
      return null;
    }
    const day = autonomyDay(now),
      config = autonomyConfig(db);
    const count = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations WHERE day=?").get(day) as Row).n,
    );
    if (count >= config.daily_start_cap) {
      db.exec("ROLLBACK");
      return "Daily autonomous task start cap reached";
    }
    db.prepare("INSERT INTO autonomy_start_reservations(work_id,day,created_at) VALUES(?,?,?)").run(key, day, now);
    db.exec("COMMIT");
    return null;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Rechecked after model routing awaits, immediately before dispatching an admitted autonomous task. */
export function autonomyTaskStartBlockReason(db: DatabaseSync, taskId: string, now = Date.now()): string | null {
  const usage = autonomyTaskUsageBlockReason(db, taskId, now);
  if (usage) return usage;
  if (!table(db, "autonomy_work")) return null;
  const work = db.prepare("SELECT * FROM autonomy_work WHERE task_id=?").get(taskId) as Row | undefined;
  if (!work) return null;
  if (!isAutonomyAllowed()) return "Autonomy is paused";
  if (work.status !== "running") return "Autonomous admission is no longer active";
  const source = sourceBlockReason(db, work);
  return source;
}

function sourceBlockReason(db: DatabaseSync, work: Row): string | null {
  const saved = db.prepare("SELECT * FROM autonomy_work_snapshots WHERE work_id=?").get(work.id) as Row | undefined;
  const proposal = db.prepare("SELECT * FROM agent_task_proposals WHERE id=?").get(work.proposal_id) as Row | undefined;
  if (!saved || !proposal || proposalHash(proposal) !== saved.proposal_hash) return "The reviewed work request changed";
  const project = db.prepare("SELECT project_path FROM projects WHERE id=?").get(work.project_id) as Row | undefined;
  if (!project || !path.isAbsolute(String(project.project_path ?? ""))) return "An explicit project path is required";
  if (work.schedule_id) {
    const schedule = db.prepare("SELECT * FROM schedules WHERE id=?").get(work.schedule_id) as Row | undefined;
    if (!schedule?.enabled) return "Schedule is paused";
    if (scheduleHash(schedule) !== saved.source_hash) return "Schedule changed after review was requested";
  }
  if (work.opportunity_id) {
    const opportunity = db.prepare("SELECT status FROM opportunities WHERE id=?").get(work.opportunity_id) as
      | Row
      | undefined;
    if (!opportunity || ["stopped", "launched"].includes(opportunity.status))
      return "Opportunity is no longer accepting work";
  }
  if (work.task_id) {
    if (proposal.status !== "approved" || proposal.task_id !== work.task_id || !proposal.decided_by)
      return "The work approval is no longer active or attributed";
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(work.task_id) as Row | undefined;
    if (
      !task ||
      task.origin !== "autonomy" ||
      task.title !== proposal.title ||
      task.project_id !== work.project_id ||
      task.assigned_agent_id !== proposal.agent_id ||
      !String(task.description).startsWith(proposal.description) ||
      task.project_path !== project.project_path
    )
      return "Approved task assignment or content changed";
  }
  return null;
}

export function recordAutonomyTaskFailure(db: DatabaseSync, taskId: string, message: string, now = Date.now()): void {
  if (!table(db, "autonomy_work")) return;
  const work = db.prepare("SELECT * FROM autonomy_work WHERE task_id=? AND status='running'").get(taskId) as
    | Row
    | undefined;
  if (!work) return;
  db.exec("SAVEPOINT autonomy_failure");
  try {
    db.prepare("UPDATE autonomy_work SET status='failed',updated_at=? WHERE id=? AND status='running'").run(
      now,
      work.id,
    );
    ledger(db, "failed", message, now, work);
    if (work.schedule_id) {
      const limit = autonomyConfig(db).failure_limit;
      db.prepare(
        `UPDATE schedules SET consecutive_failures=consecutive_failures+1,
        enabled=CASE WHEN consecutive_failures+1>=? THEN 0 ELSE enabled END,updated_at=? WHERE id=?`,
      ).run(limit, now, work.schedule_id);
      const schedule = db.prepare("SELECT enabled FROM schedules WHERE id=?").get(work.schedule_id) as Row | undefined;
      if (schedule && !schedule.enabled)
        ledger(db, "schedule_paused", "Schedule paused after repeated run failures", now, work);
    }
    db.exec("RELEASE autonomy_failure");
  } catch (error) {
    db.exec("ROLLBACK TO autonomy_failure; RELEASE autonomy_failure");
    throw error;
  }
}

function reconcile(db: DatabaseSync, now: number): void {
  const rows = db
    .prepare("SELECT * FROM autonomy_work WHERE status IN ('pending','planned','running') ORDER BY created_at")
    .all() as Row[];
  for (const work of rows) {
    const proposal = db.prepare("SELECT * FROM agent_task_proposals WHERE id=?").get(work.proposal_id) as
      | Row
      | undefined;
    if (work.status === "pending") {
      if (!proposal || ["dismissed", "expired"].includes(proposal.status)) {
        db.prepare("UPDATE autonomy_work SET status='skipped',updated_at=? WHERE id=?").run(now, work.id);
        ledger(db, "declined", "Work request was declined or expired", now, work);
      } else if (proposal.status === "approved" && proposal.task_id) {
        db.prepare("UPDATE autonomy_work SET status='planned',task_id=?,updated_at=? WHERE id=?").run(
          proposal.task_id,
          now,
          work.id,
        );
        ledger(db, "approved", "Work approved and ready for bounded execution", now, {
          ...work,
          task_id: proposal.task_id,
        });
      }
    } else if (work.task_id) {
      const task = db.prepare("SELECT status FROM tasks WHERE id=?").get(work.task_id) as Row | undefined;
      if (task?.status === "done") {
        db.prepare("UPDATE autonomy_work SET status='done',updated_at=? WHERE id=?").run(now, work.id);
        if (work.schedule_id)
          db.prepare("UPDATE schedules SET consecutive_failures=0,updated_at=? WHERE id=?").run(now, work.schedule_id);
        if (work.opportunity_id)
          db.prepare(
            "UPDATE opportunities SET status='building',updated_at=? WHERE id=? AND status IN ('idea','researching','approved')",
          ).run(now, work.opportunity_id);
        ledger(db, "completed", "Autonomous task completed; delivery and income are not inferred", now, work);
      } else if (!task || task.status === "cancelled") {
        db.prepare("UPDATE autonomy_work SET status='skipped',updated_at=? WHERE id=?").run(now, work.id);
        ledger(db, "skipped", "Task was removed or cancelled; it will not restart automatically", now, work);
      } else if (work.status === "running" && task.status === "pending") {
        ledger(db, "waiting", "Task is pending for recovery or approval; automatic replay is held", now, work);
      }
    }
  }
}

function enqueueSchedules(db: DatabaseSync, now: number): void {
  const due = db
    .prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 8")
    .all(now) as Row[];
  for (const schedule of due) {
    db.exec("SAVEPOINT autonomy_due");
    try {
      const claim = db
        .prepare("UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?")
        .run(now + schedule.interval_minutes * 60_000, now, schedule.id, schedule.next_run_at);
      if (!claim.changes) {
        db.exec("RELEASE autonomy_due");
        continue;
      }
      const existing = db
        .prepare("SELECT 1 FROM autonomy_work WHERE schedule_id=? AND status IN ('pending','planned','running')")
        .get(schedule.id);
      if (existing)
        ledger(db, "skipped", "Scheduled occurrence skipped because earlier work is still pending", now, {
          ...schedule,
          id: `schedule:${schedule.id}`,
        });
      else {
        const lead =
          schedule.kind === "lead_research"
            ? "Research relevant public lead sources, add qualified contacts with evidence to the business workspace, and prepare personalized message drafts. Preparation only; customer-facing sends go through the existing owner approval gateway.\n\n"
            : "";
        queueAutonomyWork(
          db,
          {
            business: schedule.business,
            project_id: schedule.project_id,
            department_id: schedule.department_id,
            title: schedule.title,
            description: lead + schedule.description,
            reason: "Scheduled research or implementation",
            schedule_id: schedule.id,
          },
          now,
        );
      }
      db.exec("RELEASE autonomy_due");
    } catch (error) {
      // Keep the advance even if queueing fails: never catch up by launching the same occurrence repeatedly.
      db.exec("RELEASE autonomy_due");
      ledger(
        db,
        "skipped",
        `Schedule occurrence could not be queued: ${error instanceof Error ? error.message : "invalid request"}`,
        now,
        { ...schedule, id: `schedule:${schedule.id}` },
      );
    }
  }
}

interface EngineDeps {
  db: DatabaseSync;
  startTask: (taskId: string, agent: Row, deptId: string | null, deptName: string) => Promise<void>;
  now?: () => number;
  ownerSecurityReady?: () => boolean;
  broadcast?: (event: string, payload: unknown) => void;
}

export async function runAutonomyEngineTick(deps: EngineDeps): Promise<void> {
  const { db } = deps;
  if (running.has(db)) return;
  running.add(db);
  try {
    ensureAutonomyEngineSchema(db);
    const now = deps.now?.() ?? Date.now();
    reconcile(db, now);
    if (!isAutonomyAllowed()) return;
    if (!(deps.ownerSecurityReady ?? isPasswordConfigured)()) {
      ledger(db, "blocked", "Owner password setup is required for autonomous execution", now);
      return;
    }
    enqueueSchedules(db, now);
    const works = db
      .prepare("SELECT * FROM autonomy_work WHERE status='planned' ORDER BY created_at LIMIT 20")
      .all() as Row[];
    for (const work of works) {
      const reason = sourceBlockReason(db, work);
      if (reason) {
        ledger(db, "waiting", reason, now, work);
        continue;
      }
      const proposal = db.prepare("SELECT * FROM agent_task_proposals WHERE id=?").get(work.proposal_id) as Row;
      if (proposal.status !== "approved" || proposal.task_id !== work.task_id || !proposal.decided_by) {
        ledger(db, "waiting", "Work still needs an attributed approval", now, work);
        continue;
      }
      const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(work.task_id) as Row;
      const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(task.assigned_agent_id) as Row | undefined;
      if (
        task.status !== "planned" ||
        agent?.role !== "team_leader" ||
        agent.status !== "idle" ||
        agent.current_task_id
      ) {
        ledger(db, "waiting", "Waiting for an idle team leader and an unchanged planned task", now, work);
        continue;
      }
      const usageBlock = autonomyTaskUsageBlockReason(db, work.task_id, now);
      if (usageBlock) {
        ledger(db, "blocked", usageBlock, now, work);
        continue;
      }
      const config = autonomyConfig(db),
        day = autonomyDay(now);
      db.exec("BEGIN IMMEDIATE");
      try {
        const count = Number(
          (db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations WHERE day=?").get(day) as Row).n,
        );
        if (count >= config.daily_start_cap) {
          db.exec("ROLLBACK");
          ledger(db, "blocked", "Daily autonomous start cap reached", now);
          break;
        }
        const claim = db
          .prepare("UPDATE autonomy_work SET status='running',updated_at=? WHERE id=? AND status='planned'")
          .run(now, work.id);
        if (!claim.changes) {
          db.exec("ROLLBACK");
          continue;
        }
        db.prepare("INSERT INTO autonomy_start_reservations(work_id,day,created_at) VALUES(?,?,?)").run(
          work.id,
          day,
          now,
        );
        if (work.schedule_id)
          db.prepare("UPDATE schedules SET last_task_id=?,updated_at=? WHERE id=?").run(
            work.task_id,
            now,
            work.schedule_id,
          );
        if (work.opportunity_id)
          db.prepare(
            "UPDATE opportunities SET status='approved',updated_at=? WHERE id=? AND status IN ('idea','researching')",
          ).run(now, work.opportunity_id);
        ledger(db, "started", "Autonomous start admitted against the daily cap", now, work);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      try {
        if (autonomyTaskStartBlockReason(db, work.task_id, deps.now?.() ?? now)) {
          ledger(db, "waiting", "Admission changed before launch; held for review", now, work);
          return;
        }
        const department = db.prepare("SELECT name FROM departments WHERE id=?").get(agent.department_id) as
          | Row
          | undefined;
        await deps.startTask(work.task_id, agent, agent.department_id, department?.name ?? agent.department_id);
        const after = db.prepare("SELECT status FROM tasks WHERE id=?").get(work.task_id) as Row | undefined;
        if (after?.status === "planned") {
          const held = autonomyTaskStartBlockReason(db, work.task_id, deps.now?.() ?? now);
          if (held) ledger(db, "waiting", `Launch held for review: ${held}`, deps.now?.() ?? now, work);
          else
            recordAutonomyTaskFailure(
              db,
              work.task_id,
              "Task launcher refused the admitted start",
              deps.now?.() ?? now,
            );
        }
      } catch {
        const held = autonomyTaskStartBlockReason(db, work.task_id, deps.now?.() ?? now);
        if (held) ledger(db, "waiting", `Launch held for review: ${held}`, deps.now?.() ?? now, work);
        else
          recordAutonomyTaskFailure(
            db,
            work.task_id,
            "Autonomous task launch failed; retained for manual recovery",
            deps.now?.() ?? now,
          );
      }
      deps.broadcast?.("task_update", db.prepare("SELECT * FROM tasks WHERE id=?").get(work.task_id));
      break;
    }
  } finally {
    running.delete(db);
  }
}
