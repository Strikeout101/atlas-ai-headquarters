import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  deleteGitHubAccount,
  ensureGitHubAccountSchema,
  listGitHubAccounts,
  resolveGitHubAccountForProject,
  saveGitHubAccount,
  testGitHubAccount,
} from "../../github-accounts.ts";
import { decideCodePush, ensureCodePushSchema, getCodePush } from "../../code-pushes.ts";

function owner(req: Request, res: Response): boolean {
  if (!requireOwnerSession(req, res)) return false;
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}

function statusFor(message: string): number {
  if (message.endsWith("_not_found")) return 404;
  if (message.endsWith("already_decided") || message === "github_account_label_exists") return 409;
  return 400;
}

/** Owner-only GitHub repo accounts and decisions on queued code pushes. Tokens are never returned. */
export function registerGitHubAccountRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
  deps: { fetch?: typeof fetch } = {},
): void {
  ensureGitHubAccountSchema(db);
  ensureCodePushSchema(db);
  for (const base of ["/api/github-accounts", "/api/code-pushes"]) {
    app.use(base, (req, res, next) => {
      if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
      next();
    });
  }
  const run = (res: Response, work: () => unknown, created = false) => {
    try {
      const item = work();
      broadcast("github_accounts_changed", {});
      return res.status(created ? 201 : 200).json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "github_account_request_failed";
      return res.status(statusFor(message)).json({ error: message });
    }
  };

  app.get("/api/github-accounts", (_req, res) => res.json({ ok: true, items: listGitHubAccounts(db) }));
  app.get("/api/github-accounts/for-project/:projectId", (req, res) => {
    const resolved = resolveGitHubAccountForProject(db, String(req.params.projectId));
    return res.json({ ok: true, account: resolved.account, reason: resolved.reason });
  });
  app.post("/api/github-accounts", (req, res) => {
    if (!owner(req, res)) return;
    return run(res, () => saveGitHubAccount(db, null, req.body), true);
  });
  app.patch("/api/github-accounts/:id", (req, res) => {
    if (!owner(req, res)) return;
    return run(res, () => saveGitHubAccount(db, String(req.params.id), req.body));
  });
  app.delete("/api/github-accounts/:id", (req, res) => {
    if (!owner(req, res)) return;
    return run(res, () => {
      deleteGitHubAccount(db, String(req.params.id));
      return { id: String(req.params.id) };
    });
  });
  app.post("/api/github-accounts/:id/test", async (req, res) => {
    if (!owner(req, res)) return;
    try {
      const result = await testGitHubAccount(db, String(req.params.id), deps.fetch ?? fetch);
      broadcast("github_accounts_changed", {});
      return res.json({ ...result, ok: true, connected: result.ok });
    } catch (error) {
      const message = error instanceof Error ? error.message : "github_test_failed";
      return res.status(statusFor(message)).json({ error: message });
    }
  });

  app.get("/api/code-pushes/:id", (req, res) => {
    const item = getCodePush(db, String(req.params.id));
    return item ? res.json({ ok: true, item }) : res.status(404).json({ error: "code_push_not_found" });
  });
  app.post("/api/code-pushes/:id/decide", async (req, res) => {
    if (!owner(req, res)) return;
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    try {
      const item = await decideCodePush(db, String(req.params.id), req.body.approve, "owner");
      broadcast("approvals_changed", {});
      return res.json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "code_push_failed";
      return res.status(statusFor(message)).json({ error: message });
    }
  });
}
