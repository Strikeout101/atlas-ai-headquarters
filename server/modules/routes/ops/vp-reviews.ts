import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { ensureApprovalReviewSchema } from "../../approval-review-state.ts";

export function registerVpReviewRoutes(app: Express, db: DatabaseSync): void {
  ensureApprovalReviewSchema(db);
  app.get("/api/vp-decisions", (_req, res) => {
    const items = db
      .prepare(
        `SELECT s.event_id,s.approval_kind,s.approval_id,s.status,s.reason,s.outcome,s.updated_at,
      (SELECT json_group_array(json_object('vp_agent_id',r.vp_agent_id,'verdict',r.verdict,'reason',r.reason,'created_at',r.created_at))
       FROM approval_reviews r WHERE r.approval_kind=s.approval_kind AND r.approval_id=s.approval_id AND r.snapshot_hash=s.snapshot_hash) AS reviews_json
      FROM (
        SELECT 'event:' || id AS event_id,approval_kind,approval_id,snapshot_hash,status,reason,outcome,created_at AS updated_at FROM approval_vp_events
        UNION ALL
        SELECT 'state:' || approval_kind || ':' || approval_id,approval_kind,approval_id,snapshot_hash,status,reason,outcome,updated_at
        FROM approval_vp_state current WHERE NOT EXISTS (
          SELECT 1 FROM approval_vp_events e WHERE e.approval_kind=current.approval_kind AND e.approval_id=current.approval_id
        )
      ) s ORDER BY s.updated_at DESC LIMIT 200`,
      )
      .all() as Array<Record<string, unknown>>;
    res.json({
      ok: true,
      items: items.map(({ reviews_json, ...item }) => ({ ...item, reviews: JSON.parse(String(reviews_json ?? "[]")) })),
    });
  });
}
