import type { Express, Request, Response } from "express";
import {
  applyShopChange,
  decideShopChange,
  listShopChanges,
  markShopChangeOwnerDone,
  shopProfile,
} from "../../etsy-shop.ts";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  adoptEtsyListing,
  completeEtsyConnect,
  disconnectEtsy,
  ensureEtsySchema,
  etsySettings,
  etsyShopListings,
  publishEtsyListing,
  pushListingDraft,
  saveEtsySettings,
  startEtsyConnect,
  syncEtsy,
  testEtsyConnection,
} from "../../etsy.ts";

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
  if (message.startsWith("etsy_api_") || message.startsWith("etsy_token_failed")) return 502;
  return 400;
}

/**
 * Owner-only Etsy connection: credentials, connecting (with the pasted redirect address), test, sync, and pushing or
 * publishing approved listing packages. Agent processes are refused; agents only prepare packages.
 */
export function registerEtsyRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureEtsySchema(db);
  app.use("/api/etsy", (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (!requireOwnerSession(req, res)) return;
    next();
  });

  const handle =
    (work: (req: Request) => unknown | Promise<unknown>, needsOwner = true) =>
    async (req: Request, res: Response) => {
      if (needsOwner && !owner(req, res)) return;
      try {
        const result = await work(req);
        broadcast("etsy_changed", {});
        res.json({ ok: true, ...(result && typeof result === "object" ? result : { result }) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "etsy_request_failed";
        res.status(statusFor(message)).json({ error: message });
      }
    };
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

  app.get("/api/etsy", (_req, res) => res.json({ ok: true, settings: etsySettings(db) }));
  app.patch(
    "/api/etsy",
    handle((req) => ({ settings: saveEtsySettings(db, body(req)) })),
  );
  app.post(
    "/api/etsy/connect",
    handle(() => startEtsyConnect(db)),
  );
  app.post(
    "/api/etsy/connect/complete",
    handle(async (req) => ({ settings: await completeEtsyConnect(db, body(req).url) })),
  );
  app.post(
    "/api/etsy/test",
    handle(async () => ({ settings: await testEtsyConnection(db) })),
  );
  app.post(
    "/api/etsy/sync",
    handle(async (req) => {
      // Optional { history_days }: re-read that much history (orders and payment records) in 30-day windows.
      const days = body(req).history_days;
      const options = days === undefined || days === null ? {} : { historyDays: days as number };
      return { counts: await syncEtsy(db, {}, options), settings: etsySettings(db) };
    }),
  );
  app.get("/api/etsy/listings", (_req, res) => res.json({ ok: true, items: etsyShopListings(db) }));
  app.get("/api/etsy/shop", (_req, res) => res.json({ ok: true, ...shopProfile(db), changes: listShopChanges(db) }));
  app.post(
    "/api/etsy/shop-changes/:id/decide",
    handle((req) => ({
      item: decideShopChange(
        db,
        String(req.params.id),
        body(req).approve === true,
        "owner",
        typeof body(req).reason === "string" ? String(body(req).reason) : "",
      ),
    })),
  );
  app.post(
    "/api/etsy/shop-changes/:id/apply",
    handle(async (req) => ({ item: await applyShopChange(db, String(req.params.id)) })),
  );
  app.post(
    "/api/etsy/shop-changes/:id/owner-done",
    handle((req) => ({ item: markShopChangeOwnerDone(db, String(req.params.id)) })),
  );
  app.post(
    "/api/etsy/listings/:id/adopt",
    handle((req) => {
      const item = adoptEtsyListing(db, String(req.params.id), body(req));
      broadcast("listings_changed", { id: item.id });
      return { item };
    }),
  );
  app.post(
    "/api/etsy/disconnect",
    handle(() => ({ settings: disconnectEtsy(db) })),
  );

  for (const [suffix, work] of [
    ["etsy-draft", pushListingDraft],
    ["etsy-publish", publishEtsyListing],
  ] as const) {
    app.post(`/api/listings/:id/${suffix}`, async (req, res) => {
      if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
      if (!owner(req, res)) return;
      try {
        const item = await work(db, String(req.params.id));
        broadcast("listings_changed", { id: item.id });
        res.json({ ok: true, item });
      } catch (error) {
        const message = error instanceof Error ? error.message : "etsy_request_failed";
        res.status(statusFor(message)).json({ error: message });
      }
    });
  }
}
