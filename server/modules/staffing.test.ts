import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureControlStateSchema } from "./control-state.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureReviewSchema } from "./task-review.ts";
import {
  agentLoad,
  chooseAssignee,
  DELEGATE_AT,
  HIRE_AT,
  LEAD_IMPORTANT_MAX,
  maybeRequestHire,
  rebalanceDepartment,
} from "./staffing.ts";

type Row = Record<string, any>;
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureAutonomySchema(db);
  ensureReviewSchema(db);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES ('design','Design','','','','','#000',1);
    INSERT INTO agents (id,name,role,department_id,cli_provider,created_at) VALUES
      ('lead','Iris','team_leader','design','codex',1),('senior','Bobby','senior','design','claude',2),('vp','Victor','vp',NULL,'claude',3);
  `);
  let n = 0;
  const task = (
    importance: "important" | "routine",
    opts: { agent?: string; status?: string; priority?: number; step?: string; started?: boolean } = {},
  ) => {
    const id = `t${++n}`;
    db.prepare(
      `INSERT INTO tasks (id,title,status,department_id,assigned_agent_id,origin,importance,playbook_step,priority,started_at,created_at,updated_at)
       VALUES (?,?,?,?,?,'autonomy',?,?,?,?,?,?)`,
    ).run(
      id,
      `Task ${n}`,
      opts.status ?? "planned",
      "design",
      opts.agent ?? "lead",
      importance,
      opts.step ?? "build",
      opts.priority ?? 1,
      opts.started ? 5 : null,
      n,
      n,
    );
    return id;
  };
  const owner = (id: string) =>
    (db.prepare("SELECT assigned_agent_id FROM tasks WHERE id=?").get(id) as Row).assigned_agent_id;
  return { db, task, owner };
}

describe("choosing who takes a task", () => {
  it("gives important work to the lead until they have 2, and routine work to the senior", () => {
    const h = harness();
    expect(chooseAssignee(h.db, "design", { importance: "important" })?.id).toBe("lead");
    expect(chooseAssignee(h.db, "design", { importance: "routine" })?.id).toBe("senior");
    for (let i = 0; i < LEAD_IMPORTANT_MAX; i++) h.task("important", { status: "in_progress" });
    expect(agentLoad(h.db, "lead")).toMatchObject({ important: 2, running: 2 });
    expect(chooseAssignee(h.db, "design", { importance: "important" })?.id).toBe("senior");
  });

  it(`delegates important work once ${DELEGATE_AT} or more important tasks are waiting`, () => {
    const h = harness();
    for (let i = 0; i < DELEGATE_AT; i++) h.task("important", { agent: "senior" });
    expect(chooseAssignee(h.db, "design", { importance: "important" })?.id).toBe("senior");
  });

  it("honours a model preference, and falls back to the lead when there is no staff", () => {
    const h = harness();
    expect(chooseAssignee(h.db, "design", { importance: "routine", provider: "codex" })?.id).toBe("lead");
    h.db.exec("UPDATE agents SET status='offline' WHERE id='senior'");
    expect(chooseAssignee(h.db, "design", { importance: "routine" })?.id).toBe("lead");
    expect(chooseAssignee(h.db, "nowhere", { importance: "routine" })).toBeNull();
  });
});

describe("rebalancing waiting work", () => {
  it("keeps the most important for the lead and hands the rest to the senior", () => {
    const h = harness();
    const top = h.task("important", { priority: 5 });
    const second = h.task("important", { priority: 4 });
    const third = h.task("important", { priority: 1 });
    const routine = h.task("routine");
    const moves = rebalanceDepartment(h.db, "design", 100);
    expect(h.owner(top)).toBe("lead");
    expect(h.owner(second)).toBe("lead");
    expect(h.owner(third)).toBe("senior");
    expect(h.owner(routine)).toBe("senior");
    expect(moves).toHaveLength(2);
    const ledger = h.db.prepare("SELECT message FROM autonomy_ledger WHERE event='reassigned'").all() as Row[];
    expect(ledger.map((r) => r.message).join("\n")).toContain("3 important tasks are waiting");
  });

  it("counts the lead's running important work against their 2 slots", () => {
    const h = harness();
    h.task("important", { status: "in_progress", started: true });
    const waiting = h.task("important", { priority: 3 });
    const next = h.task("important", { priority: 2 });
    rebalanceDepartment(h.db, "design", 100);
    expect(h.owner(waiting)).toBe("lead");
    expect(h.owner(next)).toBe("senior");
  });

  it("leaves retries, review returns, research angles and started work where they are", () => {
    const h = harness();
    const retry = h.task("routine");
    h.db.prepare("UPDATE tasks SET attempt=2 WHERE id=?").run(retry);
    const returned = h.task("routine");
    h.db.prepare("UPDATE tasks SET review_state='changes' WHERE id=?").run(returned);
    const angle = h.task("routine", { step: "research:market" });
    const started = h.task("routine", { started: true });
    expect(rebalanceDepartment(h.db, "design", 100)).toEqual([]);
    for (const id of [retry, returned, angle, started]) expect(h.owner(id)).toBe("lead");
  });
});

describe("hiring", () => {
  it(`asks for a hire when ${HIRE_AT}+ tasks wait and everyone is busy, once`, () => {
    const h = harness();
    h.task("important", { status: "in_progress", agent: "lead" });
    for (let i = 0; i < HIRE_AT - 1; i++) h.task("routine", { agent: "senior" });
    expect(maybeRequestHire(h.db, "design", 1000)).toBeNull(); // the senior isn't running anything
    h.task("routine", { status: "in_progress", agent: "senior" });
    expect(maybeRequestHire(h.db, "design", 1000)).toBeNull(); // only 3 waiting
    h.task("routine", { agent: "senior" });
    const id = maybeRequestHire(h.db, "design", 1000);
    expect(id).toBeTruthy();
    const request = h.db.prepare("SELECT * FROM org_requests WHERE id=?").get(id) as Row;
    expect(request).toMatchObject({ kind: "hire_agent", requested_by: "lead", status: "pending" });
    expect(JSON.parse(request.payload)).toMatchObject({
      department_id: "design",
      role: "senior",
      cli_provider: "claude",
    });
    expect(maybeRequestHire(h.db, "design", 2000)).toBeNull(); // one open request per department
  });
});
