import { randomUUID } from "node:crypto";
import { ensureControlStateSchema, isAutonomyAllowed } from "./control-state.ts";
import { BUSINESSES, isBusinessKey } from "./businesses.ts";
import type { DatabaseSync } from "node:sqlite";

/**
 * Agent autonomy, level 1: eligible agents periodically think about their area and suggest tasks.
 * Suggestions wait on the owner (Today > approvals). Approving creates an ordinary planned task; nothing runs on its own.
 * Team leaders are always eligible; other agents only when `agents.autonomy_enabled = 1`.
 */

/** Settings key. Missing or anything but `false` means on. */
export const AUTONOMY_SETTING = "autonomyProposalsEnabled";
const DEFAULT_THINK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const AUTONOMY_TICK_MS = 10 * 60 * 1000;
export const MAX_PENDING_PER_AGENT = 2;
export const MAX_PENDING_TOTAL = 12;
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROPOSALS_PER_THOUGHT = 2;
const THINK_TIMEOUT_MS = 150_000;

export function thinkIntervalMs(): number {
  const raw = Number(process.env.AUTONOMY_THINK_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_THINK_INTERVAL_MS;
}

export type ProposalStatus = "pending" | "approved" | "dismissed" | "expired";

export interface AutonomyAgent {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
}

export interface ParsedProposal {
  title: string;
  description: string;
  reason: string;
  project_id: string | null;
}

interface ThinkingContext {
  department: { name: string; description: string | null; prompt: string | null } | null;
  projects: Array<{ id: string; name: string; core_goal: string }>;
  recentTasks: Array<{ title: string; status: string }>;
  openDepartmentTasks: Array<{ title: string; status: string }>;
  pastProposals: Array<{ title: string; status: string }>;
  /** Short summaries of the owner's filled-in business profiles (Tech Services, Events and Rentals). */
  businesses: string[];
}

function readBusinessSummaries(db: DatabaseSync): string[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'business_profiles'").get();
  if (!exists) return [];
  const rows = db.prepare("SELECT * FROM business_profiles ORDER BY business").all() as Array<Record<string, unknown>>;
  const summaries: string[] = [];
  for (const row of rows) {
    const part = (label: string, key: string, max: number) => {
      const value = clean(row[key], max);
      return value ? `${label}: ${value}` : "";
    };
    const details = [
      part("Services", "services", 600),
      part("Service area", "service_area", 160),
      part("Hours", "hours", 120),
      part("How the owner works", "workflow_notes", 600),
    ].filter(Boolean);
    const name = clean(row.name, 160);
    if (!name && !details.length) continue;
    const label = isBusinessKey(row.business) ? BUSINESSES[row.business].label : "Business";
    summaries.push(`- ${label}${name ? ` "${name}"` : ""}${details.length ? `. ${details.join(". ")}` : ""}`);
  }
  return summaries;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function ensureAgentProposalSchema(db: DatabaseSync): void {
  // Suggested tasks are tagged with who started them (tasks.origin).
  ensureControlStateSchema(db);
  if (!columnExists(db, "agents", "autonomy_enabled")) {
    db.exec("ALTER TABLE agents ADD COLUMN autonomy_enabled INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    department_id TEXT,
    project_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('pending','approved','dismissed','expired')),
    task_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_task_proposals_status ON agent_task_proposals(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_task_proposals_agent ON agent_task_proposals(agent_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS agent_autonomy_state (
    agent_id TEXT PRIMARY KEY,
    last_thought_at INTEGER NOT NULL,
    last_error TEXT
  );`);
  if (!columnExists(db, "agent_task_proposals", "decided_by")) {
    db.exec("ALTER TABLE agent_task_proposals ADD COLUMN decided_by TEXT");
  }
}

export function isAutonomyEnabled(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(AUTONOMY_SETTING) as
      | { value: string }
      | undefined;
    if (!row) return true;
    return String(row.value).replace(/"/g, "").trim() !== "false";
  } catch {
    return true;
  }
}

/** Team leaders always; everyone else only when the owner turned it on for them. */
export function isAgentAutonomyEligible(agent: { role: string; autonomy_enabled?: number | null }): boolean {
  return agent.role === "team_leader" || Number(agent.autonomy_enabled ?? 0) === 1;
}

export function expireStaleProposals(db: DatabaseSync, now: number): number {
  return Number(
    db
      .prepare(
        "UPDATE agent_task_proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?",
      )
      .run(now, now - PROPOSAL_TTL_MS).changes,
  );
}

/** The eligible idle agent that has waited longest since it last thought, or null when nobody is due. */
export function pickAgentDueForThinking(
  db: DatabaseSync,
  now: number,
  opts: { intervalMs?: number; isAgentInMeeting?: (agentId: string) => boolean } = {},
): AutonomyAgent | null {
  const pendingTotal = (
    db.prepare("SELECT COUNT(*) AS n FROM agent_task_proposals WHERE status = 'pending'").get() as { n: number }
  ).n;
  if (pendingTotal >= MAX_PENDING_TOTAL) return null;
  const intervalMs = opts.intervalMs ?? thinkIntervalMs();
  const rows = db
    .prepare(
      `SELECT a.* FROM agents a
       LEFT JOIN agent_autonomy_state s ON s.agent_id = a.id
       WHERE (a.role = 'team_leader' OR COALESCE(a.autonomy_enabled, 0) = 1)
         AND a.status IN ('idle', 'break')
         AND a.cli_provider IS NOT NULL
         AND (s.last_thought_at IS NULL OR s.last_thought_at <= ?)
         AND (SELECT COUNT(*) FROM agent_task_proposals p WHERE p.agent_id = a.id AND p.status = 'pending') < ?
       ORDER BY COALESCE(s.last_thought_at, 0) ASC, a.created_at ASC
       LIMIT 20`,
    )
    .all(now - intervalMs, MAX_PENDING_PER_AGENT) as unknown as AutonomyAgent[];
  return rows.find((agent) => !opts.isAgentInMeeting?.(agent.id)) ?? null;
}

function gatherThinkingContext(db: DatabaseSync, agent: AutonomyAgent): ThinkingContext {
  const department = agent.department_id
    ? ((db.prepare("SELECT name, description, prompt FROM departments WHERE id = ?").get(agent.department_id) as
        | ThinkingContext["department"]
        | undefined) ?? null)
    : null;
  const projects = db
    .prepare(
      "SELECT id, name, core_goal FROM projects ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC LIMIT 5",
    )
    .all() as ThinkingContext["projects"];
  const recentTasks = db
    .prepare("SELECT title, status FROM tasks WHERE assigned_agent_id = ? ORDER BY updated_at DESC LIMIT 8")
    .all(agent.id) as ThinkingContext["recentTasks"];
  const openDepartmentTasks = agent.department_id
    ? (db
        .prepare(
          `SELECT title, status FROM tasks WHERE department_id = ? AND status NOT IN ('done', 'cancelled')
           ORDER BY updated_at DESC LIMIT 10`,
        )
        .all(agent.department_id) as ThinkingContext["openDepartmentTasks"])
    : [];
  const pastProposals = db
    .prepare("SELECT title, status FROM agent_task_proposals WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10")
    .all(agent.id) as ThinkingContext["pastProposals"];
  return {
    department,
    projects,
    recentTasks,
    openDepartmentTasks,
    pastProposals,
    businesses: readBusinessSummaries(db),
  };
}

const LANGUAGE_NAMES: Record<string, string> = { en: "English" };

export function buildProposalPrompt(agent: AutonomyAgent, ctx: ThinkingContext, language = "en"): string {
  const list = (items: Array<{ title: string; status: string }>) =>
    items.length ? items.map((item) => `- ${item.title} (${item.status})`).join("\n") : "- (none)";
  const role = agent.role === "team_leader" ? "team leader" : agent.role;
  return [
    `You are ${agent.name}, a ${role}${ctx.department ? ` in the ${ctx.department.name} department` : ""}.`,
    agent.personality ? `Your expertise and personality: ${agent.personality}` : "",
    ctx.department?.description ? `Department purpose: ${ctx.department.description}` : "",
    ctx.department?.prompt ? `Department guidance: ${ctx.department.prompt}` : "",
    "",
    "You have free time. Think about what would genuinely help the owner's business and projects right now,",
    "and suggest at most 2 concrete tasks you could do yourself. The owner will approve or dismiss each one.",
    "Only suggest work that is clearly useful, specific and within your role. Suggesting nothing is fine and",
    "better than busywork. Do not repeat or overlap anything listed below.",
    "",
    ...(ctx.businesses.length ? ["The owner's businesses:", ...ctx.businesses, ""] : []),
    "Active projects (id: name - goal):",
    ctx.projects.length ? ctx.projects.map((p) => `- ${p.id}: ${p.name} - ${p.core_goal}`).join("\n") : "- (none)",
    "",
    "Your recent tasks:",
    list(ctx.recentTasks),
    "",
    "Open tasks in your department:",
    list(ctx.openDepartmentTasks),
    "",
    "Your earlier suggestions (dismissed ones were not wanted; do not suggest them again):",
    list(ctx.pastProposals),
    "",
    `Write titles and text in ${LANGUAGE_NAMES[language] ?? "English"}.`,
    "Reply with ONLY this JSON, no other text:",
    '{"proposals":[{"title":"short imperative title","description":"what you would do and what the result is","reason":"why this matters now","project_id":"one of the project ids above, or null"}]}',
    'If nothing is worth doing, reply {"proposals":[]}.',
    "Do not use any tools.",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Reads the agent's JSON reply, dropping anything malformed, duplicated or already on the board.
 * Returns null when the reply has no proposals list at all (for example a CLI sign-in error), so that is not
 * mistaken for "nothing worth suggesting".
 */
export function parseProposalReply(
  text: string,
  opts: { projectIds: Set<string>; existingTitles: Iterable<string> },
): ParsedProposal[] | null {
  const parsed = extractJsonObject(text) as { proposals?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.proposals)) return null;
  const seen = new Set([...opts.existingTitles].map(normalizeTitle));
  const result: ParsedProposal[] = [];
  for (const raw of parsed.proposals) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = clean(item.title, 140);
    const key = normalizeTitle(title);
    if (title.length < 4 || seen.has(key)) continue;
    seen.add(key);
    const projectId =
      typeof item.project_id === "string" && opts.projectIds.has(item.project_id) ? item.project_id : null;
    result.push({
      title,
      description: clean(item.description, 1500),
      reason: clean(item.reason, 400),
      project_id: projectId,
    });
    if (result.length >= MAX_PROPOSALS_PER_THOUGHT) break;
  }
  return result;
}

export interface ThinkDeps {
  db: DatabaseSync;
  runAgentOneShot: (
    agent: AutonomyAgent,
    prompt: string,
    opts: { projectPath?: string; timeoutMs?: number; rawOutput?: boolean; noTools?: boolean },
  ) => Promise<{ text: string; error?: string }>;
  isAgentInMeeting?: (agentId: string) => boolean;
  getPreferredLanguage?: () => string;
  now?: () => number;
  log?: (message: string) => void;
}

/** One autonomy tick: at most one agent thinks. Returns what happened, or null when nobody was due. */
export async function runAutonomyTick(
  deps: ThinkDeps,
): Promise<{ agentId: string; created: number; error?: string } | null> {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  if (!isAutonomyEnabled(db) || !isAutonomyAllowed()) return null;
  expireStaleProposals(db, now);
  const agent = pickAgentDueForThinking(db, now, { isAgentInMeeting: deps.isAgentInMeeting });
  if (!agent) return null;

  // Record the attempt first, so a crash or failing provider cannot make this agent think every tick.
  db.prepare(
    `INSERT INTO agent_autonomy_state (agent_id, last_thought_at, last_error) VALUES (?, ?, NULL)
     ON CONFLICT(agent_id) DO UPDATE SET last_thought_at = excluded.last_thought_at, last_error = NULL`,
  ).run(agent.id, now);

  const ctx = gatherThinkingContext(db, agent);
  const prompt = buildProposalPrompt(agent, ctx, deps.getPreferredLanguage?.() ?? "en");
  let text = "";
  let error: string | undefined;
  try {
    const run = await deps.runAgentOneShot(agent, prompt, {
      timeoutMs: THINK_TIMEOUT_MS,
      rawOutput: true,
      noTools: true,
    });
    text = run.text ?? "";
    error = run.error;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const proposals = error
    ? null
    : parseProposalReply(text, {
        projectIds: new Set(ctx.projects.map((p) => p.id)),
        existingTitles: [...ctx.recentTasks, ...ctx.openDepartmentTasks, ...ctx.pastProposals].map((t) => t.title),
      });
  if (!proposals) {
    const reason = error ?? `unreadable_reply: ${text.replace(/\s+/g, " ").trim().slice(0, 200) || "(empty)"}`;
    db.prepare("UPDATE agent_autonomy_state SET last_error = ? WHERE agent_id = ?").run(reason.slice(0, 500), agent.id);
    deps.log?.(`[autonomy] ${agent.name} could not think: ${reason}`);
    return { agentId: agent.id, created: 0, error: reason };
  }
  const insert = db.prepare(
    `INSERT INTO agent_task_proposals (id, agent_id, department_id, project_id, title, description, reason, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  for (const proposal of proposals) {
    insert.run(
      randomUUID(),
      agent.id,
      agent.department_id,
      proposal.project_id,
      proposal.title,
      proposal.description,
      proposal.reason,
      now,
    );
  }
  deps.log?.(`[autonomy] ${agent.name} suggested ${proposals.length} task(s)`);
  return { agentId: agent.id, created: proposals.length };
}

export interface DecideDeps {
  decidedBy?: string;
  appendTaskLog?: (taskId: string, kind: string, message: string) => void;
  broadcast?: (event: string, payload: unknown) => void;
  recordTaskCreationAudit?: (input: Record<string, unknown>) => void;
  now?: () => number;
}

export type DecideResult =
  | { ok: true; status: "approved"; task_id: string }
  | { ok: true; status: "dismissed" }
  | { ok: false; error: "proposal_not_pending" };

/** Approve turns the suggestion into a planned task assigned to the agent who suggested it; dismiss just records it. */
export function decideProposal(db: DatabaseSync, id: string, approve: boolean, deps: DecideDeps = {}): DecideResult {
  const decidedBy = deps.decidedBy ?? "owner";
  const now = deps.now?.() ?? Date.now();
  const proposal = db.prepare("SELECT * FROM agent_task_proposals WHERE id = ? AND status = 'pending'").get(id) as
    | {
        id: string;
        agent_id: string;
        department_id: string | null;
        project_id: string | null;
        title: string;
        description: string;
        reason: string;
      }
    | undefined;
  if (!proposal) return { ok: false, error: "proposal_not_pending" };

  if (!approve) {
    const changed = db
      .prepare(
        "UPDATE agent_task_proposals SET status = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, decidedBy, id).changes;
    return changed ? { ok: true, status: "dismissed" } : { ok: false, error: "proposal_not_pending" };
  }

  const agent = db.prepare("SELECT id, department_id FROM agents WHERE id = ?").get(proposal.agent_id) as
    | { id: string; department_id: string | null }
    | undefined;
  const project = proposal.project_id
    ? (db.prepare("SELECT id, project_path FROM projects WHERE id = ?").get(proposal.project_id) as
        | { id: string; project_path: string }
        | undefined)
    : undefined;
  const taskId = randomUUID();
  const departmentId = agent?.department_id ?? proposal.department_id ?? null;
  const description = [
    proposal.description,
    proposal.reason ? `[WHY] ${proposal.reason}` : "",
    `[SOURCE] Suggested by the agent and approved by ${decidedBy}.`,
  ]
    .filter(Boolean)
    .join("\n");

  db.exec("BEGIN");
  try {
    const changed = db
      .prepare(
        "UPDATE agent_task_proposals SET status = 'approved', decided_at = ?, task_id = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, taskId, decidedBy, id).changes;
    if (!changed) {
      db.exec("ROLLBACK");
      return { ok: false, error: "proposal_not_pending" };
    }
    db.prepare(
      `INSERT INTO tasks (id, title, description, department_id, assigned_agent_id, project_id, status, priority, task_type,
         project_path, created_at, updated_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, 'planned', 0, 'general', ?, ?, ?, 'autonomy')`,
    ).run(
      taskId,
      proposal.title,
      description,
      departmentId,
      agent?.id ?? null,
      project?.id ?? null,
      project?.project_path ?? null,
      now,
      now,
    );
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }

  deps.recordTaskCreationAudit?.({
    taskId,
    taskTitle: proposal.title,
    taskStatus: "planned",
    departmentId,
    assignedAgentId: agent?.id ?? null,
    taskType: "general",
    projectPath: project?.project_path ?? null,
    trigger: "autonomy.proposal_approved",
    triggerDetail: `agent proposal ${proposal.id}`,
    actorType: decidedBy === "owner" ? "user" : "agent",
  });
  deps.appendTaskLog?.(
    taskId,
    "system",
    `Task created from an agent suggestion approved by ${decidedBy}: ${proposal.title}`,
  );
  deps.broadcast?.("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  return { ok: true, status: "approved", task_id: taskId };
}
