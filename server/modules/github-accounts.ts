import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";

/**
 * GitHub accounts for repository work, one per business or personal, each with its own fine-grained token.
 *
 * Separate from the GitHub sign-in used for Copilot models (oauth_accounts), so adding a repo account can never change
 * which account Copilot uses. A project picks its account; otherwise the default for the project's business is used,
 * then the personal default. Git gets the token only through its process environment for that one command: it is never
 * written into a remote URL or git config, and Git Credential Manager (the PC's own login) is switched off for it.
 */
export interface GitHubAccount {
  id: string;
  label: string;
  business: BusinessKey | null;
  login: string | null;
  is_default: number;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
type Row = Record<string, unknown>;

export function ensureGitHubAccountSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS github_accounts (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    business TEXT CHECK(business IS NULL OR business IN (${BUSINESS_SQL_LIST})),
    login TEXT,
    token_enc TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
    last_test_at INTEGER,
    last_test_ok INTEGER CHECK(last_test_ok IN (0,1)),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_github_accounts_default
    ON github_accounts(COALESCE(business,'personal')) WHERE is_default=1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_github_accounts_label ON github_accounts(lower(label));`);
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (projectColumns.length && !projectColumns.some((column) => column.name === "github_account_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN github_account_id TEXT");
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/** Without the token, ever. */
function safe(row: Row): GitHubAccount & { has_token: boolean } {
  const { token_enc, ...rest } = row;
  return { ...(rest as unknown as GitHubAccount), has_token: Boolean(token_enc) };
}

export function listGitHubAccounts(db: DatabaseSync) {
  ensureGitHubAccountSchema(db);
  return (
    db.prepare("SELECT * FROM github_accounts ORDER BY COALESCE(business,'~'), is_default DESC, label").all() as Row[]
  ).map(safe);
}

export function getGitHubAccount(db: DatabaseSync, id: string) {
  ensureGitHubAccountSchema(db);
  const row = db.prepare("SELECT * FROM github_accounts WHERE id=?").get(id) as Row | undefined;
  return row ? safe(row) : null;
}

function validToken(token: string): boolean {
  return token.length >= 20 && token.length <= 400 && /^[A-Za-z0-9_]+$/.test(token);
}

/** Create or update an account. `token` is only stored, never returned; blank keeps the saved one. */
export function saveGitHubAccount(db: DatabaseSync, id: string | null, input: unknown, now = Date.now()) {
  ensureGitHubAccountSchema(db);
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_payload");
  const body = input as Record<string, unknown>;
  const allowed = ["label", "business", "token", "is_default"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail("invalid_github_account_field");
  const current = id ? (db.prepare("SELECT * FROM github_accounts WHERE id=?").get(id) as Row | undefined) : undefined;
  if (id && !current) fail("github_account_not_found");
  const label = typeof (body.label ?? current?.label) === "string" ? String(body.label ?? current?.label).trim() : "";
  if (!label || label.length > 80) fail("invalid_label");
  let business: BusinessKey | null = (current?.business as BusinessKey | null) ?? null;
  if ("business" in body) {
    if (body.business === null || body.business === "" || body.business === "personal") business = null;
    else if (isBusinessKey(body.business)) business = body.business;
    else fail("invalid_business");
  }
  if ("is_default" in body && typeof body.is_default !== "boolean") fail("invalid_default_flag");
  let tokenEnc = (current?.token_enc as string | undefined) ?? "";
  if ("token" in body && body.token !== "") {
    if (typeof body.token !== "string" || !validToken(body.token.trim())) fail("invalid_github_token");
    tokenEnc = encryptSecret(body.token.trim());
  }
  if (!tokenEnc) fail("github_token_required");
  const scopeKey = business ?? "personal";
  const otherDefault = db
    .prepare("SELECT id FROM github_accounts WHERE COALESCE(business,'personal')=? AND is_default=1 AND id!=?")
    .get(scopeKey, id ?? "") as Row | undefined;
  const isDefault = body.is_default === true || (!otherDefault && body.is_default !== false) ? 1 : 0;
  const tokenChanged = "token" in body && body.token !== "";
  const accountId = id ?? randomUUID();
  db.exec("SAVEPOINT github_account_save");
  try {
    if (isDefault)
      db.prepare("UPDATE github_accounts SET is_default=0 WHERE COALESCE(business,'personal')=? AND id!=?").run(
        scopeKey,
        accountId,
      );
    if (current) {
      db.prepare(
        `UPDATE github_accounts SET label=?, business=?, token_enc=?, is_default=?, updated_at=?
         ${tokenChanged ? ", login=NULL, last_test_at=NULL, last_test_ok=NULL, last_error=NULL" : ""} WHERE id=?`,
      ).run(label, business, tokenEnc, isDefault, now, accountId);
    } else {
      db.prepare(
        `INSERT INTO github_accounts (id,label,business,token_enc,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(accountId, label, business, tokenEnc, isDefault, now, now);
    }
    db.exec("RELEASE github_account_save");
  } catch (error) {
    db.exec("ROLLBACK TO github_account_save; RELEASE github_account_save");
    if (error instanceof Error && /UNIQUE/.test(error.message)) fail("github_account_label_exists");
    throw error;
  }
  return getGitHubAccount(db, accountId)!;
}

export function deleteGitHubAccount(db: DatabaseSync, id: string): void {
  ensureGitHubAccountSchema(db);
  if (!db.prepare("SELECT 1 FROM github_accounts WHERE id=?").get(id)) fail("github_account_not_found");
  db.prepare("UPDATE projects SET github_account_id=NULL WHERE github_account_id=?").run(id);
  db.prepare("DELETE FROM github_accounts WHERE id=?").run(id);
}

export function githubAccountToken(db: DatabaseSync, id: string): string | null {
  ensureGitHubAccountSchema(db);
  const row = db.prepare("SELECT token_enc FROM github_accounts WHERE id=?").get(id) as Row | undefined;
  if (!row?.token_enc) return null;
  try {
    return decryptSecret(String(row.token_enc));
  } catch {
    return null;
  }
}

/** Signs in to GitHub with the token (GET /user) and records the login it belongs to. Changes nothing on GitHub. */
export async function testGitHubAccount(
  db: DatabaseSync,
  id: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const token = githubAccountToken(db, id) ?? fail("github_token_required");
  let ok = false;
  let login: string | null = null;
  let error: string | null = null;
  try {
    const response = await fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ATLAS" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const data = (await response.json()) as { login?: unknown };
      login = typeof data.login === "string" ? data.login.slice(0, 100) : null;
      ok = Boolean(login);
      if (!ok) error = "github_unexpected_response";
    } else error = response.status === 401 ? "github_token_rejected" : `github_http_${response.status}`;
  } catch {
    error = "github_unreachable";
  }
  db.prepare(
    "UPDATE github_accounts SET last_test_at=?, last_test_ok=?, last_error=?, login=COALESCE(?, login) WHERE id=?",
  ).run(now, ok ? 1 : 0, error, login, id);
  return { ok, login, error, account: getGitHubAccount(db, id)! };
}

export interface ResolvedGitHubAccount {
  account: (GitHubAccount & { has_token: boolean }) | null;
  /** How it was chosen, or why none was. */
  reason: string;
}

/** The account for a project: its own, else its business's default, else the personal default. Never the PC login. */
export function resolveGitHubAccountForProject(db: DatabaseSync, projectId: string | null): ResolvedGitHubAccount {
  ensureGitHubAccountSchema(db);
  const project = projectId
    ? (db.prepare("SELECT github_account_id, business FROM projects WHERE id=?").get(projectId) as Row | undefined)
    : undefined;
  if (project?.github_account_id) {
    const own = getGitHubAccount(db, String(project.github_account_id));
    if (own) return { account: own, reason: "the project's GitHub account" };
  }
  const business = isBusinessKey(project?.business) ? project.business : null;
  if (business) {
    const row = db.prepare("SELECT * FROM github_accounts WHERE business=? AND is_default=1").get(business) as
      | Row
      | undefined;
    if (row) return { account: safe(row), reason: `the default ${business} GitHub account` };
  }
  const personal = db.prepare("SELECT * FROM github_accounts WHERE business IS NULL AND is_default=1").get() as
    | Row
    | undefined;
  if (personal) return { account: safe(personal), reason: "the personal GitHub account" };
  return {
    account: null,
    reason: business
      ? `no GitHub account is set for this project or the ${business} business, and there is no personal one`
      : "no GitHub account is set for this project and there is no personal one",
  };
}

/**
 * Environment for one git command that talks to GitHub with this token. The token travels as an HTTP header in the
 * environment of that process only; the credential helper (Git Credential Manager, the PC's own login) is disabled
 * and git may not prompt.
 */
export function gitHubAuthEnv(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

export function isValidRepoName(repo: string): boolean {
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) && !repo.endsWith(".git");
}

export function plainRepoUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/** If an older version saved a token inside `origin`, put the plain URL back. Returns true when it fixed one. */
export function scrubTokenFromOrigin(projectPath: string, repo: string): boolean {
  try {
    const current = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    if (!/@github\.com/i.test(current) || !/https:\/\/[^@/]+@/i.test(current)) return false;
    execFileSync("git", ["remote", "set-url", "origin", plainRepoUrl(repo)], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Pushes one branch to the repo as this account. Throws with git's message (token removed) on failure. */
export function pushBranchAs(
  projectPath: string,
  repo: string,
  branch: string,
  token: string,
  remoteUrl?: string,
): void {
  if (!isValidRepoName(repo) && !remoteUrl) fail("invalid_github_repo");
  try {
    execFileSync("git", ["push", remoteUrl ?? plainRepoUrl(repo), `${branch}:${branch}`], {
      cwd: projectPath,
      stdio: "pipe",
      timeout: 120_000,
      env: gitHubAuthEnv(token),
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr ?? "")
        : "";
    throw new Error(`git push failed: ${stderr.replaceAll(token, "***").trim().slice(-400) || "unknown error"}`);
  }
}

/** Opens a pull request from `head` to `base`, or reports the open one. Never merges. */
export async function openPullRequest(
  repo: string,
  token: string,
  input: { head: string; base: string; title: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string | null; created: boolean; error?: string }> {
  const [owner] = repo.split("/");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "ATLAS",
  };
  try {
    const list = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&state=open`,
      { headers, signal: AbortSignal.timeout(20_000) },
    );
    const existing = list.ok ? ((await list.json()) as Array<{ html_url?: string }>) : [];
    if (Array.isArray(existing) && existing[0]?.html_url) return { url: existing[0].html_url, created: false };
    const created = await fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    });
    if (!created.ok) return { url: null, created: false, error: `github_http_${created.status}` };
    const data = (await created.json()) as { html_url?: string };
    return { url: data.html_url ?? null, created: true };
  } catch {
    return { url: null, created: false, error: "github_unreachable" };
  }
}
