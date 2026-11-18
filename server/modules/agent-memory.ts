import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";

/**
 * Persistent agent memory: short facts and lessons that survive from one task to the next.
 *
 * Agents add them while working (`memory.add`); the most relevant ones are put into later task prompts and can be
 * searched (`memory.search`). A new memory is used right away but stays marked unreviewed until the owner confirms,
 * edits or archives it. Memories are reference notes, never instructions: approval rules are enforced in code, so a
 * wrong memory cannot unlock sending, spending or SSH.
 */
export const MEMORY_KINDS = ["fact", "lesson"] as const;
export const MEMORY_SCOPES = ["global", "business", "project"] as const;
export const MEMORY_STATUSES = ["active", "archived"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_BODY_MAX = 1000;
export const MEMORY_WRITES_PER_TASK = 5;

export interface AgentMemory {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  business: BusinessKey | null;
  project_id: string | null;
  title: string;
  body: string;
  source_agent_id: string | null;
  source_task_id: string | null;
  status: MemoryStatus;
  reviewed_at: number | null;
  reviewed_by: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

type Db = DatabaseSync;
type Row = Record<string, unknown>;

export function ensureAgentMemorySchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('fact','lesson')),
    scope TEXT NOT NULL CHECK(scope IN ('global','business','project')),
    business TEXT CHECK(business IS NULL OR business IN (${BUSINESS_SQL_LIST})),
    project_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source_agent_id TEXT,
    source_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    reviewed_at INTEGER,
    reviewed_by TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(scope != 'business' OR business IS NOT NULL),
    CHECK(scope != 'project' OR project_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(status, scope, business, project_id);
  CREATE INDEX IF NOT EXISTS idx_agent_memories_task ON agent_memories(source_task_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
    title, body, content='agent_memories', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS agent_memories_ai AFTER INSERT ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_memories_ad AFTER DELETE ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_memories_au AFTER UPDATE OF title, body ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO agent_memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;`);
}

function fail(message: string): never {
  throw new Error(message);
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bEAA[A-Za-z0-9]{40,}/, // Square / Meta style long access tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /\b(?:password|passwd|pwd|passphrase|secret|token|api[ _-]?key|access[ _-]?token|auth[ _-]?token|private[ _-]?key)\s*[:=]\s*\S{4,}/i,
];

/** True when the text looks like it contains a credential. Memories must never hold secrets. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function cleanText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.includes("\0")) fail(`invalid_memory_${field}`);
  const text = (value as string).replace(/\r\n/g, "\n").trim();
  if (!text || text.length > max) fail(`invalid_memory_${field}`);
  return text;
}

function rowToMemory(row: Row): AgentMemory {
  return row as unknown as AgentMemory;
}

export function getMemory(db: Db, id: string): AgentMemory | null {
  const row = db.prepare("SELECT * FROM agent_memories WHERE id=?").get(id) as Row | undefined;
  return row ? rowToMemory(row) : null;
}

export interface MemoryInput {
  kind?: unknown;
  scope?: unknown;
  business?: unknown;
  project_id?: unknown;
  title?: unknown;
  body?: unknown;
}

function scopeValues(input: MemoryInput) {
  const kind = input.kind ?? "lesson";
  if (!(MEMORY_KINDS as readonly unknown[]).includes(kind)) fail("invalid_memory_kind");
  const scope = input.scope ?? "global";
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(scope)) fail("invalid_memory_scope");
  let business: BusinessKey | null = null;
  let projectId: string | null = null;
  if (scope === "business") {
    if (!isBusinessKey(input.business)) fail("memory_business_required");
    business = input.business as BusinessKey;
  } else if (input.business !== undefined && input.business !== null && input.business !== "") {
    if (!isBusinessKey(input.business)) fail("invalid_business");
    business = input.business as BusinessKey;
  }
  if (scope === "project") {
    if (typeof input.project_id !== "string" || !input.project_id.trim()) fail("memory_project_required");
    projectId = (input.project_id as string).trim().slice(0, 128);
  }
  return { kind: kind as MemoryKind, scope: scope as MemoryScope, business, projectId };
}

/**
 * Add a memory. Agents are limited to a few per task; a memory with the same title in the same scope is refused
 * (update the existing one instead), and anything that looks like a credential is refused.
 */
export function addMemory(
  db: Db,
  input: MemoryInput,
  author: { agentId?: string | null; taskId?: string | null; reviewedBy?: string | null } = {},
  now = Date.now(),
): AgentMemory {
  ensureAgentMemorySchema(db);
  const { kind, scope, business, projectId } = scopeValues(input);
  const title = cleanText(input.title, "title", MEMORY_TITLE_MAX);
  const body = cleanText(input.body, "body", MEMORY_BODY_MAX);
  if (looksLikeSecret(`${title}\n${body}`)) fail("memory_looks_like_secret");
  if (author.taskId) {
    const written = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE source_task_id=?").get(author.taskId) as Row).n,
    );
    if (written >= MEMORY_WRITES_PER_TASK) fail("memory_task_limit_reached");
  }
  const sameScope = db
    .prepare(
      `SELECT id, title FROM agent_memories WHERE status='active' AND scope=?
       AND COALESCE(business,'')=COALESCE(?,'') AND COALESCE(project_id,'')=COALESCE(?,'')`,
    )
    .all(scope, business, projectId) as Array<{ id: string; title: string }>;
  const key = normalizeTitle(title);
  if (sameScope.some((row) => normalizeTitle(row.title) === key)) fail("memory_duplicate");
  const id = randomUUID();
  const reviewed = author.reviewedBy ? now : null;
  db.prepare(
    `INSERT INTO agent_memories (id,kind,scope,business,project_id,title,body,source_agent_id,source_task_id,status,
       reviewed_at,reviewed_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
  ).run(
    id,
    kind,
    scope,
    business,
    projectId,
    title,
    body,
    author.agentId ?? null,
    author.taskId ?? null,
    reviewed,
    author.reviewedBy ?? null,
    now,
    now,
  );
  return getMemory(db, id)!;
}

/** Words from free text turned into a safe FTS5 query: each word quoted, prefix-matched, OR-ed. */
export function ftsQuery(text: string, maxWords = 16): string {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "your",
    "you",
    "are",
    "was",
    "will",
    "should",
    "task",
    "please",
    "make",
    "use",
  ]);
  const words: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const word = match[0];
    if (stop.has(word) || words.includes(word)) continue;
    words.push(word);
    if (words.length >= maxWords) break;
  }
  return words.map((word) => `"${word}"*`).join(" OR ");
}

export interface MemorySearch {
  query?: string;
  business?: BusinessKey | null;
  projectId?: string | null;
  limit?: number;
  /** Count this as a use (prompt injection or an agent's search). */
  bump?: boolean;
}

/**
 * Active memories that apply here: global ones, the business's, and the project's. Ranked by text relevance to the
 * query when there is one (most recent first otherwise); reviewed memories win ties.
 */
export function searchMemories(db: Db, search: MemorySearch, now = Date.now()): AgentMemory[] {
  ensureAgentMemorySchema(db);
  const limit = Math.max(1, Math.min(20, Math.floor(search.limit ?? 5)));
  const scopeSql = `m.status='active' AND (m.scope='global'
    OR (m.scope='business' AND m.business IS ?)
    OR (m.scope='project' AND m.project_id IS ?))`;
  const business = search.business ?? null;
  const projectId = search.projectId ?? null;
  const match = search.query ? ftsQuery(search.query) : "";
  let rows: Row[];
  if (match) {
    rows = db
      .prepare(
        `SELECT m.* FROM agent_memories_fts f JOIN agent_memories m ON m.rowid = f.rowid
         WHERE agent_memories_fts MATCH ? AND ${scopeSql}
         ORDER BY bm25(agent_memories_fts), (m.reviewed_at IS NULL), m.updated_at DESC LIMIT ?`,
      )
      .all(match, business, projectId, limit) as Row[];
  } else {
    rows = db
      .prepare(
        `SELECT m.* FROM agent_memories m WHERE ${scopeSql}
         ORDER BY (m.reviewed_at IS NULL), m.updated_at DESC LIMIT ?`,
      )
      .all(business, projectId, limit) as Row[];
  }
  const memories = rows.map(rowToMemory);
  if (search.bump && memories.length) {
    const bump = db.prepare("UPDATE agent_memories SET use_count=use_count+1, last_used_at=? WHERE id=?");
    for (const memory of memories) bump.run(now, memory.id);
  }
  return memories;
}

export interface MemoryFilter {
  status?: string;
  business?: string;
  reviewed?: "yes" | "no";
  query?: string;
}

/** Owner view: newest first, with the agent's name. */
export function listMemories(db: Db, filter: MemoryFilter = {}) {
  ensureAgentMemorySchema(db);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.status) {
    if (!(MEMORY_STATUSES as readonly string[]).includes(filter.status)) fail("invalid_memory_status");
    where.push("m.status=?");
    args.push(filter.status);
  }
  if (filter.business) {
    if (!isBusinessKey(filter.business)) fail("invalid_business");
    where.push("m.business=?");
    args.push(filter.business);
  }
  if (filter.reviewed === "yes") where.push("m.reviewed_at IS NOT NULL");
  if (filter.reviewed === "no") where.push("m.reviewed_at IS NULL");
  let join = "";
  if (filter.query) {
    const match = ftsQuery(filter.query);
    if (match) {
      join = "JOIN agent_memories_fts f ON f.rowid = m.rowid";
      where.push("agent_memories_fts MATCH ?");
      args.push(match);
    }
  }
  const hasAgents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get();
  const hasTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  const rows = db
    .prepare(
      `SELECT m.*, ${hasAgents ? "a.name" : "NULL"} AS source_agent_name, ${hasTasks ? "t.title" : "NULL"} AS source_task_title
       FROM agent_memories m ${join}
       ${hasAgents ? "LEFT JOIN agents a ON a.id = m.source_agent_id" : ""}
       ${hasTasks ? "LEFT JOIN tasks t ON t.id = m.source_task_id" : ""}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.status='archived', (m.reviewed_at IS NOT NULL), m.created_at DESC LIMIT 300`,
    )
    .all(...args) as Row[];
  const counts = db
    .prepare(
      `SELECT SUM(status='active') AS active, SUM(status='active' AND reviewed_at IS NULL) AS unreviewed,
              SUM(status='archived') AS archived FROM agent_memories`,
    )
    .get() as Row;
  return {
    items: rows as unknown as Array<
      AgentMemory & { source_agent_name: string | null; source_task_title: string | null }
    >,
    counts: {
      active: Number(counts.active ?? 0),
      unreviewed: Number(counts.unreviewed ?? 0),
      archived: Number(counts.archived ?? 0),
    },
  };
}

/** Owner edit. Editing counts as a review: the owner has read and corrected it. */
export function updateMemory(db: Db, id: string, input: MemoryInput, now = Date.now()): AgentMemory {
  ensureAgentMemorySchema(db);
  const current = getMemory(db, id) ?? fail("memory_not_found");
  const allowed = ["kind", "scope", "business", "project_id", "title", "body"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) fail("memory_protected_field");
  const merged = { ...current, ...input } as MemoryInput;
  const { kind, scope, business, projectId } = scopeValues(merged);
  const title = cleanText(merged.title, "title", MEMORY_TITLE_MAX);
  const body = cleanText(merged.body, "body", MEMORY_BODY_MAX);
  if (looksLikeSecret(`${title}\n${body}`)) fail("memory_looks_like_secret");
  db.prepare(
    `UPDATE agent_memories SET kind=?, scope=?, business=?, project_id=?, title=?, body=?, reviewed_at=?, reviewed_by='owner',
       updated_at=? WHERE id=?`,
  ).run(kind, scope, business, projectId, title, body, now, now, id);
  return getMemory(db, id)!;
}

export function reviewMemory(db: Db, id: string, now = Date.now()): AgentMemory {
  ensureAgentMemorySchema(db);
  if (!getMemory(db, id)) fail("memory_not_found");
  db.prepare("UPDATE agent_memories SET reviewed_at=?, reviewed_by='owner', updated_at=? WHERE id=?").run(now, now, id);
  return getMemory(db, id)!;
}

export function setMemoryStatus(db: Db, id: string, status: unknown, now = Date.now()): AgentMemory {
  ensureAgentMemorySchema(db);
  if (!(MEMORY_STATUSES as readonly unknown[]).includes(status)) fail("invalid_memory_status");
  if (!getMemory(db, id)) fail("memory_not_found");
  db.prepare("UPDATE agent_memories SET status=?, updated_at=? WHERE id=?").run(status as string, now, id);
  return getMemory(db, id)!;
}
