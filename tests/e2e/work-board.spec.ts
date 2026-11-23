import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// The work screens (work restructure, phase 7) with a seeded goal, initiative and two step tasks. No model is called.
const runtimePath = path.resolve(".tmp/e2e-runtime");

test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.join(runtimePath, "runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  const db = new DatabaseSync(path.join(runtimePath, "atlas.e2e.sqlite"));
  try {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO business_goals(id,business,title,metric,target,period_start,period_end,created_at,updated_at)
       VALUES ('e2e-board-goal','ventures','Board check goal','verified_revenue',500,0,?,?,?)`,
    ).run(now + 30 * 86_400_000, now, now);
    db.prepare(
      `INSERT OR IGNORE INTO initiatives(id,business,goal_id,title,description,status,playbook,playbook_stage,created_at,updated_at)
       VALUES ('e2e-board-initiative','ventures','e2e-board-goal','Board check planner','A printable planner.','in_progress','etsy_digital','mockups',?,?)`,
    ).run(now, now);
    const task = db.prepare(
      `INSERT OR IGNORE INTO tasks(id,title,status,business,goal_id,initiative_id,work_type,importance,playbook_step,created_at,updated_at,completed_at)
       VALUES (?,?,?,'ventures','e2e-board-goal','e2e-board-initiative',?,?,?,?,?,?)`,
    );
    task.run(
      "e2e-board-build",
      "Board check: make the product",
      "done",
      "product",
      "important",
      "build",
      now,
      now,
      now,
    );
    task.run(
      "e2e-board-mockups",
      "Board check: mockups",
      "in_progress",
      "design",
      "routine",
      "mockups",
      now,
      now,
      null,
    );
    db.prepare(
      `INSERT OR IGNORE INTO task_handoffs(task_id,summary,files_json,numbers_json,open_issues,next_step_notes,generated,created_at,updated_at)
       VALUES ('e2e-board-build','Built the planner: 40 pages, PDF and source files.','[{"path":"products/planner.pdf","note":""}]','{}','','',0,?,?)`,
    ).run(now, now);
  } finally {
    db.close();
  }
});

for (const width of [1440, 375]) {
  test(`work board, initiative page and behind the scenes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/work");
    await expect(page.getByRole("tab", { name: "By goal", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Board check goal/ })).toBeVisible();
    const group = page.getByRole("region", { name: "Board check planner" });
    await expect(group.getByRole("button", { name: /Board check: mockups/ })).toBeVisible();
    await expect(group.getByRole("button", { name: /Board check: make the product/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

    await group.getByRole("button", { name: "Board check planner" }).click();
    await expect(page).toHaveURL(/initiative=e2e-board-initiative/);
    const panel = page.getByRole("dialog", { name: "Board check planner" });
    const steps = panel.getByRole("list", { name: "Steps" });
    await expect(steps.getByText("Make the product: Board check planner")).toBeVisible();
    await expect(steps.getByText("Built the planner: 40 pages, PDF and source files.")).toBeVisible();
    await expect(steps.getByText("Owner approves publishing: Board check planner")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // The classic board is one tab away, with its tools.
    await page.getByRole("tab", { name: "All tasks" }).click();
    await expect(page.getByRole("tab", { name: "All tasks", selected: true })).toBeVisible();
    await page.getByRole("tab", { name: "By goal" }).click();

    await page.goto("/team/behind-the-scenes");
    await expect(page.getByRole("region", { name: "Behind the scenes" }).getByRole("article").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
}
