import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { configureLoginStore, createSessionToken } from "../../server/security/login-sessions.ts";

/**
 * Browser checks for storefront listing packages. Runs against the isolated e2e database only: the packages below
 * are fixtures, nothing is published anywhere, and no agent run or model call is started.
 */
const runtimePath = path.resolve(".tmp/e2e-runtime");
const SHOTS = process.env.E2E_SCREENSHOT_DIR;
let ownerCookie: string;

test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.join(runtimePath, "runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  const db = new DatabaseSync(path.join(runtimePath, "atlas.e2e.sqlite"));
  try {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT OR REPLACE INTO listing_packages (id,business,platform,title,description,tags,price_minor,currency,files,mockups,
         notes,fee_minor,fee_currency,status,submitted_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'USD',?,?,?,?,'USD','ready',?,?,?)`,
    );
    insert.run(
      "e2e-listing-etsy",
      "ventures",
      "etsy",
      "E2E budget planner",
      "A one-page monthly budget planner. Buy once, print as often as you like.",
      JSON.stringify(["planner", "budget", "printable"]),
      450,
      JSON.stringify(["products/planner/planner.pdf"]),
      JSON.stringify(["products/planner/mockup.png"]),
      "Original work made for this fixture.",
      20,
      now,
      now,
      now,
    );
    insert.run(
      "e2e-listing-itch",
      "ventures",
      "itch",
      "E2E icon pack",
      "48 original UI icons as PNG and SVG.",
      JSON.stringify(["icons", "ui"]),
      300,
      JSON.stringify(["products/icons/icons.zip"]),
      JSON.stringify([]),
      "",
      0,
      now - 1000,
      now,
      now,
    );
    db.prepare("UPDATE listing_fee_budget SET monthly_cap_minor=0 WHERE id=1").run();
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

test("a paid listing waits for the owner on Today until a fee budget exists; a free one does not", async ({ page }) => {
  await openOwner(page, "/");
  const row = page.locator("li", { hasText: "E2E budget planner" });
  await expect(row).toContainText("Listing to publish");
  await expect(row).toContainText("costs a $0.20 platform fee, which is outside this month's listing fee budget");
  await expect(row).toContainText("Approving does not publish it");
  // The free itch.io pack is within VP authority, so it is not in the owner's queue.
  await expect(page.locator("li", { hasText: "E2E icon pack" })).toHaveCount(0);
});

test("the owner sets a budget, approves, publishes from the checklist and the fee is recorded", async ({ page }) => {
  await openOwner(page, "/ventures");
  const panel = page.getByRole("region", { name: "Listings" });
  await expect(panel.getByText("No budget set: every listing that costs a fee needs your approval.")).toBeVisible();
  const waiting = panel.getByRole("region", { name: "Waiting for approval" });
  await expect(waiting.getByRole("listitem", { name: "E2E budget planner" })).toContainText("needs your approval");
  await expect(waiting.getByRole("listitem", { name: "E2E icon pack" })).toContainText("the VPs can approve this");

  await panel.getByLabel("Monthly listing fee budget (USD)").fill("5.00");
  await panel.getByRole("button", { name: "Save budget" }).click();
  await expect(panel.getByText("$0.00 of $5.00 used in")).toBeVisible();
  // Inside the budget the same package no longer needs the owner.
  await expect(waiting.getByRole("listitem", { name: "E2E budget planner" })).toContainText("the VPs can approve this");

  await waiting
    .getByRole("listitem", { name: "E2E budget planner" })
    .getByRole("button", { name: "Approve for publishing" })
    .click();
  const ready = panel.getByRole("region", { name: "Ready to publish" });
  const card = ready.getByRole("listitem", { name: "E2E budget planner" });
  await expect(card).toContainText("products/planner/planner.pdf");
  await expect(card).toContainText("planner, budget, printable");
  await expect(panel.getByText("$0.20 of $5.00 used in")).toBeVisible();
  if (SHOTS) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/listings-ready.png`, fullPage: true });
  }

  await card
    .getByLabel("After you publish it on Etsy, paste the listing address")
    .fill("https://www.etsy.com/listing/000000/e2e-budget-planner");
  await card.getByRole("button", { name: "Mark published" }).click();
  const published = panel.getByRole("region", { name: "Published" });
  await expect(published.getByRole("listitem", { name: "E2E budget planner" })).toBeVisible();
  await expect(published.getByRole("link", { name: "Open listing" })).toHaveAttribute(
    "href",
    "https://www.etsy.com/listing/000000/e2e-budget-planner",
  );

  // It survives a reload, and the fee shows up in Revenue as an unverified cost.
  await page.reload();
  await expect(panel.getByRole("region", { name: "Published" }).getByRole("listitem")).toHaveCount(1);
  const finance = await (await page.request.get("/api/finance?business=ventures")).json();
  const fee = finance.ledger.find((entry: { description: string }) => entry.description.includes("Etsy listing fee"));
  expect(fee).toMatchObject({ kind: "expense", amount_minor: 20, currency: "USD", source: "manual", verified: 0 });
});

test("a visitor without the owner's password cannot change listings", async ({ page }) => {
  await page.goto("/ventures");
  await expect(page.locator("main header h1").first()).toBeVisible({ timeout: 30_000 });
  const denied = await page.request.post("/api/listings/e2e-listing-itch/decide", { data: { approve: true } });
  expect(denied.status()).toBe(403);
  const budget = await page.request.put("/api/listings/budget", { data: { monthly_cap_minor: 99999 } });
  expect(budget.status()).toBe(403);
});

test("the listings panel fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await openOwner(page, "/ventures");
  await expect(page.getByRole("region", { name: "Listings" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
