import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  addMemory,
  ensureAgentMemorySchema,
  getMemory,
  listMemories,
  reviewMemory,
  setMemoryStatus,
  updateMemory,
} from "../../agent-memory.ts";
import { readKnowledgeFile } from "../../agent-knowledge.ts";
import { lessonCoverage } from "../../task-lessons.ts";

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
  if (message === "memory_duplicate") return 409;
  return 400;
}

/**
 * Owner pages for what agents know: the systems registry, the master checklist, and agent memories to review.
 * Reading needs a signed-in session like the rest of the app; changes need the owner's password session.
 * Agent processes are refused outright (they read knowledge through the task tool gateway).
 */
export function registerKnowledgeRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureAgentMemorySchema(db);
  app.use("/api/knowledge", (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    next();
  });

  app.get("/api/knowledge/documents/:topic", (req, res) => {
    const topic = req.params.topic;
    if (topic !== "systems" && topic !== "checklist") return res.status(404).json({ error: "knowledge_topic_unknown" });
    const text = readKnowledgeFile(topic);
    return res.json({ ok: true, topic, available: text !== null, text: text ?? "" });
  });

  // How often finished tasks left lessons (saved by the agent, taken from its final output, none, or missing).
  app.get("/api/knowledge/lesson-checks", (_req, res) => res.json({ ok: true, ...lessonCoverage(db) }));

  app.get("/api/knowledge/memories", (req, res) => {
    try {
      const filter: { status?: string; business?: string; reviewed?: "yes" | "no"; query?: string } = {};
      if (typeof req.query.status === "string" && req.query.status) filter.status = req.query.status;
      if (typeof req.query.business === "string" && req.query.business) filter.business = req.query.business;
      if (req.query.reviewed === "yes" || req.query.reviewed === "no") filter.reviewed = req.query.reviewed;
      if (typeof req.query.q === "string" && req.query.q.trim()) filter.query = req.query.q.slice(0, 200);
      return res.json({ ok: true, ...listMemories(db, filter) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "memory_request_failed" });
    }
  });

  const change = (res: Response, work: () => unknown, created = false) => {
    try {
      const item = work();
      broadcast("knowledge_changed", {});
      return res.status(created ? 201 : 200).json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "memory_request_failed";
      return res.status(statusFor(message)).json({ error: message });
    }
  };
  const body = (req: Request): Record<string, unknown> =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

  app.post("/api/knowledge/memories", (req, res) => {
    if (!owner(req, res)) return;
    // Owner-written memories are reviewed by definition.
    return change(res, () => addMemory(db, body(req), { reviewedBy: "owner" }), true);
  });
  app.patch("/api/knowledge/memories/:id", (req, res) => {
    if (!owner(req, res)) return;
    return change(res, () => updateMemory(db, String(req.params.id), body(req)));
  });
  app.post("/api/knowledge/memories/:id/review", (req, res) => {
    if (!owner(req, res)) return;
    return change(res, () => reviewMemory(db, String(req.params.id)));
  });
  app.post("/api/knowledge/memories/:id/status", (req, res) => {
    if (!owner(req, res)) return;
    return change(res, () => setMemoryStatus(db, String(req.params.id), body(req).status));
  });
  app.get("/api/knowledge/memories/:id", (req, res) => {
    const item = getMemory(db, String(req.params.id));
    return item ? res.json({ ok: true, item }) : res.status(404).json({ error: "memory_not_found" });
  });
}
