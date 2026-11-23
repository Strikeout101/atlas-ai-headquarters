import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

const runtimePath = path.resolve(".tmp/e2e-runtime");
let ownerCookie: string;
test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.join(runtimePath, "runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  // Mutation begins only after the browser-facing server proves its disposable DB marker.
  const db = new DatabaseSync(path.join(runtimePath, "atlas.e2e.sqlite"));
  try {
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO projects(id,name,project_path,core_goal,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run("e2e-autonomy-project", "Research workspace", runtimePath, "Research contacts and prepare drafts", now, now);
    db.prepare(
      "INSERT INTO autonomy_ledger(event,business,message,created_at) SELECT 'schedule_skipped','tech',?,? WHERE NOT EXISTS(SELECT 1 FROM autonomy_ledger WHERE message=?)",
    ).run("Research waited for subscription headroom", now, "Research waited for subscription headroom");
    configureLoginStore(db);
    ownerCookie = createSessionToken("password");
  } finally {
    configureLoginStore(null);
    db.close();
  }
});

async function openOwner(page: Page, url: string) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
  await page.goto(url);
  await expect(page.locator("main header h1").first()).toBeVisible();
}

test("goals, initiative edits and paused lead research persist on desktop and phone", async ({ page }) => {
  await openOwner(page, "/autonomy");
  await expect(page.getByRole("heading", { name: "Autonomy" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Add goals" }).click();
  let form = page.getByRole("form", { name: "Add goals" });
  await expect(form.getByLabel("Project", { exact: true })).toHaveValue("");
  await form.getByLabel("Project", { exact: true }).selectOption("e2e-autonomy-project");
  await form.getByLabel("Goal title", { exact: true }).fill("Finish seven research tasks");
  await form.getByLabel("Target", { exact: true }).fill("7");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  const goal = page.getByRole("region", { name: "Finish seven research tasks" });
  await expect(goal.getByText("0 / 7")).toBeVisible();
  await expect(goal.getByText("The team will research a strategy for this goal.")).toBeVisible();
  await page.getByRole("tab", { name: /Initiatives/ }).click();
  await page.getByRole("button", { name: "Add initiatives" }).click();
  form = page.getByRole("form", { name: "Add initiatives" });
  await form.getByLabel("Project", { exact: true }).selectOption("e2e-autonomy-project");
  await form.getByLabel("Title", { exact: true }).fill("Inspect demand for event dashboards");
  await form
    .getByLabel("Description", { exact: true })
    .fill("Research existing workflows and prepare an internal demo.");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Inspect demand for event dashboards", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  form = page.getByRole("form", { name: "Edit initiatives" });
  await form.getByLabel("Title", { exact: true }).fill("Inspect event dashboard demand");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Inspect event dashboard demand", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Schedules/ }).click();
  await page.getByRole("button", { name: "Lead research preset" }).click();
  form = page.getByRole("form", { name: "Add schedules" });
  await form.getByLabel("Project", { exact: true }).selectOption("e2e-autonomy-project");
  await expect(form.getByLabel("Enable schedule", { exact: true })).not.toBeChecked();
  await expect(form.getByLabel("Description", { exact: true })).toHaveValue(/Do not send messages/);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Research local leads", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: /Schedules/ }).click();
  await expect(page.getByText("Research local leads", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("Research local leads", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.E2E_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/autonomy-${width}.png` });
  }
});

test("Today keeps the activity digest until explicitly marked read", async ({ page }) => {
  await openOwner(page, "/");
  await expect(page.getByText("Research waited for subscription headroom", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Research waited for subscription headroom", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(page.getByText("Research waited for subscription headroom", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Research waited for subscription headroom", { exact: true })).toHaveCount(0);
});
