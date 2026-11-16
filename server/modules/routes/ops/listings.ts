import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  createListing,
  decideListing,
  ensureListingSchema,
  listingsOverview,
  markListingPublished,
  setFeeBudget,
  submitListing,
  updateListing,
  withdrawListing,
} from "../../listings.ts";

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
  if (
    [
      "listing_already_decided",
      "listing_not_editable",
      "listing_not_approved",
      "listing_not_withdrawable",
      "listing_incomplete",
    ].includes(message)
  )
    return 409;
  return 400;
}

/** Owner routes for listing packages. Agents prepare packages through the task tool gateway, not here. */
export function registerListingRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureListingSchema(db);
  const reply = (res: Response, work: () => unknown, created = false) => {
    try {
      const item = work();
      broadcast("listings_changed", {});
      broadcast("approvals_changed", {});
      res.status(created ? 201 : 200).json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "listing_request_failed";
      res.status(statusFor(message)).json({ error: message });
    }
  };
  const bodyOf = (req: Request): Record<string, unknown> | null =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;

  app.get("/api/listings", (req, res) => {
    try {
      const filter: { business?: string; status?: string } = {};
      if (typeof req.query.business === "string") filter.business = req.query.business;
      if (typeof req.query.status === "string") filter.status = req.query.status;
      res.json({ ok: true, ...listingsOverview(db, filter) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "listing_request_failed" });
    }
  });
  app.put("/api/listings/budget", (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, budget: setFeeBudget(db, bodyOf(req)?.monthly_cap_minor) });
      broadcast("listings_changed", {});
      broadcast("approvals_changed", {});
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "listing_request_failed" });
    }
  });
  app.post("/api/listings", (req, res) => {
    if (!owner(req, res)) return;
    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: "invalid_payload" });
    reply(res, () => createListing(db, body), true);
  });
  app.patch("/api/listings/:id", (req, res) => {
    if (!owner(req, res)) return;
    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: "invalid_payload" });
    reply(res, () => updateListing(db, String(req.params.id), body));
  });
  app.post("/api/listings/:id/submit", (req, res) => {
    if (!owner(req, res)) return;
    reply(res, () => submitListing(db, String(req.params.id)));
  });
  app.post("/api/listings/:id/decide", (req, res) => {
    if (!owner(req, res)) return;
    const body = bodyOf(req);
    if (typeof body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    reply(res, () => decideListing(db, String(req.params.id), body.approve as boolean, "owner"));
  });
  app.post("/api/listings/:id/published", (req, res) => {
    if (!owner(req, res)) return;
    reply(res, () => markListingPublished(db, String(req.params.id), bodyOf(req)?.listing_url));
  });
  app.post("/api/listings/:id/withdraw", (req, res) => {
    if (!owner(req, res)) return;
    reply(res, () => withdrawListing(db, String(req.params.id)));
  });
}
