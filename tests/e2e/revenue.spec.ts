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
  // All payment rows below are disposable fixtures. No Square credentials or network calls exist in this spec.
  const db = new DatabaseSync(path.join(runtimePath, "claw-empire.e2e.sqlite"));
  try {
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO projects(id,name,project_path,core_goal,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run("e2e-revenue-project", "Revenue fixtures", runtimePath, "Inspect attributed revenue", now, now);
    db.prepare(
      "INSERT OR IGNORE INTO business_goals(id,business,metric,target,period_start,period_end,created_at,updated_at) VALUES('e2e-revenue-goal','ventures','verified_revenue',100,?,?,?,?)",
    ).run(now, now + 30 * 86_400_000, now, now);
    db.prepare(
      "INSERT OR IGNORE INTO initiatives(id,business,project_id,goal_id,title,status,created_at,updated_at) VALUES('e2e-revenue-initiative','ventures','e2e-revenue-project','e2e-revenue-goal','Dashboard initiative','launched',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT OR IGNORE INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,description,occurred_at,created_at,updated_at) VALUES('e2e-square-net-usd','ventures','revenue',1600,'USD','square_payment','fixture-square-usd',1,'Verified sample net receipt',?,?,?)",
    ).run(now, now, now);
    db.prepare(
      "INSERT OR IGNORE INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,description,occurred_at,created_at,updated_at) VALUES('e2e-square-net-jpy','ventures','revenue',431,'JPY','square_payment','fixture-square-jpy',1,'Verified JPY sample receipt',?,?,?)",
    ).run(now, now, now);
    configureLoginStore(db);
    ownerCookie = createSessionToken("password");
  } finally {
    configureLoginStore(null);
    db.close();
  }
});
async function openOwner(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "claw_session", value: ownerCookie, url: "http://127.0.0.1:8810", httpOnly: true, sameSite: "Strict" },
    ]);
  await page.goto("/revenue");
  await expect(page.locator("main header h1").first()).toHaveText("Revenue");
}

test("pipeline milestones require verified receipts for paid, attribution persists and currencies remain separate", async ({
  page,
}) => {
  await openOwner(page);
  await expect(page.getByRole("rowheader", { name: "Ventures · USD" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Ventures · JPY" })).toBeVisible();
  await page.getByRole("tab", { name: "Pipeline" }).click();
  await page.getByRole("button", { name: "Add deal" }).click();
  let form = page.getByRole("form", { name: "Deal", exact: true });
  await form.getByLabel("Deal title", { exact: true }).fill("Dashboard package fixture");
  await form.getByLabel("Expected amount", { exact: true }).fill("16.00");
  await form.getByLabel("Stage", { exact: true }).selectOption("won");
  await form.getByLabel("Product generated", { exact: true }).fill("2026-11-16T09:30");
  await form.getByLabel("Linked initiative", { exact: true }).selectOption("e2e-revenue-initiative");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  let deal = page.getByRole("listitem").filter({ has: page.getByText("Dashboard package fixture", { exact: true }) });
  await expect(deal.getByText("Not verified paid", { exact: true })).toBeVisible();
  await expect(deal.getByText("Unavailable: costs incomplete", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Records", exact: true }).click();
  const receipt = page
    .getByRole("listitem")
    .filter({ has: page.getByText("Verified sample net receipt", { exact: true }) });
  await receipt.getByRole("button", { name: "Link record" }).click();
  form = page.getByRole("form", { name: "Link record", exact: true });
  await form.getByLabel("Linked deal", { exact: true }).selectOption({ label: "Dashboard package fixture" });
  await form.getByLabel("Linked initiative", { exact: true }).selectOption("e2e-revenue-initiative");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("tab", { name: "Pipeline", exact: true }).click();
  deal = page.getByRole("listitem").filter({ has: page.getByText("Dashboard package fixture", { exact: true }) });
  await expect(deal.getByText("Sufficient linked verified receipts", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Pipeline", exact: true }).click();
  await expect(page.getByText("Sufficient linked verified receipts", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Initiative results" }).getByText(/USD · \$16.00 verified net receipts/),
  ).toBeVisible();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.E2E_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/revenue-${width}.png` });
  }
});

test("manual entries remain unverified and owner spending approval records permission only", async ({ page }) => {
  await openOwner(page);
  await page.getByRole("tab", { name: "Records", exact: true }).click();
  await page.getByRole("button", { name: "Add manual record" }).click();
  let form = page.getByRole("form", { name: "Manual record", exact: true });
  await form.getByLabel("Currency", { exact: true }).selectOption("KWD");
  await form.getByLabel("Amount", { exact: true }).fill("4.317");
  await form.getByLabel("Description", { exact: true }).fill("Recorded packaging estimate");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByText("Recorded packaging estimate", { exact: true }) });
  await expect(row.getByText(/Unverified manual record/)).toBeVisible();
  await expect(row.getByText(/4.317/)).toBeVisible();
  await page.getByRole("tab", { name: "Spending requests", exact: true }).click();
  await page.getByRole("button", { name: "Request spending" }).click();
  form = page.getByRole("form", { name: "Spending request", exact: true });
  await form.getByLabel("Amount", { exact: true }).fill("12.49");
  await form.getByLabel("Spending purpose", { exact: true }).fill("Evaluate a future asset license");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  const spending = page
    .getByRole("listitem")
    .filter({ has: page.getByText("Evaluate a future asset license", { exact: true }) });
  await spending.getByRole("button", { name: "Approve request" }).click();
  await expect(spending.getByText(/approved/)).toBeVisible();
  await expect(page.getByText(/An approval does not initiate payment/)).toBeVisible();
});

test("Square settings expose read-only setup without revealing or enabling credentials", async ({ page }) => {
  await openOwner(page);
  await page.goto("/settings?tab=business");
  await page.locator("summary").filter({ hasText: "Square payments" }).click();
  await expect(page.getByLabel("Square access token", { exact: true })).toHaveValue("");
  await expect(page.getByText(/No charges, refunds, transfers/)).toBeVisible();
  const response = await (await page.request.get("/api/square")).json();
  expect(response.connection.enabled).toBe(false);
  expect(response.connection.token_configured).toBe(false);
  expect(JSON.stringify(response)).not.toMatch(/token_enc|Authorization|Bearer/);
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
