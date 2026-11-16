import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { registerVpReviewRoutes } from "./vp-reviews.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const app = express();
  registerVpReviewRoutes(app, db);
  return { app, db };
}
describe("VP decisions history", () => {
  it("returns historical outcomes with the reviews for their exact snapshot independently of current state", async () => {
    const { app, db } = harness();
    db.exec(`INSERT INTO approval_vp_events(approval_kind,approval_id,snapshot_hash,status,reason,outcome,created_at) VALUES
    ('task_proposal','proposal','old','escalated','Independent disagreement',NULL,100),
    ('task_proposal','proposal','new','decided','Updated request approved','approve',200);
    INSERT INTO approval_vp_state VALUES ('task_proposal','proposal','new','decided','Updated request approved','approve',200);
    INSERT INTO approval_reviews VALUES
    ('task_proposal','proposal','old','codex-vp','approve','Old Codex evidence',90),
    ('task_proposal','proposal','old','claude-vp','deny','Old Claude objection',91),
    ('task_proposal','proposal','new','codex-vp','approve','New Codex evidence',190),
    ('task_proposal','proposal','new','claude-vp','approve','New Claude evidence',191);`);
    const response = await request(app).get("/api/vp-decisions").expect(200);
    expect(response.body.items).toHaveLength(2);
    const [latest, history] = response.body.items;
    expect(latest).toMatchObject({ event_id: "event:2", status: "decided", outcome: "approve", updated_at: 200 });
    expect(latest.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vp_agent_id: "codex-vp", reason: "New Codex evidence" }),
        expect.objectContaining({ vp_agent_id: "claude-vp", reason: "New Claude evidence" }),
      ]),
    );
    expect(history).toMatchObject({ event_id: "event:1", status: "escalated", updated_at: 100 });
    expect(history.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vp_agent_id: "codex-vp", verdict: "approve", reason: "Old Codex evidence" }),
        expect.objectContaining({ vp_agent_id: "claude-vp", verdict: "deny", reason: "Old Claude objection" }),
      ]),
    );
    expect(JSON.stringify(history)).not.toContain("New Codex evidence");
  });
  it("includes skipped waiting events with no fabricated verdicts and reads legacy current state once", async () => {
    const { app, db } = harness();
    db.exec(`INSERT INTO approval_vp_events(approval_kind,approval_id,snapshot_hash,status,reason,outcome,created_at) VALUES ('model_upgrade','upgrade','snapshot','waiting','Both subscriptions nearly used',NULL,100);
    INSERT INTO approval_vp_state VALUES ('model_upgrade','upgrade','snapshot','waiting','Both subscriptions nearly used',NULL,100),
    ('task_proposal','legacy','legacy-snapshot','decided','Legacy approval','deny',50);
    INSERT INTO approval_reviews VALUES ('task_proposal','legacy','legacy-snapshot','codex-vp','deny','Legacy reason',49);`);
    const response = await request(app).get("/api/vp-decisions").expect(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0]).toMatchObject({
      event_id: "event:1",
      status: "waiting",
      reason: "Both subscriptions nearly used",
      reviews: [],
    });
    expect(response.body.items[1]).toMatchObject({
      event_id: "state:task_proposal:legacy",
      outcome: "deny",
      reviews: [expect.objectContaining({ reason: "Legacy reason" })],
    });
  });
  it("returns an empty log before any reviews", async () => {
    const { app } = harness();
    expect((await request(app).get("/api/vp-decisions").expect(200)).body).toEqual({ ok: true, items: [] });
  });
});
