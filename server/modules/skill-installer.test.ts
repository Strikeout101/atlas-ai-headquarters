import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import {
  RECOMMENDED_SKILLS,
  installRecommendedSkills,
  installSkill,
  installedSkills,
  listRepoSkills,
  searchSkills,
  type SkillsCliRunner,
} from "./skill-installer.ts";
import { createOrgRequest, decideOrgRequest, ensureOrgRequestSchema } from "./org-requests.ts";
import { ensureAutonomyEngineSchema } from "./autonomy-engine.ts";
import { createWorkTask } from "./work-engine.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  db.exec(`INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2);
    INSERT INTO agents (id,name,role,cli_provider,department_id) VALUES
      ('lead-p','Adrian','team_leader','codex','planning'),('lead-d','Iris','team_leader','claude','design'),
      ('vp','Claude VP','vp','claude',NULL),('worker','Pat','junior','codex','planning');`);
  return db;
}

const LIST_OUTPUT = `●   Agent detected — installing non-interactively
◇  Found 3 skills
◇  Available Skills
│
│    customer-research
│
│      When the user wants to understand customers: interviews, reviews, surveys.
│
│    pricing
│
│      When the user wants to set or change prices.
Example Skills
│
│    canvas-design
│
│      Create visual art in .png and .pdf documents.
`;

describe("skill installer", () => {
  it("reads a repository's skills with their own descriptions", async () => {
    const run = vi.fn<SkillsCliRunner>(async () => ({ code: 0, output: LIST_OUTPUT }));
    const skills = await listRepoSkills("https://github.com/coreyhaines31/marketingskills.git", run);
    expect(run).toHaveBeenCalledWith(["add", "coreyhaines31/marketingskills", "--list", "--yes"], expect.any(Number));
    expect(skills).toEqual([
      {
        name: "customer-research",
        description: "When the user wants to understand customers: interviews, reviews, surveys.",
      },
      { name: "pricing", description: "When the user wants to set or change prices." },
      { name: "canvas-design", description: "Create visual art in .png and .pdf documents." },
    ]);
    await expect(listRepoSkills("not a repo; rm -rf /", run)).rejects.toThrow("invalid_skill_repo");
  });

  it("searches skills.sh, most installed first, dropping malformed entries", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        skills: [
          { source: "a/b", skillId: "etsy-seo", installs: 10 },
          { source: "c/d", skillId: "etsy-pricing", installs: 99 },
          { source: "bad source", skillId: "x", installs: 1000 },
        ],
      }),
    ) as unknown as typeof fetch;
    expect(await searchSkills("etsy", { fetch: fetchFn })).toEqual([
      { repo: "c/d", skill: "etsy-pricing", installs: 99 },
      { repo: "a/b", skill: "etsy-seo", installs: 10 },
    ]);
  });

  it("installs one skill globally for every provider the agents use and records it in the Library", async () => {
    const db = harness();
    const run = vi.fn<SkillsCliRunner>(async () => ({ code: 0, output: "Installed" }));
    const result = await installSkill(db, { repo: "anthropics/skills", skill: "pdf" }, run);
    expect(result.ok).toBe(true);
    expect(run.mock.calls[0][0]).toEqual([
      "add",
      "anthropics/skills",
      "-g",
      "--copy",
      "--skill",
      "pdf",
      "--yes",
      "--agent",
      "codex",
      "claude-code",
    ]);
    expect(
      db.prepare("SELECT provider, status, skill_label FROM skill_learning_history ORDER BY provider").all(),
    ).toEqual([
      { provider: "claude", status: "succeeded", skill_label: "anthropics/skills#pdf" },
      { provider: "codex", status: "succeeded", skill_label: "anthropics/skills#pdf" },
    ]);
    expect(installedSkills(db)).toEqual(["anthropics/skills#pdf"]);
    const failed = await installSkill(db, { repo: "a/b", skill: "x" }, async () => ({ code: 1, output: "not found" }));
    expect(failed.ok).toBe(false);
    expect(db.prepare("SELECT status, error FROM skill_learning_history WHERE repo='a/b' LIMIT 1").get()).toEqual({
      status: "failed",
      error: "not found",
    });
  });

  it("installs the recommended skills once, skipping ones already installed, and retries failures at most three times", async () => {
    const db = harness();
    await installSkill(db, { repo: "anthropics/skills", skill: "pdf" }, async () => ({ code: 0, output: "" }));
    const total = RECOMMENDED_SKILLS.reduce((sum, group) => sum + group.skills.length, 0);
    let calls = 0;
    const flaky: SkillsCliRunner = async (args) => {
      calls++;
      return { code: args.includes("seo-audit") ? 1 : 0, output: "" };
    };
    expect(await installRecommendedSkills(db, flaky)).toEqual({ installed: total - 2, failed: 1, skipped: false });
    expect(calls).toBe(total - 1);
    calls = 0;
    expect(await installRecommendedSkills(db, async () => ({ code: 0, output: "" }))).toEqual({
      installed: 1,
      failed: 0,
      skipped: false,
    });
    expect(await installRecommendedSkills(db, flaky)).toEqual({ installed: 0, failed: 0, skipped: true });
  });
});

describe("skill requests and hires", () => {
  it("lets team leaders and VPs ask for a skill, and installs it only after approval", async () => {
    const db = harness();
    ensureOrgRequestSchema(db);
    expect(() =>
      createOrgRequest(db, "install_skill", "worker", { repo: "a/b", skill: "etsy-seo", reason: "Better tags" }),
    ).toThrow("org_request_role_forbidden");
    expect(() =>
      createOrgRequest(db, "install_skill", "lead-d", { repo: "a b", skill: "etsy-seo", reason: "Better tags" }),
    ).toThrow("invalid_skill_repo");
    const request = createOrgRequest(db, "install_skill", "lead-d", {
      repo: "a/b",
      skill: "etsy-seo",
      what_it_does: "Scores Etsy titles",
      reason: "Better tags for the planner listings",
    });
    const install = vi.fn(async () => ({}));
    decideOrgRequest(db, request.id, false, "vp:a,b", { installSkill: install });
    expect(install).not.toHaveBeenCalled();
    const second = createOrgRequest(db, "install_skill", "vp", { repo: "a/b", skill: "etsy-seo", reason: "Needed" });
    expect(decideOrgRequest(db, second.id, true, "vp:a,b", { installSkill: install }).status).toBe("approved");
    expect(install).toHaveBeenCalledWith({ repo: "a/b", skill: "etsy-seo" });
  });

  it("adds install_skill to an older requests table without losing rows", () => {
    const db = harness();
    db.exec(`CREATE TABLE org_requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('hire_agent','create_department','convert_department','dissolve_department')),
      requested_by TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      reason TEXT NOT NULL, created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER);
      INSERT INTO org_requests (id,kind,requested_by,payload,reason,created_at) VALUES ('old','hire_agent','lead-p','{}','busy',1);`);
    ensureOrgRequestSchema(db);
    expect(db.prepare("SELECT id, kind FROM org_requests").all()).toEqual([{ id: "old", kind: "hire_agent" }]);
    createOrgRequest(db, "install_skill", "lead-p", { repo: "a/b", skill: "s", reason: "Needed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM org_requests").get()).toEqual({ n: 2 });
  });

  it("gives a hire with no provider named its department leader's provider, so it can run", () => {
    const db = harness();
    const request = createOrgRequest(db, "hire_agent", "lead-d", {
      name: "Nova",
      department_id: "design",
      reason: "Four mockup tasks waiting",
    });
    decideOrgRequest(db, request.id, true, "vp:a,b");
    expect(db.prepare("SELECT cli_provider, role FROM agents WHERE name='Nova'").get()).toEqual({
      cli_provider: "claude",
      role: "junior",
    });
  });

  it("tells a leader when work is queuing in their department", () => {
    const db = harness();
    ensureAutonomyEngineSchema(db);
    db.prepare(
      "INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at) VALUES ('p1','Shop','C:/Projects/shop','Sell',1,1)",
    ).run();
    const lead = db.prepare("SELECT id FROM agents WHERE department_id='design' LIMIT 1").get() as { id: string };
    const queue = (title: string) =>
      createWorkTask(db, {
        business: "ventures",
        project_id: "p1",
        department_id: "design",
        agent_id: lead.id,
        title,
        description: "Make it",
        work_type: "design",
        importance: "routine",
        playbook_step: "mockups",
      });
    for (const title of ["One", "Two", "Three"]) queue(title);
    const quiet = db.prepare("SELECT description FROM tasks WHERE title='Three'").get() as {
      description: string;
    };
    expect(quiet.description).not.toContain("Workload:");
    queue("Four");
    const busy = db.prepare("SELECT description FROM tasks WHERE title='Four'").get() as {
      description: string;
    };
    expect(busy.description).toContain("Workload: 3 other tasks are waiting");
    expect(busy.description).toContain("org.request_hire");
  });
});
