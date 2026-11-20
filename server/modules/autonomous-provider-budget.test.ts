import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureModelRoutingSchema } from "./model-routing.ts";
import {
  autonomousProviderBudgetBlockReason,
  reserveAutonomyProviderInvocation,
} from "./autonomous-provider-budget.ts";

const dbs: DatabaseSync[] = [];
const files: string[] = [];
const NOW = Date.parse("2026-11-19T15:00:00Z");
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  files.splice(0).forEach((file) => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
  });
  resetControlStateForTests();
});
function setup(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  dbs.push(db);
  applyBaseSchema(db);
  ensureControlStateSchema(db);
  ensureAutonomySchema(db);
  ensureModelRoutingSchema(db);
  db.exec(`INSERT INTO api_providers(id,name,type,base_url) VALUES ('local','Local','ollama','http://localhost:11434/v1'),('paid','Paid','openai','https://api.example.com/v1');
    INSERT INTO agents(id,name,role,cli_provider,api_provider_id) VALUES ('worker','Worker','senior','api','local');
    INSERT INTO tasks(id,title,status,assigned_agent_id,origin) VALUES ('task','Bounded work','in_progress','worker','autonomy'),('other','Other work','in_progress','worker','autonomy');`);
  return db;
}
describe("autonomous provider invocation budget", () => {
  it("counts each retry/resume and cannot be reset by deleting a task", () => {
    const db = setup();
    db.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=2");
    expect(reserveAutonomyProviderInvocation(db, "task", { invocationId: "one" }, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "task", { invocationId: "two" }, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "task", { invocationId: "three" }, NOW)).toContain("cap reached");
    db.exec("DELETE FROM tasks WHERE id='task'");
    expect(reserveAutonomyProviderInvocation(db, "other", {}, NOW)).toContain("cap reached");
    expect(reserveAutonomyProviderInvocation(db, "other", {}, NOW + 86400000)).toBeNull();
  });
  it("makes the same invocation id idempotent but rejects changed attribution", () => {
    const db = setup();
    db.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=1");
    expect(reserveAutonomyProviderInvocation(db, "task", { invocationId: "same" }, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "task", { invocationId: "same" }, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "other", { invocationId: "same" }, NOW)).toContain("identity changed");
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_provider_invocations").get()).toEqual({ n: 1 });
  });
  it("atomically admits only one of two DB connections after both preflights passed", () => {
    fs.mkdirSync(path.resolve(".tmp"), { recursive: true });
    const filename = path.resolve(".tmp", `provider-budget-${randomUUID()}.sqlite`);
    files.push(filename);
    const first = setup(filename);
    const second = new DatabaseSync(filename);
    dbs.push(second);
    first.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=1");
    expect(autonomousProviderBudgetBlockReason(first, "task", NOW)).toBeNull();
    expect(autonomousProviderBudgetBlockReason(second, "other", NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(first, "task", {}, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(second, "other", {}, NOW)).toContain("cap reached");
  });
  it("keeps paid and unknown API providers closed for autonomy while owner runs are unchanged", () => {
    const db = setup();
    db.exec("UPDATE agents SET api_provider_id='paid'");
    expect(reserveAutonomyProviderInvocation(db, "task", {}, NOW)).toContain("enforceable provider budget");
    expect(reserveAutonomyProviderInvocation(db, "task", { provider: "api", apiProviderId: "absent" }, NOW)).toContain(
      "enforceable provider budget",
    );
    db.exec("UPDATE tasks SET origin='owner'");
    expect(reserveAutonomyProviderInvocation(db, "task", {}, NOW)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_provider_invocations").get()).toEqual({ n: 0 });
  });
  it("uses current routed host and keeps per-host limits separate", () => {
    const db = setup();
    db.exec(`INSERT INTO api_providers(id,name,type,base_url) VALUES ('second','Second local','ollama','http://localhost:11435/v1');
      UPDATE autonomy_config SET local_provider_daily_run_cap=1;
      INSERT INTO task_model_routes(task_id,agent_id,provider,model,source,reason,updated_at,api_provider_id)
      VALUES ('task','worker','api','model','default','test',0,'second');`);
    expect(reserveAutonomyProviderInvocation(db, "task", {}, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "other", {}, NOW)).toBeNull();
    expect(db.prepare("SELECT provider_id FROM autonomy_provider_invocations ORDER BY provider_id").all()).toEqual([
      { provider_id: "local" },
      { provider_id: "second" },
    ]);
  });
  it("zero cap disables local autonomous invocation and migration preserves the owner's limit", () => {
    const db = setup();
    db.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=0");
    ensureAutonomySchema(db);
    expect(autonomousProviderBudgetBlockReason(db, "task", NOW)).toContain("cap reached");
    expect(reserveAutonomyProviderInvocation(db, "task", {}, NOW)).toContain("cap reached");
  });
  it("refuses to launch an attributed task deleted before transport", () => {
    const db = setup();
    db.exec("DELETE FROM tasks WHERE id='task'");
    expect(reserveAutonomyProviderInvocation(db, "task", {}, NOW)).toContain("no longer exists");
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_provider_invocations").get()).toEqual({ n: 0 });
  });
  it("lets the actual subscription transport override a previous local route", () => {
    const db = setup();
    db.exec(`UPDATE autonomy_config SET local_provider_daily_run_cap=0;
      INSERT INTO task_model_routes(task_id,agent_id,provider,model,source,reason,updated_at,api_provider_id)
      VALUES ('task','worker','api','model','default','test',0,'local');`);
    expect(reserveAutonomyProviderInvocation(db, "task", { provider: "codex" }, NOW)).toBeNull();
    expect(reserveAutonomyProviderInvocation(db, "task", { provider: "opencode" }, NOW)).toContain("cap reached");
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_provider_invocations").get()).toEqual({ n: 0 });
  });
});
