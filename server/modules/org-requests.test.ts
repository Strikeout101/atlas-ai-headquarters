import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureVpAgents } from "./bootstrap/schema/vp-agents.ts";
import { createOrgRequest, decideOrgRequest, MAX_DEPARTMENT_AGENTS } from "./org-requests.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureVpAgents(db);
  for (const id of ["dev", "research", "target"])
    db.prepare("INSERT INTO departments (id,name,name_ko,icon,color) VALUES (?,?,?,'','#aaa')").run(id, id, id);
  db.exec(
    "INSERT INTO agents (id,name,department_id,role,cli_provider) VALUES ('leader','Leader','research','team_leader','codex'),('worker','Worker','research','junior','api')",
  );
  return db;
}
describe("organization requests", () => {
  it("requires a workload reason and leader's own department", () => {
    const db = harness();
    expect(() =>
      createOrgRequest(db, "hire_agent", "leader", { name: "Researcher", department_id: "research" }),
    ).toThrow("org_workload_reason_required");
    expect(() =>
      createOrgRequest(db, "hire_agent", "worker", { name: "Researcher", department_id: "research", reason: "Queue" }),
    ).toThrow("org_request_role_forbidden");
    expect(() =>
      createOrgRequest(db, "hire_agent", "leader", { name: "Researcher", department_id: "dev", reason: "Queue" }),
    ).toThrow("org_hire_own_department_only");
  });
  it("hires only after approval and enforces department caps at execution", () => {
    const db = harness();
    const pending = createOrgRequest(db, "hire_agent", "leader", {
      name: "Researcher",
      department_id: "research",
      reason: "Queue exceeds capacity",
    });
    expect(db.prepare("SELECT 1 FROM agents WHERE name='Researcher'").get()).toBeUndefined();
    expect(decideOrgRequest(db, pending.id, true, "vp:both").status).toBe("approved");
    expect(() => decideOrgRequest(db, pending.id, true, "vp:both")).toThrow("org_request_already_decided");
    for (let i = 3; i < MAX_DEPARTMENT_AGENTS; i++)
      db.prepare("INSERT INTO agents(id,name,department_id,role) VALUES (?,?,'research','junior')").run(
        `extra-${i}`,
        `Extra ${i}`,
      );
    const capped = createOrgRequest(db, "hire_agent", "leader", {
      name: "Overflow",
      department_id: "research",
      reason: "Queue",
    });
    expect(() => decideOrgRequest(db, capped.id, true, "vp:both")).toThrow("org_agent_cap_reached");
    expect(db.prepare("SELECT status FROM org_requests WHERE id=?").get(capped.id)).toMatchObject({
      status: "pending",
    });
  });
  it("protects default departments from VP dissolution and blocks running tasks", () => {
    const db = harness();
    const baseline = createOrgRequest(db, "dissolve_department", "atlas-vp-codex", {
      department_id: "dev",
      reason: "Restructure",
      agents_action: "remove",
    });
    expect(() => decideOrgRequest(db, baseline.id, true, "vp:both")).toThrow("org_default_department_requires_owner");
    const busy = createOrgRequest(db, "dissolve_department", "atlas-vp-codex", {
      department_id: "research",
      reason: "Restructure",
      agents_action: "reassign",
      reassign_department_id: "target",
    });
    db.exec("INSERT INTO tasks(id,title,department_id,status) VALUES ('busy','Busy','research','in_progress')");
    expect(() => decideOrgRequest(db, busy.id, true, "vp:both")).toThrow("org_department_has_running_tasks");
    db.exec("UPDATE tasks SET status='done'");
    decideOrgRequest(db, busy.id, true, "vp:both");
    expect(db.prepare("SELECT department_id FROM agents WHERE id='leader'").get()).toMatchObject({
      department_id: "target",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("lets only VPs request department creation and applies conversion", () => {
    const db = harness();
    const payload = { department_id: "new", name: "New research", reason: "New capacity" };
    expect(() => createOrgRequest(db, "create_department", "leader", payload)).toThrow("org_request_role_forbidden");
    const create = createOrgRequest(db, "create_department", "atlas-vp-claude", payload);
    decideOrgRequest(db, create.id, true, "vp:both");
    const convert = createOrgRequest(db, "convert_department", "atlas-vp-claude", {
      ...payload,
      name: "Customer discovery",
    });
    decideOrgRequest(db, convert.id, true, "vp:both");
    expect(db.prepare("SELECT name FROM departments WHERE id='new'").get()).toMatchObject({
      name: "Customer discovery",
    });
  });
});
