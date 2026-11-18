import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

// Uses only the isolated browser-test runtime and its own database; backups land in .tmp/e2e-runtime/backups.
const runtimePath = path.resolve(".tmp/e2e-runtime");
let ownerCookie: string;

test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.join(runtimePath, "runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  const db = new DatabaseSync(path.join(runtimePath, "claw-empire.e2e.sqlite"));
  try {
    configureLoginStore(db);
    ownerCookie = createSessionToken("password");
  } finally {
    configureLoginStore(null);
    db.close();
  }
});

async function openGeneral(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
  await page.goto("/settings?tab=general");
}

test("service panel explains dev mode, and a manual backup is saved and restore-checked", async ({ page }) => {
  await openGeneral(page);
  await page.locator("summary").filter({ hasText: "Not running as a service" }).click();
  await expect(page.getByText(/atlas-service.ps1 install/)).toBeVisible();
  await expect(page.getByText("Auto Update (Global)")).toHaveCount(0);

  await page
    .locator("summary")
    .filter({ hasText: /^Backups/ })
    .click();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText(/Backup saved and checked/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent backups" }).getByText("checked OK").first()).toBeVisible();

  const form = page.getByRole("form", { name: "Copy backups off this PC" });
  await form.getByLabel(/Copy backups off this PC/).fill("Z:\\definitely\\missing\\folder");
  await form.getByRole("button", { name: "Test and save folder" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const overview = await (await page.request.get("/api/backups")).json();
  expect(overview.settings.copy_dir).toBeNull();
  expect(overview.last_good.check_detail).toContain("integrity ok");

  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/e2e-backups-phone.png", fullPage: false });
});

test("upstream updates stay locked and agents cannot reach system routes", async ({ page, request }) => {
  await openGeneral(page);
  const status = await (await page.request.get("/api/update-status")).json();
  expect(status).toMatchObject({ enabled: false, error: "upstream_updates_disabled_in_atlas" });
  const anonymous = await request.get("/api/backups");
  expect([401, 403]).toContain(anonymous.status());
  const agent = await request.get("/api/system/service", { headers: { "x-agent-task-token": "not-a-real-token" } });
  expect([401, 403]).toContain(agent.status());
});
