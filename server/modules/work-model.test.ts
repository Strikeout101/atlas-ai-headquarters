import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import {
  defaultImportance,
  ensureHandoffAfterRun,
  ensureTaskWorkModel,
  formatHandoff,
  getHandoff,
  inferWorkType,
  resolveWorkFolder,
  saveHandoff,
  workTypeInstructions,
} from "./work-model.ts";

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
let previousWorkDir: string | undefined;
beforeEach(() => {
  previousWorkDir = process.env.ATLAS_WORK_DIR;
});
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  if (previousWorkDir === undefined) delete process.env.ATLAS_WORK_DIR;
  else process.env.ATLAS_WORK_DIR = previousWorkDir;
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-work-model-"));
  dirs.push(dir);
  return dir;
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureAutonomySchema(db);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2),
      ('dev','Development','','','','','#000',3);
    INSERT INTO projects (id,name,project_path,core_goal,business) VALUES ('p1','Etsy Shop','C:/nowhere','Sell',  'ventures');
    INSERT INTO business_goals (id,business,metric,target,period_start,period_end,created_at,updated_at)
      VALUES ('g1','ventures','verified_revenue',2000,0,9000000000000000,1,1);
    INSERT INTO initiatives (id,business,goal_id,title,created_at,updated_at)
      VALUES ('i1','ventures','g1','Wedding Budget Workbook!',1,1);
  `);
  return db;
}

describe("work types", () => {
  it.each([
    ["Strategy: how to reach the Etsy Shop goal", "Planning", "research"],
    ["Write the Etsy listing for the seating chart", "Design", "listing"],
    ["Set up the shop profile and policies", "Planning", "shop_admin"],
    ["Draft the launch email to past customers", "Operations", "outreach"],
    ["Fix the build failure in the website repo", "Planning", "code"],
    ["Render three mockups for the planner", "Planning", "design"],
    ["Check the homelab backup ran", "Planning", "ops"],
    ["Build the printable wedding planner bundle", "Design", "product"],
    ["Tidy up", "Development", "code"],
    ["Tidy up", "Design", "design"],
    ["Tidy up", null, "research"],
  ])("'%s' (%s) is %s work", (title, departmentName, expected) => {
    expect(inferWorkType({ title, departmentName })).toBe(expected);
  });

  it("decides from the title before the description", () => {
    expect(
      inferWorkType({ title: "Research wedding planner demand", description: "Later we may build a website." }),
    ).toBe("research");
  });

  it("marks strategy, products, code and anything public as important; other work as routine", () => {
    expect(defaultImportance("research", "Strategy: reach the goal")).toBe("important");
    expect(defaultImportance("research", "Check competitor prices")).toBe("routine");
    expect(defaultImportance("product", "Build it")).toBe("important");
    expect(defaultImportance("listing", "Write it")).toBe("important");
    expect(defaultImportance("design", "Mockups")).toBe("routine");
    expect(defaultImportance("ops", "Check backups")).toBe("routine");
  });

  it("gives only code work the git rules", () => {
    const code = workTypeInstructions("code", "C:/repo/.climpire-worktrees/abc");
    expect(code).toContain("isolated Git worktree");
    expect(code).toContain("Do not commit");
    const research = workTypeInstructions("research", "C:/shop/goals/g1");
    expect(research).toContain("Working folder (plain, no git): C:/shop/goals/g1");
    expect(research).toContain("Keep measured facts apart from estimates");
    expect(research).not.toMatch(/worktree|commit/i);
    expect(research).toContain("task.handoff");
    expect(
      research
        .split("\n")
        .slice(1)
        .every((line) => line.startsWith("- ")),
    ).toBe(true);
  });
});

describe("filling a task's place in the work", () => {
  it("fills a step task's goal and business from its initiative, and sets type and importance", () => {
    const db = database();
    db.exec(`
      INSERT INTO tasks (id,title,department_id,project_id,initiative_id) VALUES ('t1','Build the printable workbook','design','p1','i1');
    `);
    expect(ensureTaskWorkModel(db, "t1")).toMatchObject({
      initiative_id: "i1",
      goal_id: "g1",
      business: "ventures",
      work_type: "product",
      importance: "important",
    });
    expect(db.prepare("SELECT initiative_id, goal_id, business, work_type FROM tasks WHERE id='t1'").get()).toEqual({
      initiative_id: "i1",
      goal_id: "g1",
      business: "ventures",
      work_type: "product",
    });
  });

  it("lets a delegated task inherit from its parent and never overwrites what is set", () => {
    const db = database();
    db.exec(`
      INSERT INTO tasks (id,title,business,goal_id,initiative_id,work_type) VALUES ('parent','Plan','ventures','g1','i1','research');
      INSERT INTO tasks (id,title,source_task_id,department_id) VALUES ('child','Render mockups','parent','design');
      INSERT INTO tasks (id,title,work_type,importance,business) VALUES ('set','Anything','listing','routine','tech');
    `);
    expect(ensureTaskWorkModel(db, "child")).toMatchObject({
      initiative_id: "i1",
      goal_id: "g1",
      business: "ventures",
      work_type: "design",
    });
    expect(ensureTaskWorkModel(db, "set")).toMatchObject({
      work_type: "listing",
      importance: "routine",
      business: "tech",
    });
    expect(ensureTaskWorkModel(db, "missing")).toBeNull();
  });
});

describe("work folders", () => {
  it("keeps initiative work together inside the project folder, goal research per goal, and the rest in operations", () => {
    const db = database();
    const project = tempDir();
    const initiative = resolveWorkFolder(db, { initiative_id: "i1", goal_id: "g1", business: "ventures" }, project);
    expect(initiative).toBe(path.join(project, "initiatives", "wedding-budget-workbook-i1"));
    expect(fs.statSync(initiative).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(initiative, ".git"))).toBe(false);
    expect(resolveWorkFolder(db, { goal_id: "g1-long-id" }, project)).toBe(path.join(project, "goals", "g1-long-"));
    expect(resolveWorkFolder(db, { business: "tech" }, project)).toBe(path.join(project, "operations"));
  });

  it("never puts work files inside the ATLAS folder, even when the task resolves to it", () => {
    const db = database();
    const root = tempDir();
    const atlas = tempDir();
    process.env.ATLAS_WORK_DIR = root;
    expect(resolveWorkFolder(db, { business: "ventures" }, atlas, atlas)).toBe(
      path.join(root, "ventures", "operations"),
    );
    expect(resolveWorkFolder(db, { business: "ventures" }, path.join(atlas), atlas)).not.toContain(atlas);
    expect(fs.existsSync(path.join(atlas, "operations"))).toBe(false);
  });

  it("uses the work root, never the ATLAS folder, when the project has no folder", () => {
    const db = database();
    const root = tempDir();
    process.env.ATLAS_WORK_DIR = root;
    expect(resolveWorkFolder(db, { business: "rental" }, null)).toBe(path.join(root, "rental", "operations"));
    expect(resolveWorkFolder(db, { business: "rental" }, "C:/does/not/exist")).toBe(
      path.join(root, "rental", "operations"),
    );
    expect(resolveWorkFolder(db, {}, null)).toBe(path.join(root, "general", "operations"));
  });
});

describe("hand-offs", () => {
  it("saves the agent's hand-off, cleans it, and replaces it on a second call", () => {
    const db = database();
    expect(() => saveHandoff(db, "t1", { summary: "too short" })).toThrow("handoff_summary_too_short");
    const first = saveHandoff(
      db,
      "t1",
      {
        summary: "  Built the workbook: 12 sheets, budget, vendors and a timeline.  ",
        files: ["workbook.xlsx", { path: "preview.png", note: "listing image" }, { note: "no path" }],
        numbers: { sheets: 12, price: "$7.99", bad: { nested: true }, nan: Number.NaN },
        open_issues: "Needs an A4 version",
      },
      10,
    );
    expect(first).toMatchObject({
      summary: "Built the workbook: 12 sheets, budget, vendors and a timeline.",
      files: [
        { path: "workbook.xlsx", note: "" },
        { path: "preview.png", note: "listing image" },
      ],
      numbers: { sheets: 12, price: "$7.99" },
      generated: false,
    });
    saveHandoff(db, "t1", { summary: "Second version of the hand-off, with the A4 file added." }, 20);
    expect(getHandoff(db, "t1")).toMatchObject({
      summary: "Second version of the hand-off, with the A4 file added.",
      files: [],
      created_at: 10,
      updated_at: 20,
    });
  });

  it("writes one from the final output only when the agent skipped it", () => {
    const db = database();
    const generated = ensureHandoffAfterRun(db, "t2", `${"x".repeat(3000)} Final: strategy saved with 8 ideas.`);
    expect(generated?.generated).toBe(true);
    expect(generated?.summary.endsWith("Final: strategy saved with 8 ideas.")).toBe(true);
    expect(generated!.summary.length).toBeLessThanOrEqual(1200);
    saveHandoff(db, "t3", { summary: "The agent's own hand-off, kept as it is." });
    expect(ensureHandoffAfterRun(db, "t3", "Something else entirely at the end")?.generated).toBe(false);
    expect(ensureHandoffAfterRun(db, "t4", "")).toBeNull();
  });

  it("formats a hand-off for the next step and the reviewer", () => {
    const db = database();
    const handoff = saveHandoff(db, "t5", {
      summary: "Made three mockups for the workbook listing.",
      files: [{ path: "mockups/1.png", note: "hero" }],
      numbers: { images: 3 },
      next_step_notes: "Use 1.png as the first listing photo",
    });
    expect(formatHandoff(handoff, "[Previous step: mockups]")).toBe(
      [
        "[Previous step: mockups]",
        "Made three mockups for the workbook listing.",
        "Files:",
        "- mockups/1.png (hero)",
        "Key numbers:",
        "- images: 3",
        "For the next step: Use 1.png as the first listing photo",
      ].join("\n"),
    );
    expect(formatHandoff({ ...handoff, generated: true }, "[X]")).toContain("the agent skipped task.handoff");
  });
});
