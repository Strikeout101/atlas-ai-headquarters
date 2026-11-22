import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../../security/auth.ts";
import { resolveReviewByOwner, taskReviews, type ReviewDeps } from "../../../task-review.ts";

/**
 * A task's reviews (work restructure, phase 4): the history for the board, and the owner's call on a review the VPs
 * passed on (accept as is, one more go, or drop). Owner session only; agents cannot decide their own reviews.
 */
export function registerTaskReviewRoutes(input: {
  app: Express;
  db: DatabaseSync;
  getReviewDeps: () => ReviewDeps;
}): void {
  const { app, db, getReviewDeps } = input;
  app.get("/api/tasks/:id/reviews", (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    const id = String(req.params.id);
    const task = db.prepare("SELECT id, status, review_state FROM tasks WHERE id=?").get(id) as
      | { id: string; status: string; review_state: string | null }
      | undefined;
    if (!task) return res.status(404).json({ error: "task_not_found" });
    res.json({ ok: true, review_state: task.review_state ?? null, reviews: taskReviews(db, id) });
  });
  app.post("/api/tasks/:id/review-decision", async (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    try {
      const item = await resolveReviewByOwner(getReviewDeps(), String(req.params.id), {
        action: String(body.action ?? ""),
        notes: typeof body.notes === "string" ? body.notes : undefined,
        agent_id: typeof body.agent_id === "string" ? body.agent_id : null,
      });
      res.json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "review_decision_failed";
      res.status(message === "task_not_found" ? 404 : 400).json({ error: message });
    }
  });
}
