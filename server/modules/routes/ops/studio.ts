import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import { getMediaAsset, searchMedia } from "../../media-library.ts";
import { ensureStudioSchema, saveStudioSettings, studioSettings, testStudioProvider } from "../../studio.ts";

function owner(req: Request, res: Response): boolean {
  if (!requireOwnerSession(req, res)) return false;
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Owner pages for the image studio (provider, monthly cap) and the media library (list and thumbnails). */
export function registerStudioRoutes(app: Express, db: DatabaseSync): void {
  ensureStudioSchema(db);
  for (const base of ["/api/studio", "/api/media"]) {
    app.use(base, (req, res, next) => {
      if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
      if (!requireOwnerSession(req, res)) return;
      next();
    });
  }
  const fail = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : "studio_request_failed";
    res.status(message.startsWith("studio_provider_failed") ? 502 : 400).json({ error: message });
  };
  app.get("/api/studio", (_req, res) => res.json({ ok: true, settings: studioSettings(db) }));
  app.patch("/api/studio", (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, settings: saveStudioSettings(db, (req.body ?? {}) as Record<string, unknown>) });
    } catch (error) {
      fail(res, error);
    }
  });
  app.post("/api/studio/test", async (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, models: (await testStudioProvider(db)).models });
    } catch (error) {
      fail(res, error);
    }
  });
  app.get("/api/media", (req, res) => {
    res.json({
      ok: true,
      items: searchMedia(db, {
        query: req.query.q,
        business: req.query.business,
        opportunity_id: req.query.opportunity_id,
        limit: 60,
      }),
    });
  });
  // The image itself, for thumbnails. Only files recorded in the library, inside their project or the data folder.
  app.get("/api/media/:id/file", (req, res) => {
    const asset = getMediaAsset(db, String(req.params.id));
    if (!asset) return res.status(404).json({ error: "media_not_found" });
    let root: string;
    if (asset.project_id) {
      const project = db.prepare("SELECT project_path FROM projects WHERE id=?").get(asset.project_id) as
        | { project_path: string }
        | undefined;
      if (!project?.project_path) return res.status(404).json({ error: "media_not_found" });
      root = path.resolve(project.project_path);
    } else {
      root = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : process.cwd();
    }
    const full = path.resolve(root, asset.path);
    const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
    if (!full.startsWith(root + path.sep) || !type || !fs.existsSync(full))
      return res.status(404).json({ error: "media_not_found" });
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "private, max-age=3600");
    fs.createReadStream(full).pipe(res);
  });
}
