import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getAgentPerformanceSummary } from "./agent-performance.ts";

type Db = Pick<DatabaseSync, "exec" | "prepare">;
type Agent = {
  id: string;
  name: string;
  cli_provider: string | null;
  cli_model: string | null;
  api_model: string | null;
  api_provider_id: string | null;
  cli_reasoning_level: string | null;
  cli_fallback_provider?: string | null;
};
type Task = {
  task_type?: string;
  id: string;
  title: string;
  description: string | null;
  assigned_agent_id: string | null;
  status: string;
};
type DirectorRun = (
  agent: Agent,
  prompt: string,
  options: { noTools: true; rawOutput: true; timeoutMs: number },
) => Promise<{ text: string; error?: string }>;

export type TaskModelRoute = {
  api_provider_id?: string | null;
  context_window_tokens?: number | null;
  task_id: string;
  agent_id: string;
  provider: string;
  model: string;
  reasoning_level: string | null;
  source: string;
  reason: string;
  director_agent_id: string | null;
  updated_at: number;
};

export function ensureModelRoutingSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_model_routes (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT,
      source TEXT NOT NULL CHECK(source IN ('default','director','manual','upgrade')),
      reason TEXT NOT NULL DEFAULT '',
      director_agent_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_upgrade_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      requested_model TEXT,
      requested_reasoning_level TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),
      director_agent_id TEXT,
      decision_reason TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_model_upgrade_requests_task ON model_upgrade_requests(task_id, created_at DESC);
  `);
  const routeColumns = db.prepare("PRAGMA table_info(task_model_routes)").all() as Array<{ name: string }>;
  if (!routeColumns.some((c) => c.name === "api_provider_id"))
    db.exec("ALTER TABLE task_model_routes ADD COLUMN api_provider_id TEXT");
  if (!routeColumns.some((c) => c.name === "context_window_tokens"))
    db.exec("ALTER TABLE task_model_routes ADD COLUMN context_window_tokens INTEGER");
  const columns = db.prepare("PRAGMA table_info(model_upgrade_requests)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "requested_provider"))
    db.exec("ALTER TABLE model_upgrade_requests ADD COLUMN requested_provider TEXT");
  if (!columns.some((c) => c.name === "decided_by"))
    db.exec("ALTER TABLE model_upgrade_requests ADD COLUMN decided_by TEXT");
}

function setting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export type LocalRoutingConfig = {
  enabled: boolean;
  apiProviderId: string | null;
  model: string | null;
  taskTypes: string[];
  contextWindowTokens: number;
};

export function modelDirectorConfig(db: Db) {
  const directorAgentId = setting<string | null>(db, "modelDirectorAgentId", null);
  const raw = setting<Record<string, unknown>>(db, "modelRoutingCandidates", {});
  const candidates: Record<string, string[]> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [provider, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      candidates[provider] = [
        ...new Set(list.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())),
      ].slice(0, 30);
    }
  }
  const technical = setting<string | null>(db, "technicalDirectorAgentId", null);
  const design = setting<string | null>(db, "designDirectorAgentId", null);
  const local = setting<Partial<LocalRoutingConfig> | null>(db, "localModelRouting", null);
  return {
    technicalDirectorAgentId: typeof technical === "string" && technical ? technical : null,
    designDirectorAgentId: typeof design === "string" && design ? design : null,
    localRouting: {
      enabled: local?.enabled === true,
      apiProviderId: typeof local?.apiProviderId === "string" ? local.apiProviderId : null,
      model: typeof local?.model === "string" ? local.model : null,
      taskTypes: Array.isArray(local?.taskTypes)
        ? local.taskTypes.filter((v): v is string => typeof v === "string")
        : ["documentation", "analysis"],
      contextWindowTokens:
        Number.isSafeInteger(local?.contextWindowTokens) && Number(local?.contextWindowTokens) >= 2048
          ? Number(local?.contextWindowTokens)
          : 8192,
    } satisfies LocalRoutingConfig,
    directorAgentId: typeof directorAgentId === "string" && directorAgentId ? directorAgentId : null,
    candidates,
  };
}

export function availableModels(db: Db, agent: Agent): string[] {
  const provider = agent.cli_provider || "claude";
  const configured = modelDirectorConfig(db).candidates[provider] ?? [];
  const defaults = setting<Record<string, { model?: string; subModel?: string }>>(db, "providerModelConfig", {});
  const models = [
    ...configured,
    provider === "api" ? agent.api_model : agent.cli_model,
    defaults[provider]?.model,
    defaults[provider]?.subModel,
  ];
  if (provider === "api" && agent.api_provider_id) {
    const row = db.prepare("SELECT models_cache FROM api_providers WHERE id = ?").get(agent.api_provider_id) as
      | { models_cache: string | null }
      | undefined;
    if (row?.models_cache) {
      try {
        const cached = JSON.parse(row.models_cache) as unknown;
        if (Array.isArray(cached))
          models.push(...cached.filter((v): v is string => typeof v === "string").slice(0, 30));
      } catch {
        /* cached discovery is optional */
      }
    }
  }
  return [
    ...new Set(models.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())),
  ];
}

function taskAndAgent(db: Db, taskId: string): { task: Task; agent: Agent } | null {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
  if (!task?.assigned_agent_id) return null;
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
  return agent ? { task, agent } : null;
}

export function getTaskModelRoute(db: Db, taskId: string, agentId?: string): TaskModelRoute | null {
  try {
    const route = db.prepare("SELECT * FROM task_model_routes WHERE task_id = ?").get(taskId) as
      | TaskModelRoute
      | undefined;
    return route && (!agentId || route.agent_id === agentId) ? route : null;
  } catch {
    return null;
  }
}

export function getCurrentTaskModelRoute(db: Db, taskId: string): TaskModelRoute | null {
  try {
    const row = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
      | { assigned_agent_id: string | null }
      | undefined;
    return row?.assigned_agent_id ? getTaskModelRoute(db, taskId, row.assigned_agent_id) : null;
  } catch {
    return null;
  }
}

function saveRoute(
  db: Db,
  taskId: string,
  agent: Agent,
  model: string,
  reasoningLevel: string | null,
  source: TaskModelRoute["source"],
  reason: string,
  directorId: string | null,
  local?: { apiProviderId: string; contextWindowTokens: number },
): TaskModelRoute {
  db.prepare(
    `INSERT INTO task_model_routes (task_id,agent_id,provider,model,reasoning_level,source,reason,director_agent_id,updated_at,api_provider_id,context_window_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      agent_id=excluded.agent_id,provider=excluded.provider,model=excluded.model,reasoning_level=excluded.reasoning_level,
      source=excluded.source,reason=excluded.reason,director_agent_id=excluded.director_agent_id,updated_at=excluded.updated_at,
      api_provider_id=excluded.api_provider_id,context_window_tokens=excluded.context_window_tokens`,
  ).run(
    taskId,
    agent.id,
    agent.cli_provider || "claude",
    model,
    reasoningLevel,
    source,
    reason,
    directorId,
    Date.now(),
    local?.apiProviderId ?? (agent.cli_provider === "api" ? agent.api_provider_id : null),
    local?.contextWindowTokens ?? null,
  );
  return getTaskModelRoute(db, taskId, agent.id)!;
}

function jsonDecision(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function director(db: Db, taskType?: string): Agent | null {
  const config = modelDirectorConfig(db);
  const id =
    (taskType === "design" ? config.designDirectorAgentId : config.technicalDirectorAgentId) || config.directorAgentId;
  const columns = "id, name, cli_provider, cli_model, api_model, api_provider_id, cli_reasoning_level";
  const row = id
    ? (db.prepare(`SELECT ${columns} FROM agents WHERE id = ? AND status != 'offline'`).get(id) as Agent | undefined)
    : undefined;
  if (row && (row.cli_provider === "claude" || row.cli_provider === "codex")) return row;
  // The model director is always on: without a configured director (or when it is offline), a VP chooses.
  try {
    return (
      (db
        .prepare(
          `SELECT ${columns} FROM agents WHERE role = 'vp' AND status != 'offline' AND cli_provider IN ('claude','codex') ORDER BY name LIMIT 1`,
        )
        .get() as Agent | undefined) ?? null
    );
  } catch {
    return null; // An agents table without roles (older schema): fall back to the configured default model.
  }
}

export const RUNNABLE_PROVIDERS = ["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"];

function runnable(agent: { cli_provider: string | null; api_provider_id?: string | null }): boolean {
  if (!agent.cli_provider || !RUNNABLE_PROVIDERS.includes(agent.cli_provider)) return false;
  return agent.cli_provider !== "api" || Boolean(agent.api_provider_id);
}

/**
 * Before any task starts: an agent with no usable model must not break anything. When the agent has no provider
 * (or one ATLAS cannot run), the VPs give it the provider its department partner uses, else a VP's, else Codex,
 * save that on the agent and record it in the autonomy log. Returns the agent as it should run now.
 */
export function ensureRunnableAgent<
  T extends {
    id: string;
    name: string;
    cli_provider: string | null;
    department_id?: string | null;
    api_provider_id?: string | null;
  },
>(db: Db, agent: T, now = Date.now()): { agent: T; fixed: string | null } {
  if (runnable(agent)) return { agent, fixed: null };
  const candidates = db
    .prepare(
      `SELECT cli_provider, api_provider_id, role, department_id FROM agents
       WHERE id != ? AND status != 'offline' AND cli_provider IS NOT NULL AND cli_provider != 'api'
       ORDER BY CASE WHEN department_id = ? THEN 0 WHEN role = 'vp' THEN 1 ELSE 2 END, name`,
    )
    .all(agent.id, agent.department_id ?? null) as Array<{
    cli_provider: string;
    role: string;
    department_id: string | null;
  }>;
  const pick = candidates.find((row) => RUNNABLE_PROVIDERS.includes(row.cli_provider));
  const provider = pick?.cli_provider ?? "codex";
  const source = !pick
    ? "the default"
    : pick.department_id && pick.department_id === agent.department_id
      ? "the department partner"
      : pick.role === "vp"
        ? "a VP"
        : "another agent";
  db.prepare("UPDATE agents SET cli_provider = ?, cli_model = NULL WHERE id = ?").run(provider, agent.id);
  const before = agent.cli_provider ? `'${agent.cli_provider}', which can't run` : "no model";
  const fixed = `VPs set ${agent.name} to ${provider} (from ${source}); it had ${before}.`;
  try {
    db.prepare(
      "INSERT INTO autonomy_ledger(event,business,source_id,task_id,message,created_at) VALUES ('vp_model_fix',NULL,?,NULL,?,?)",
    ).run(agent.id, fixed, now);
  } catch {
    /* The ledger table is optional in isolated tests. */
  }
  return { agent: { ...agent, cli_provider: provider, cli_model: null } as T, fixed };
}

/** Match the same validated local route before subscription admission, without starting a director. */
export function configuredLocalTaskProvider(db: Pick<DatabaseSync, "prepare">, taskId: string): "api" | null {
  try {
    const local = modelDirectorConfig(db as Db).localRouting;
    const task = db.prepare("SELECT task_type FROM tasks WHERE id = ?").get(taskId) as
      | { task_type: string }
      | undefined;
    if (!local.enabled || !local.apiProviderId || !local.model || !task || !local.taskTypes.includes(task.task_type))
      return null;
    const provider = db
      .prepare("SELECT type,enabled,models_cache FROM api_providers WHERE id = ?")
      .get(local.apiProviderId) as { type: string; enabled: number; models_cache: string | null } | undefined;
    const models: unknown = JSON.parse(provider?.models_cache || "[]");
    return provider?.type === "ollama" && provider.enabled && Array.isArray(models) && models.includes(local.model)
      ? "api"
      : null;
  } catch {
    return null;
  }
}

export async function routeTaskModel(
  db: Db,
  taskId: string,
  runDirector: DirectorRun,
  force = false,
  skipLocal = false,
): Promise<TaskModelRoute | null> {
  const found = taskAndAgent(db, taskId);
  if (!found) return null;
  const { task, agent } = found;
  const existing = getTaskModelRoute(db, taskId, agent.id);
  if (existing && !force) return existing;
  const local = modelDirectorConfig(db).localRouting;
  if (!skipLocal && configuredLocalTaskProvider(db, taskId) === "api" && local.apiProviderId && local.model) {
    return saveRoute(
      db,
      taskId,
      { ...agent, cli_provider: "api" },
      local.model,
      null,
      "default",
      `Routine ${task.task_type} task routed to the configured Ollama host`,
      null,
      { apiProviderId: local.apiProviderId, contextWindowTokens: local.contextWindowTokens },
    );
  }
  const candidates = availableModels(db, agent);
  if (candidates.length === 0) {
    if (skipLocal) db.prepare("DELETE FROM task_model_routes WHERE task_id = ?").run(taskId);
    return null;
  }
  const directorAgent = director(db, task.task_type);
  if (!directorAgent || candidates.length === 1) {
    return saveRoute(
      db,
      taskId,
      agent,
      candidates[0]!,
      agent.cli_provider === "codex" ? agent.cli_reasoning_level : null,
      "default",
      "Configured model fallback",
      null,
    );
  }
  const prompt = [
    `You are the ${task.task_type === "design" ? "design" : "technical"} model director. Choose exactly one listed model for this worker's task. Prefer economical models for routine work; use stronger models for complexity or repeated failures. Do not use tools.`,
    `Task: ${task.title}\n${(task.description ?? "").slice(0, 4000)}`,
    `Worker: ${agent.name}; provider: ${agent.cli_provider}; allowed models: ${JSON.stringify(candidates)}`,
    `Recorded worker performance (success is exit-code success; rework includes resumes; reported cost coverage only, missing cost unknown): ${JSON.stringify(
      getAgentPerformanceSummary(db, { agentId: agent.id })
        .filter((row) => row.provider === agent.cli_provider && candidates.includes(row.model))
        .slice(0, 30),
    )}`,
    'Reply only JSON: {"model":"one allowed model","reason":"brief justification"}.',
  ].join("\n\n");
  try {
    const result = await runDirector(directorAgent, prompt, { noTools: true, rawOutput: true, timeoutMs: 60_000 });
    const decision = !result.error ? jsonDecision(result.text) : null;
    const chosen = typeof decision?.model === "string" && candidates.includes(decision.model) ? decision.model : null;
    if (chosen)
      return saveRoute(
        db,
        taskId,
        agent,
        chosen,
        agent.cli_provider === "codex" ? agent.cli_reasoning_level : null,
        "director",
        String(decision?.reason ?? "Director choice").slice(0, 500),
        directorAgent.id,
      );
  } catch {
    /* keep task execution available when the director fails */
  }
  return saveRoute(
    db,
    taskId,
    agent,
    candidates[0]!,
    agent.cli_provider === "codex" ? agent.cli_reasoning_level : null,
    "default",
    "Director unavailable; configured fallback",
    null,
  );
}

export function createModelUpgradeRequest(
  db: Db,
  taskId: string,
  reason: string,
  requestedModel?: string | null,
  requestedReasoningLevel?: string | null,
  requestedProvider?: string | null,
) {
  const found = taskAndAgent(db, taskId);
  if (!found) throw new Error("task_or_agent_not_found");
  const explanation = reason.trim();
  if (explanation.length < 10 || explanation.length > 2000) throw new Error("invalid_reason");
  const currentRoute = getTaskModelRoute(db, taskId, found.agent.id);
  const currentProvider = currentRoute?.provider || found.agent.cli_provider;
  const provider =
    requestedProvider?.trim() ||
    (currentProvider === "api" ? found.agent.cli_fallback_provider || "codex" : found.agent.cli_provider || "claude");
  if (provider !== found.agent.cli_provider && !["codex", "claude"].includes(provider))
    throw new Error("invalid_upgrade_provider");
  const targetAgent =
    provider === found.agent.cli_provider
      ? found.agent
      : { ...found.agent, cli_provider: provider, cli_model: null, cli_reasoning_level: null };
  const candidates = availableModels(db, targetAgent);
  const current =
    currentRoute?.model ?? (found.agent.cli_provider === "api" ? found.agent.api_model : found.agent.cli_model);
  const next =
    requestedModel?.trim() ||
    candidates[Math.min(Math.max(candidates.indexOf(current ?? "") + 1, 0), candidates.length - 1)] ||
    null;
  if (!next || !candidates.includes(next)) throw new Error("requested_model_not_available");
  if (
    provider === (currentRoute?.provider || found.agent.cli_provider) &&
    next === current &&
    !requestedReasoningLevel?.trim()
  )
    throw new Error("no_model_upgrade_available");
  const pending = db
    .prepare("SELECT * FROM model_upgrade_requests WHERE task_id = ? AND status = 'pending'")
    .get(taskId);
  if (pending) return pending as Record<string, unknown>;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO model_upgrade_requests
    (id,task_id,agent_id,requested_model,requested_reasoning_level,reason,status,created_at,requested_provider)
    VALUES (?,?,?,?,?,?,'pending',?,?)`,
  ).run(id, taskId, found.agent.id, next, requestedReasoningLevel?.trim() || null, explanation, Date.now(), provider);
  return db.prepare("SELECT * FROM model_upgrade_requests WHERE id = ?").get(id) as Record<string, unknown>;
}

export async function decideModelUpgrade(
  db: Db,
  requestId: string,
  approve: boolean | null,
  decisionReason: string,
  _runDirector?: DirectorRun,
  decidedBy: string = "owner",
): Promise<Record<string, unknown>> {
  const request = db.prepare("SELECT * FROM model_upgrade_requests WHERE id = ?").get(requestId) as
    | {
        id: string;
        task_id: string;
        agent_id: string;
        requested_model: string;
        requested_provider: string | null;
        requested_reasoning_level: string | null;
        status: string;
      }
    | undefined;
  if (!request) throw new Error("request_not_found");
  if (request.status !== "pending") throw new Error("request_already_decided");
  // Only the dual-VP review loop or an explicit owner decision may decide an upgrade.
  if (approve === null) return request;
  const found = taskAndAgent(db, request.task_id);
  if (!found || found.agent.id !== request.agent_id) throw new Error("task_assignment_changed");
  const provider = request.requested_provider || found.agent.cli_provider || "claude";
  const targetAgent =
    provider === found.agent.cli_provider
      ? found.agent
      : { ...found.agent, cli_provider: provider, cli_model: null, cli_reasoning_level: null };
  if (approve && !availableModels(db, targetAgent).includes(request.requested_model))
    throw new Error("requested_model_not_available");
  db.exec("SAVEPOINT decide_model_upgrade");
  try {
    const changed = db
      .prepare(
        "UPDATE model_upgrade_requests SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(approve ? "approved" : "denied", decidedBy, decisionReason.trim().slice(0, 2000), Date.now(), requestId);
    if (!changed.changes) throw new Error("request_already_decided");
    if (approve)
      saveRoute(
        db,
        request.task_id,
        targetAgent,
        request.requested_model,
        request.requested_reasoning_level,
        "upgrade",
        decisionReason,
        null,
      );
    db.exec("RELEASE decide_model_upgrade");
  } catch (error) {
    db.exec("ROLLBACK TO decide_model_upgrade; RELEASE decide_model_upgrade");
    throw error;
  }
  return db.prepare("SELECT * FROM model_upgrade_requests WHERE id = ?").get(requestId) as Record<string, unknown>;
}

export function consumeModelUpgradeMarker(
  db: Db,
  taskId: string,
  worktreePath: string | undefined,
): Record<string, unknown> | null {
  if (!worktreePath) return null;
  const marker = path.join(worktreePath, ".atlas-model-upgrade.json");
  try {
    if (!fs.existsSync(marker) || fs.statSync(marker).size > 4096) return null;
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    const request = createModelUpgradeRequest(
      db,
      taskId,
      String(parsed.reason ?? ""),
      typeof parsed.model === "string" ? parsed.model : null,
      typeof parsed.reasoning_level === "string" ? parsed.reasoning_level : null,
      typeof parsed.provider === "string" ? parsed.provider : null,
    );
    fs.unlinkSync(marker);
    return request;
  } catch {
    return null;
  }
}
