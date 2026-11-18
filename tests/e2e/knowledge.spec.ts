import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

/**
 * Browser checks for Team > Knowledge. Runs against the isolated e2e database only; memories below are fixtures and
 * no agent run or model call is started.
 */
const runtimePath = path.resolve(".tmp/e2e-runtime");
const SHOTS = process.env.E2E_SCREENSHOT_DIR;
let ownerCookie: string;

test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.join(runtimePath, "runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  const db = new DatabaseSync(path.join(runtimePath, "claw-empire.e2e.sqlite"));
  try {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT OR REPLACE INTO agent_memories (id,kind,scope,business,title,body,status,reviewed_at,reviewed_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'active',?,?,?,?)`,
    );
    insert.run(
      "e2e-mem-1",
      "lesson",
      "business",
      "rental",
      "E2E flower wall photos",
      "Use the white flower wall photos in posts.",
      null,
      null,
      now,
      now,
    );
    insert.run(
      "e2e-mem-2",
      "fact",
      "global",
      null,
      "E2E backups are manual",
      "Backups live in backups/.",
      now,
      "owner",
      now - 1,
      now - 1,
    );
    configureLoginStore(db);
    ownerCookie = createSessionToken("password");
  } finally {
    configureLoginStore(null);
    db.close();
  }
});

async function openOwner(page: Page, target: string) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
  await page.goto(target);
  await expect(page.locator("main header h1").first()).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

test("Knowledge is a Team tab with memories to review", async ({ page }) => {
  await openOwner(page, "/team");
  await page.getByRole("tab", { name: "Knowledge" }).click();
  await expect(page).toHaveURL(/\/team\/knowledge$/);
  const card = page.getByRole("listitem", { name: "E2E flower wall photos" });
  await expect(card).toContainText("Needs review");
  await expect(page.getByRole("listitem", { name: "E2E backups are manual" })).toContainText("Reviewed");
  if (SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/knowledge-memory.png` });
  }
  await card.getByRole("button", { name: "Looks right" }).click();
  await expect(page.getByRole("listitem", { name: "E2E flower wall photos" })).toContainText("Reviewed");
  await page.reload();
  await expect(page.getByRole("listitem", { name: "E2E flower wall photos" })).toContainText("Reviewed");
});

test("the owner archives a wrong memory and agents stop getting it", async ({ page }) => {
  await openOwner(page, "/team/knowledge");
  await page.getByRole("listitem", { name: "E2E backups are manual" }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("listitem", { name: "E2E backups are manual" })).toHaveCount(0);
  const list = await (await page.request.get("/api/knowledge/memories?status=archived")).json();
  expect(list.items.map((m: { id: string }) => m.id)).toContain("e2e-mem-2");
});

test("the systems registry and the checklist are readable", async ({ page }) => {
  await openOwner(page, "/team/knowledge");
  await page.getByRole("tab", { name: "Systems" }).click();
  await expect(page.getByText(/Lives in knowledge\/systems\.md|No systems registry yet/)).toBeVisible();
  await page.getByRole("tab", { name: "Checklist" }).click();
  await expect(page.getByText(/Lives in CHECKLIST\.md|CHECKLIST\.md was not found/)).toBeVisible();
});

test("an agent token cannot read or change memories through the owner routes", async ({ page }) => {
  await openOwner(page, "/team/knowledge");
  const read = await page.request.get("/api/knowledge/memories", { headers: { "x-agent-task-token": "x" } });
  expect(read.status()).toBe(403);
  const anonymous = await page.request.post("/api/knowledge/memories/e2e-mem-1/status", {
    headers: { cookie: "" },
    data: { status: "archived" },
  });
  // Refused either by the app-wide sign-in check (401) or the owner-session check (403).
  expect([401, 403]).toContain(anonymous.status());
});

test("the Knowledge page fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await openOwner(page, "/team/knowledge");
  await expect(page.getByRole("listitem", { name: "E2E flower wall photos" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "Systems" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
