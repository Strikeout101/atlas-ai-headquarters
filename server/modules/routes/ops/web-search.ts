import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import { ensureWebSearchSchema, saveWebSearchSettings, testWebSearch, webSearchSettings } from "../../web-search.ts";

/** Owner-only: which search service agents use for web.search, its key (never returned) and its monthly cap. */
export function registerWebSearchRoutes(app: Express, db: DatabaseSync): void {
  ensureWebSearchSchema(db);
  app.use("/api/web-search", (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (!requireOwnerSession(req, res)) return;
    if (req.method !== "GET" && shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    next();
  });
  const send = (res: Response, work: () => unknown | Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then((value) => res.json({ ok: true, ...(value as object) }))
      .catch((error: unknown) => {
        const status = (error as { status?: number }).status;
        res
          .status(typeof status === "number" && status >= 400 ? status : 400)
          .json({ error: error instanceof Error ? error.message : "web_search_failed" });
      });
  app.get("/api/web-search", (_req: Request, res: Response) => send(res, () => ({ settings: webSearchSettings(db) })));
  app.patch("/api/web-search", (req: Request, res: Response) =>
    send(res, () => ({ settings: saveWebSearchSettings(db, (req.body ?? {}) as Record<string, unknown>) })),
  );
  app.post("/api/web-search/test", (_req: Request, res: Response) => send(res, () => testWebSearch(db)));
}
