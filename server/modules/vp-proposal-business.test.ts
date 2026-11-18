import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";
import { runVpReviewTick } from "./vp-review.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});

it("resolves autonomous proposal approval rules from the project's business", async () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,role TEXT,cli_provider TEXT,status TEXT,current_task_id TEXT,created_at INTEGER);
    INSERT INTO agents VALUES ('codex-vp','Codex VP','vp','codex','idle',NULL,1),('claude-vp','Claude VP','vp','claude','idle',NULL,2),('worker','Worker','senior','codex','idle',NULL,0);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,business TEXT);
    INSERT INTO projects VALUES ('project','Venture checks','ventures');
    CREATE TABLE agent_task_proposals(id TEXT PRIMARY KEY,agent_id TEXT,project_id TEXT,title TEXT,description TEXT,reason TEXT,status TEXT,created_at INTEGER);
    INSERT INTO agent_task_proposals VALUES ('proposal','worker','project','Run an internal diagnostic','Synthetic calculation only','Verify worker reliability','pending',1);
  `);
  ensureControlStateSchema(db);
  const run = vi.fn<Parameters<typeof runVpReviewTick>[0]["runAgentOneShot"]>(async (_vp, prompt) => {
    expect(prompt).not.toContain("Items with no business go to the owner");
    expect(prompt).toContain("BUSINESS PROFILE");
    expect(prompt).toContain("Always the owner");
    return { text: '{"verdict":"approve","reason":"Internal diagnostic fits the project"}' };
  });
  const execute = vi.fn(async () => {});
  await runVpReviewTick({ db, runAgentOneShot: run, execute, ownerSecurityReady: () => true });
  expect(run).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ id: "proposal" }),
    true,
    "vp:codex-vp,claude-vp",
    expect.any(String),
  );
});
