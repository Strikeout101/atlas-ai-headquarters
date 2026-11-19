import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

// Uses only the isolated browser-test runtime and its own database.
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

async function signIn(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
}

test("Etsy and image studio cards keep secrets out of the page and fit a phone", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings?tab=business");
  const etsy = page.getByRole("region", { name: "Etsy" });
  await expect(etsy.getByText("Not connected")).toBeVisible();
  await etsy.getByLabel("App keystring").fill("e2ekeystring");
  await etsy.getByLabel(/Shared secret/).fill("e2e-secret-value");
  await etsy.getByRole("button", { name: "Save app details" }).click();
  await expect(etsy.getByText("Saved.")).toBeVisible();
  const settings = await (await page.request.get("/api/etsy")).json();
  expect(settings.settings).toMatchObject({ keystring: "e2ekeystring", shared_secret_set: true, connected: false });
  expect(JSON.stringify(settings)).not.toContain("e2e-secret-value");
  await expect(page.getByRole("region", { name: "Image studio" }).getByText(/AI images off/)).toBeVisible();
  const anonymous = await page.context().request.fetch("/api/etsy", { headers: { "x-agent-task-token": "nope" } });
  expect([401, 403]).toContain(anonymous.status());
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a monthly cost shows in profit, and stop rules and playbooks are owner settings", async ({ page }) => {
  await signIn(page);
  await page.goto("/revenue");
  const profit = page.getByRole("region", { name: "Profit" });
  await profit.getByRole("button", { name: "Add a monthly cost" }).click();
  const form = profit.getByRole("form", { name: "Add a monthly cost" });
  await form.getByLabel("Name").fill("E2E subscription");
  await form.getByLabel("USD a month").fill("20");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(profit.getByRole("list", { name: "Monthly costs" }).getByText(/E2E subscription/)).toBeVisible();
  await expect(profit.getByText("Profit (estimate)")).toBeVisible();

  await page.goto("/autonomy");
  await page.locator("summary").filter({ hasText: "Stop rules" }).click();
  const rules = page.getByRole("form", { name: "Stop rules" });
  await rules.getByLabel(/days live with no sale/).fill("21");
  await rules.getByRole("button", { name: "Save stop rules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const overview = await (await page.request.get("/api/autonomy")).json();
  expect(overview.experiment_rules.no_sale_days_after_launch).toBe(21);
  expect(overview.playbooks.map((p: { key: string }) => p.key)).toContain("etsy_digital");
  await page.locator("summary").filter({ hasText: "Playbooks" }).click();
  await expect(page.getByRole("region", { name: "Playbook Etsy digital products" })).toBeVisible();
});

test("the income stream page shows a business on one screen and fits a phone", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/revenue");
  await page.getByRole("tab", { name: "Income streams" }).click();
  const stream = page.getByRole("region", { name: "Income stream" });
  await expect(stream.getByRole("button", { name: "Ventures" })).toHaveAttribute("aria-pressed", "true");
  await expect(stream.getByRole("heading", { name: "What the engine does next" })).toBeVisible();
  await stream.getByRole("button", { name: "Tech Services" }).click();
  await expect(stream.getByRole("button", { name: "Tech Services" })).toHaveAttribute("aria-pressed", "true");
  await expect(stream.getByRole("heading", { name: "Goals" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
