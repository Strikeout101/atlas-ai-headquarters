import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real git repositories: a few seconds each, longer while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { getCsrfToken } from "../security/auth.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import { agentEnvironment } from "../security/agent-environment.ts";
import {
  ensureGitHubAccountSchema,
  gitHubAuthEnv,
  githubAccountToken,
  listGitHubAccounts,
  pushBranchAs,
  resolveGitHubAccountForProject,
  saveGitHubAccount,
  scrubTokenFromOrigin,
  testGitHubAccount,
} from "./github-accounts.ts";
import { decideCodePush, ensureCodePushSchema, planCodePush, queueCodePush } from "./code-pushes.ts";
import { ensureBusinessPolicySchema, resetBusinessPoliciesForTests, saveBusinessPolicy } from "./business-policies.ts";
import { registerGitHubAccountRoutes } from "./routes/ops/github-accounts.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { approvalRoute } from "./approval-review-state.ts";

const TOKEN_A = "github_pat_" + "A".repeat(40);
const TOKEN_B = "github_pat_" + "B".repeat(40);
const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  resetBusinessPoliciesForTests();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec("ALTER TABLE projects ADD COLUMN github_repo TEXT");
  ensureGitHubAccountSchema(db);
  ensureCodePushSchema(db);
  ensureBusinessPolicySchema(db);
  db.exec(`INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at,business,github_repo)
      VALUES ('p-rental','Primrose site','C:/sites/primrose','Bookings',1,1,'rental','primrose/site'),
             ('p-tech','SBT site','C:/sites/sbt','Leads',1,1,'tech','strikeout/sbt'),
             ('p-none','Tools','C:/tools','Internal',1,1,NULL,'strikeout/tools');`);
  return db;
}

describe("GitHub accounts", () => {
  it("stores tokens encrypted, never returns them, and keeps one default per business", () => {
    const db = harness();
    const primrose = saveGitHubAccount(db, null, { label: "Primrose", business: "rental", token: TOKEN_A });
    const personal = saveGitHubAccount(db, null, { label: "Personal", business: "personal", token: TOKEN_B });
    expect(primrose).toMatchObject({ business: "rental", is_default: 1, has_token: true });
    expect(personal).toMatchObject({ business: null, is_default: 1 });
    expect(JSON.stringify(listGitHubAccounts(db))).not.toContain(TOKEN_A);
    const stored = db.prepare("SELECT token_enc FROM github_accounts WHERE id=?").get(primrose.id) as {
      token_enc: string;
    };
    expect(stored.token_enc).not.toContain(TOKEN_A);
    expect(githubAccountToken(db, primrose.id)).toBe(TOKEN_A);

    const second = saveGitHubAccount(db, null, { label: "Primrose backup", business: "rental", token: TOKEN_B });
    expect(second.is_default).toBe(0);
    saveGitHubAccount(db, second.id, { is_default: true });
    expect(db.prepare("SELECT label FROM github_accounts WHERE business='rental' AND is_default=1").all()).toEqual([
      { label: "Primrose backup" },
    ]);
    // A blank token keeps the saved one.
    saveGitHubAccount(db, primrose.id, { label: "Primrose LLC", token: "" });
    expect(githubAccountToken(db, primrose.id)).toBe(TOKEN_A);

    expect(() => saveGitHubAccount(db, null, { label: "Bad", token: "short" })).toThrow("invalid_github_token");
    expect(() => saveGitHubAccount(db, null, { label: "No token" })).toThrow("github_token_required");
    expect(() => saveGitHubAccount(db, null, { label: "primrose llc", token: TOKEN_A })).toThrow(
      "github_account_label_exists",
    );
    expect(() => saveGitHubAccount(db, null, { label: "X", business: "mars", token: TOKEN_A })).toThrow(
      "invalid_business",
    );
  });

  it("picks the project's account, then its business default, then the personal default, never the PC login", () => {
    const db = harness();
    expect(resolveGitHubAccountForProject(db, "p-rental").account).toBeNull();
    expect(resolveGitHubAccountForProject(db, "p-rental").reason).toMatch(/no GitHub account/);
    const personal = saveGitHubAccount(db, null, { label: "Personal", token: TOKEN_B });
    expect(resolveGitHubAccountForProject(db, "p-rental").account?.id).toBe(personal.id);
    const primrose = saveGitHubAccount(db, null, { label: "Primrose", business: "rental", token: TOKEN_A });
    expect(resolveGitHubAccountForProject(db, "p-rental")).toMatchObject({
      account: { id: primrose.id },
      reason: "the default rental GitHub account",
    });
    expect(resolveGitHubAccountForProject(db, "p-tech").account?.id).toBe(personal.id);
    db.prepare("UPDATE projects SET github_account_id=? WHERE id='p-tech'").run(primrose.id);
    expect(resolveGitHubAccountForProject(db, "p-tech").reason).toBe("the project's GitHub account");
  });

  it("tests a token by signing in, records the login, and reports a rejected token", async () => {
    const db = harness();
    const account = saveGitHubAccount(db, null, { label: "Personal", token: TOKEN_B });
    const ok = vi.fn(async () => new Response(JSON.stringify({ login: "Strikeout101" }), { status: 200 }));
    const result = await testGitHubAccount(db, account.id, ok as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, login: "Strikeout101" });
    expect(ok).toHaveBeenCalledWith("https://api.github.com/user", expect.anything());
    const rejected = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await testGitHubAccount(db, account.id, rejected as unknown as typeof fetch)).toMatchObject({
      ok: false,
      error: "github_token_rejected",
    });
    expect(listGitHubAccounts(db)[0]).toMatchObject({ login: "Strikeout101", last_test_ok: 0 });
  });
});

describe("git credentials", () => {
  function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
    return execFileSync("git", args, { cwd, stdio: "pipe", env: env ?? process.env })
      .toString()
      .trim();
  }
  function helperEntries(cwd: string, env: NodeJS.ProcessEnv) {
    const out = execFileSync("git", ["config", "--show-scope", "--get-all", "credential.helper"], {
      cwd,
      stdio: "pipe",
      env,
    }).toString();
    return out.replace(/\n$/, "").split("\n");
  }
  function repoPair() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-git-"));
    dirs.push(root);
    const remote = path.join(root, "remote.git");
    const work = path.join(root, "work");
    git(root, ["init", "--bare", "-b", "main", remote]);
    git(root, ["init", "-b", "main", work]);
    git(work, ["config", "user.email", "test@example.com"]);
    git(work, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(work, "a.txt"), "hello");
    git(work, ["add", "."]);
    git(work, ["commit", "-m", "first"]);
    git(work, ["branch", "dev"]);
    return { remote, work };
  }

  it("gives git the token only through its environment and switches off the PC's credential helper", () => {
    const env = gitHubAuthEnv(TOKEN_A, {});
    const { work } = repoPair();
    expect(helperEntries(work, env).at(-1)).toBe("command\t"); // empty helper from the command scope wins
    const header = git(work, ["config", "--get", "http.https://github.com/.extraheader"], env);
    expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN_A}`).toString("base64")}`);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    // Nothing is written to the repository's own config.
    expect(fs.readFileSync(path.join(work, ".git", "config"), "utf8")).not.toContain("extraheader");
  });

  it("pushes a branch to the remote without saving any credential", () => {
    const { remote, work } = repoPair();
    pushBranchAs(work, "owner/repo", "dev", TOKEN_A, remote);
    expect(git(remote, ["branch", "--list", "dev"])).toContain("dev");
    expect(fs.readFileSync(path.join(work, ".git", "config"), "utf8")).not.toContain(TOKEN_A);
  });

  it("removes a token an older version saved in origin, and leaves a plain origin alone", () => {
    const { work } = repoPair();
    git(work, ["remote", "add", "origin", `https://x-access-token:${TOKEN_A}@github.com/owner/repo.git`]);
    expect(scrubTokenFromOrigin(work, "owner/repo")).toBe(true);
    expect(git(work, ["remote", "get-url", "origin"])).toBe("https://github.com/owner/repo.git");
    expect(scrubTokenFromOrigin(work, "owner/repo")).toBe(false);
  });

  it("hides the token if a push fails", () => {
    const { work } = repoPair();
    expect(() => pushBranchAs(work, "owner/repo", "dev", TOKEN_A, path.join(work, "missing.git"))).toThrow(
      /git push failed/,
    );
    try {
      pushBranchAs(work, "owner/repo", "dev", TOKEN_A, path.join(work, "missing.git"));
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN_A);
    }
  });

  it("agents get no git credentials", () => {
    const env = agentEnvironment({ PATH: process.env.PATH });
    const { work } = repoPair();
    expect(helperEntries(work, env).at(-1)).toBe("command\t"); // empty helper from the command scope wins
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("code pushes", () => {
  it("pushes after review by default, queues when the business requires approval, and skips with no account", () => {
    const db = harness();
    expect(planCodePush(db, "p-tech")).toMatchObject({ action: "skip" });
    const personal = saveGitHubAccount(db, null, { label: "Personal", token: TOKEN_B });
    expect(planCodePush(db, "p-tech")).toMatchObject({ action: "push", accountId: personal.id });
    saveBusinessPolicy(db, "rental", { code_pushes: "owner" });
    expect(planCodePush(db, "p-rental")).toMatchObject({ action: "queue", business: "rental" });
    // A project with no business follows no gate.
    expect(planCodePush(db, "p-none")).toMatchObject({ action: "push" });
  });

  it("puts a queued push on the owner's list, pushes once when approved, and records the pull request", async () => {
    const db = harness();
    saveBusinessPolicy(db, "rental", { code_pushes: "owner" });
    const account = saveGitHubAccount(db, null, { label: "Primrose", business: "rental", token: TOKEN_A });
    const queued = queueCodePush(db, {
      project_id: "p-rental",
      task_id: null,
      business: "rental",
      github_repo: "primrose/site",
      project_path: "C:/sites/primrose",
      branch: "dev",
      account_id: account.id,
      title: "New flower wall section",
    });
    // A second reviewed task on the same branch rides along on the same request.
    expect(
      queueCodePush(db, {
        project_id: "p-rental",
        task_id: null,
        business: "rental",
        github_repo: "primrose/site",
        project_path: "C:/sites/primrose",
        branch: "dev",
        account_id: account.id,
        title: "Another change",
      }).id,
    ).toBe(queued.id);
    const [item] = listPendingApprovals(db, 100, "all").filter((entry) => entry.kind === "code_push");
    expect(item).toMatchObject({
      project_name: "Primrose site",
      github_repo: "primrose/site",
      account_label: "Primrose",
    });
    expect(approvalRoute(item)).toBe("owner");

    const push = vi.fn();
    const openPr = vi.fn(async () => ({ url: "https://github.com/primrose/site/pull/1", created: true }));
    const done = await decideCodePush(db, queued.id, true, "owner", { push, openPr });
    expect(push).toHaveBeenCalledWith("C:/sites/primrose", "primrose/site", "dev", TOKEN_A);
    expect(done).toMatchObject({ status: "pushed", pr_url: "https://github.com/primrose/site/pull/1" });
    await expect(decideCodePush(db, queued.id, true, "owner", { push, openPr })).rejects.toThrow(
      "code_push_already_decided",
    );
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("records a failed push", async () => {
    const db = harness();
    const account = saveGitHubAccount(db, null, { label: "Personal", token: TOKEN_B });
    const queued = queueCodePush(db, {
      project_id: "p-tech",
      task_id: null,
      business: "tech",
      github_repo: "strikeout/sbt",
      project_path: "C:/sites/sbt",
      branch: "dev",
      account_id: account.id,
      title: "x",
    });
    const push = vi.fn(() => {
      throw new Error("git push failed: rejected");
    });
    await expect(decideCodePush(db, queued.id, true, "owner", { push })).rejects.toThrow("rejected");
    expect(db.prepare("SELECT status FROM code_push_requests").get()).toEqual({ status: "failed" });
  });
});

describe("owner routes", () => {
  it("only the signed-in owner manages accounts; agents are refused; tokens never come back", async () => {
    const db = harness();
    const app = express();
    app.use(express.json());
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ login: "primrose-bot" }), { status: 200 }));
    registerGitHubAccountRoutes(app, db, () => {}, { fetch: fakeFetch as unknown as typeof fetch });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    const owner = (method: "post" | "patch" | "delete", url: string, body: Record<string, unknown> = {}) =>
      request(app)[method](url).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);

    await request(app).post("/api/github-accounts").send({ label: "x", token: TOKEN_A }).expect(403);
    await request(app).get("/api/github-accounts").set("x-agent-task-token", "x").expect(403);
    const created = await owner("post", "/api/github-accounts", {
      label: "Primrose",
      business: "rental",
      token: TOKEN_A,
    }).expect(201);
    expect(JSON.stringify(created.body)).not.toContain(TOKEN_A);
    const id = created.body.item.id;
    const tested = await owner("post", `/api/github-accounts/${id}/test`).expect(200);
    expect(tested.body).toMatchObject({ connected: true, login: "primrose-bot" });
    const list = await request(app).get("/api/github-accounts").expect(200);
    expect(JSON.stringify(list.body)).not.toContain(TOKEN_A);
    expect((await request(app).get("/api/github-accounts/for-project/p-rental").expect(200)).body.account.id).toBe(id);
    await owner("patch", `/api/github-accounts/${id}`, { token: "nope" }).expect(400);
    db.prepare("UPDATE projects SET github_account_id=? WHERE id='p-rental'").run(id);
    await owner("delete", `/api/github-accounts/${id}`).expect(200);
    expect(db.prepare("SELECT github_account_id FROM projects WHERE id='p-rental'").get()).toEqual({
      github_account_id: null,
    });
    await owner("delete", `/api/github-accounts/${id}`).expect(404);
  });
});
