import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildWorkDecisionItems } from "./work-items.ts";

describe("work decisions", () => {
  it("shows only proposed strategies and ideas, plus owner-blocked initiatives", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE business_goals (id TEXT, metric TEXT);
      CREATE TABLE goal_strategies (id TEXT, goal_id TEXT, version INTEGER, summary TEXT, created_at INTEGER, task_id TEXT, status TEXT);
      CREATE TABLE tasks (id TEXT, status TEXT);
      CREATE TABLE initiatives (id TEXT, goal_id TEXT, title TEXT, status TEXT, escalation TEXT, blocked_reason TEXT, created_at INTEGER, updated_at INTEGER);
      INSERT INTO business_goals VALUES ('g','Reach Etsy sales');
      INSERT INTO goal_strategies VALUES ('s','g',2,'Test a product niche with a small launch',10,NULL,'proposed');
      INSERT INTO goal_strategies VALUES ('previous','g',1,'Earlier strategy',1,NULL,'approved');
      INSERT INTO initiatives VALUES ('i','g','Budget template','proposed',NULL,NULL,20,20);
      INSERT INTO initiatives VALUES ('b','g','Listing update','blocked','owner','The build failed',30,31);
      INSERT INTO initiatives VALUES ('v','g','VP work','blocked','vp','Retrying',30,31);
    `);
    const items = buildWorkDecisionItems(db);
    expect(items.map((item) => item.kind)).toEqual(["strategy", "initiative_approval", "initiative_blocked"]);
    expect(items.map((item) => item.options.length)).toEqual([2, 2, 3]);
    expect(items.every((item) => item.options[0].label.includes("recommended"))).toBe(true);
    db.close();
  });
});
