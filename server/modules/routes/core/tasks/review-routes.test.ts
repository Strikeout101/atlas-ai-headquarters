import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../bootstrap/schema/task-schema-migrations.ts";
import { ensureReviewSchema, type ReviewDeps } from "../../../task-review.ts";
import { SESSION_COOKIE_NAME } from "../../../../config/runtime.ts";
import { createSessionToken } from "../../../../security/login-sessions.ts";
import { getCsrfToken } from "../../../../security/auth.ts";
import { registerTaskReviewRoutes } from "./review-routes.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function app() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureReviewSchema(db);
  db.exec(`INSERT INTO tasks (id,title,status,review_state) VALUES ('t1','Make it','review','owner'),('t2','Other','in_progress',NULL);
    INSERT INTO task_reviews (id,task_id,round,status,summary,created_at) VALUES ('r1','t1',0,'owner','Changes asked twice',1);`);
  const completeTask = vi.fn((taskId: string) => db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(taskId));
  const deps: ReviewDeps = {
    db,
    runAgentOneShot: vi.fn(),
    startTask: vi.fn(),
    completeTask,
    appendTaskLog: () => {},
  };
  const server = express();
  server.use(express.json());
  registerTaskReviewRoutes({ app: server, db, getReviewDeps: () => deps });
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
  return { db, server, cookie, completeTask };
}

describe("task review routes", () => {
  it("shows a task's reviews to the owner only", async () => {
    const { server, cookie } = app();
    await request(server).get("/api/tasks/t1/reviews").expect(403);
    const res = await request(server).get("/api/tasks/t1/reviews").set("Cookie", cookie).expect(200);
    expect(res.body).toMatchObject({
      review_state: "owner",
      reviews: [{ status: "owner", summary: "Changes asked twice" }],
    });
    await request(server).get("/api/tasks/missing/reviews").set("Cookie", cookie).expect(404);
  });

  it("applies the owner's call, and refuses one that isn't waiting for them", async () => {
    const { server, cookie, completeTask } = app();
    const post = (id: string, body: Record<string, unknown>) =>
      request(server)
        .post(`/api/tasks/${id}/review-decision`)
        .set("Cookie", cookie)
        .set("x-csrf-token", getCsrfToken())
        .send(body);
    await request(server)
      .post("/api/tasks/t1/review-decision")
      .set("Cookie", cookie)
      .send({ action: "accept" })
      .expect(403);
    expect((await post("t2", { action: "accept" }).expect(400)).body.error).toBe("review_not_waiting_for_owner");
    expect((await post("t1", { action: "maybe" }).expect(400)).body.error).toBe("invalid_action");
    const done = await post("t1", { action: "accept", notes: "Ship it" }).expect(200);
    expect(done.body.item.status).toBe("done");
    expect(completeTask).toHaveBeenCalledWith("t1", "Make it");
  });
});
