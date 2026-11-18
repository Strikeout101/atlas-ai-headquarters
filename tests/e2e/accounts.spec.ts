import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

// No GitHub or Square credentials exist in this spec, and nothing here contacts either service.
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

async function openBusinessSettings(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
  await page.goto("/settings?tab=business");
  await expect(page.getByRole("heading", { name: "Business settings", exact: true })).toBeVisible();
}

test("approval levels are settings that persist after reload", async ({ page }) => {
  await openBusinessSettings(page);
  await page
    .locator("summary")
    .filter({ hasText: /^Approvals/ })
    .click();
  const rental = page.getByRole("group", { name: "Events and rentals approvals" });
  await expect(rental.getByLabel("Agent changes to contacts, tickets, quotes and deals")).toHaveValue("owner");
  const tech = page.getByRole("group", { name: "Tech services approvals" });
  const pushes = tech.getByLabel("Pushing reviewed code to GitHub");
  await expect(pushes).toHaveValue("none");
  await pushes.selectOption("vp");
  await expect(page.getByText("Tech services approvals saved.")).toBeVisible();
  await expect(
    page.getByText(/Spending money, paid accounts, accepting terms and destructive SSH always need you/),
  ).toBeVisible();

  await page.reload();
  await page
    .locator("summary")
    .filter({ hasText: /^Approvals/ })
    .click();
  await expect(
    page.getByRole("group", { name: "Tech services approvals" }).getByLabel("Pushing reviewed code to GitHub"),
  ).toHaveValue("vp");
  const policies = await (await page.request.get("/api/business/policies")).json();
  expect(JSON.stringify(policies)).toContain('"code_pushes":"vp"');
  await page
    .getByRole("group", { name: "Tech services approvals" })
    .getByLabel("Pushing reviewed code to GitHub")
    .selectOption("none");
  await expect(page.getByText("Tech services approvals saved.")).toBeVisible();
});

test("deal-size limit and spending budgets are owner settings that persist", async ({ page }) => {
  await openBusinessSettings(page);
  await page
    .locator("summary")
    .filter({ hasText: /^Approvals/ })
    .click();
  const tech = page.getByRole("group", { name: "Tech services approvals" });
  const limit = tech.getByLabel("Deals and quotes this big come to me");
  await expect(limit).toHaveValue("1000");
  await expect(tech.getByLabel("Important clients")).toHaveValue("important");
  await limit.fill("2500");
  await limit.press("Enter");
  await expect(page.getByText("Tech services approvals saved.")).toBeVisible();

  await page
    .locator("summary")
    .filter({ hasText: /^Spending budgets/ })
    .click();
  await expect(page.getByText(/ATLAS never pays for anything itself/)).toBeVisible();
  const hosting = page.getByRole("form", { name: "Hosting and domains budget" });
  await hosting.getByLabel("Monthly budget (USD)").fill("50");
  await hosting.getByLabel("Per item (USD)").fill("20");
  await hosting.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Hosting and domains budget saved.")).toBeVisible();

  await page.reload();
  const policies = await (await page.request.get("/api/business/policies")).json();
  expect(policies.items.find((p: { business: string }) => p.business === "tech").owner_amount_minor).toBe(250000);
  const budgets = await (await page.request.get("/api/business/spend-budgets")).json();
  expect(
    budgets.items.find(
      (b: { business: string; category: string }) => b.business === "tech" && b.category === "hosting",
    ),
  ).toMatchObject({ monthly_cap_minor: 5000, per_item_cap_minor: 2000 });

  await page
    .locator("summary")
    .filter({ hasText: /^Spending budgets/ })
    .click();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/e2e-budgets-phone.png", fullPage: false });
});

test("GitHub and Square account screens never show tokens and fit a phone", async ({ page }) => {
  await openBusinessSettings(page);
  await page
    .locator("summary")
    .filter({ hasText: /^GitHub accounts/ })
    .click();
  await expect(page.getByText(/No GitHub accounts yet/)).toBeVisible();
  const form = page.getByRole("form", { name: "Add GitHub account" });
  await expect(form.getByLabel("Fine-grained token")).toHaveAttribute("type", "password");
  await expect(form.getByLabel("Fine-grained token")).toHaveValue("");

  await page.locator("summary").filter({ hasText: "Square payments" }).click();
  const main = page.getByRole("region", { name: "Main Square account" });
  await expect(main.getByLabel("Square access token", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Add another Square account" })).toBeVisible();

  const github = await (await page.request.get("/api/github-accounts")).json();
  const square = await (await page.request.get("/api/square/connections")).json();
  expect(JSON.stringify([github, square])).not.toMatch(/token_enc|Authorization|Bearer|github_pat_/);

  await page.screenshot({ path: ".tmp/e2e-accounts-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".tmp/e2e-accounts-phone.png", fullPage: true });
});
