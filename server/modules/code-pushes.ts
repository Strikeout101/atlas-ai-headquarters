import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { businessPolicy } from "./business-policies.ts";
import {
  githubAccountToken,
  openPullRequest,
  pushBranchAs,
  resolveGitHubAccountForProject,
  scrubTokenFromOrigin,
} from "./github-accounts.ts";

/**
 * Pushing reviewed work to GitHub. After a task passes review its branch is merged into the project's `dev` branch
 * locally; this module decides whether that push happens now or waits for approval (the business's `code_pushes`
 * setting), and performs it with the project's own GitHub account. It always opens or reuses a dev -> main pull
 * request and never merges into main.
 */
export interface CodePushRequest {
  id: string;
  project_id: string;
  task_id: string | null;
  business: BusinessKey | null;
  github_repo: string;
  project_path: string;
  branch: string;
  account_id: string;
  title: string;
  status: "pending" | "pushed" | "denied" | "failed";
  pr_url: string | null;
  error_code: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}
type Row = Record<string, unknown>;

export function ensureCodePushSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS code_push_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    business TEXT CHECK(business IS NULL OR business IN (${BUSINESS_SQL_LIST})),
    github_repo TEXT NOT NULL,
    project_path TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'dev',
    account_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pushed','denied','failed')),
    pr_url TEXT,
    error_code TEXT,
    decided_by TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_code_push_requests_status ON code_push_requests(status, created_at DESC);`);
}

export function getCodePush(db: DatabaseSync, id: string): CodePushRequest | null {
  ensureCodePushSchema(db);
  return (db.prepare("SELECT * FROM code_push_requests WHERE id=?").get(id) as CodePushRequest | undefined) ?? null;
}

export interface PushPlan {
  /** "push" now, "queue" for approval, or "skip" (merged locally only). */
  action: "push" | "queue" | "skip";
  reason: string;
  accountId: string | null;
  business: BusinessKey | null;
}

/** What should happen to reviewed work for this project. */
export function planCodePush(db: DatabaseSync, projectId: string | null): PushPlan {
  const project = projectId
    ? (db.prepare("SELECT business FROM projects WHERE id=?").get(projectId) as Row | undefined)
    : undefined;
  const business = isBusinessKey(project?.business) ? project.business : null;
  const resolved = resolveGitHubAccountForProject(db, projectId);
  if (!resolved.account) return { action: "skip", reason: resolved.reason, accountId: null, business };
  const gate = business ? businessPolicy(business).code_pushes : "none";
  return {
    action: gate === "none" ? "push" : "queue",
    reason:
      gate === "none"
        ? `pushing with ${resolved.reason}`
        : `pushes for ${business} need ${gate === "vp" ? "VP" : "owner"} approval`,
    accountId: resolved.account.id,
    business,
  };
}

export function queueCodePush(
  db: DatabaseSync,
  input: Omit<CodePushRequest, "id" | "status" | "pr_url" | "error_code" | "decided_by" | "decided_at" | "created_at">,
  now = Date.now(),
): CodePushRequest {
  ensureCodePushSchema(db);
  // One pending push per project and branch: later reviewed work rides along on the same branch.
  const pending = db
    .prepare("SELECT id FROM code_push_requests WHERE status='pending' AND project_id=? AND branch=?")
    .get(input.project_id, input.branch) as Row | undefined;
  if (pending) return getCodePush(db, String(pending.id))!;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO code_push_requests (id,project_id,task_id,business,github_repo,project_path,branch,account_id,title,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.project_id,
    input.task_id,
    input.business,
    input.github_repo,
    input.project_path,
    input.branch,
    input.account_id,
    input.title,
    now,
  );
  return getCodePush(db, id)!;
}

export interface PushDeps {
  push?: typeof pushBranchAs;
  openPr?: typeof openPullRequest;
  log?: (taskId: string | null, message: string) => void;
}

/** Push the branch with the account and open (or reuse) the pull request. Returns the PR address if known. */
export async function performCodePush(
  db: DatabaseSync,
  input: { projectPath: string; repo: string; branch: string; accountId: string; title: string; taskId: string | null },
  deps: PushDeps = {},
): Promise<{ prUrl: string | null }> {
  const token = githubAccountToken(db, input.accountId);
  if (!token) throw new Error("github_token_unavailable");
  if (scrubTokenFromOrigin(input.projectPath, input.repo))
    deps.log?.(input.taskId, "Removed a saved GitHub token from the project's origin remote.");
  (deps.push ?? pushBranchAs)(input.projectPath, input.repo, input.branch, token);
  const pr = await (deps.openPr ?? openPullRequest)(input.repo, token, {
    head: input.branch,
    base: "main",
    title: `[ATLAS] ${input.title}`.slice(0, 250),
    body: `Reviewed and approved in ATLAS.${input.taskId ? `\n\nTask: ${input.taskId.slice(0, 8)}` : ""}`,
  });
  if (pr.url) deps.log?.(input.taskId, `GitHub pull request ${pr.created ? "created" : "updated"}: ${pr.url}`);
  else if (pr.error) deps.log?.(input.taskId, `Pushed, but the pull request could not be opened (${pr.error}).`);
  return { prUrl: pr.url };
}

/** Owner or VP decision on a queued push. Claimed before pushing, so it runs at most once. */
export async function decideCodePush(
  db: DatabaseSync,
  id: string,
  approve: boolean,
  decidedBy = "owner",
  deps: PushDeps = {},
  now = Date.now(),
): Promise<CodePushRequest> {
  const request = getCodePush(db, id);
  if (!request) throw new Error("code_push_not_found");
  const claim = db
    .prepare("UPDATE code_push_requests SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'")
    .run(approve ? "pushed" : "denied", decidedBy, now, id);
  if (!claim.changes) throw new Error("code_push_already_decided");
  if (!approve) return getCodePush(db, id)!;
  try {
    const { prUrl } = await performCodePush(
      db,
      {
        projectPath: request.project_path,
        repo: request.github_repo,
        branch: request.branch,
        accountId: request.account_id,
        title: request.title,
        taskId: request.task_id,
      },
      deps,
    );
    db.prepare("UPDATE code_push_requests SET pr_url=? WHERE id=?").run(prUrl, id);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 300) : "code_push_failed";
    db.prepare("UPDATE code_push_requests SET status='failed', error_code=? WHERE id=?").run(code, id);
    throw error;
  }
  return getCodePush(db, id)!;
}
