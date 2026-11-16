import { expect, test, type Page } from "@playwright/test";

/**
 * Browser checks for the third business, the AI-run ventures. Runs against the isolated e2e database and never
 * starts an agent run or contacts a mail server.
 */

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("main header h1")).toBeVisible({ timeout: 30_000 });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("Ventures has its own page with customers and message drafts", async ({ page }) => {
  await openApp(page);
  await page.getByRole("navigation", { name: "Main" }).first().getByRole("button", { name: "Ventures" }).click();
  await expect(page).toHaveURL(/\/ventures$/);
  await expect(page.locator("main header h1")).toHaveText("Ventures");
  await expect(page.getByRole("heading", { level: 1, name: "Ventures" }).last()).toBeVisible();
  // Tickets and rental quotes belong to the other two businesses.
  await expect(page.getByText("Service tickets")).toHaveCount(0);
  await expect(page.getByText("Rental quotes")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("main header h1")).toHaveText("Ventures");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ventures-page.png` });
});

test("Outreach can switch to the ventures business", async ({ page }) => {
  await openApp(page, "/outreach");
  const switcher = page.getByRole("group", { name: "Business" });
  await switcher.getByRole("button", { name: "Ventures" }).click();
  await expect(switcher.getByRole("button", { name: "Ventures" })).toHaveAttribute("aria-pressed", "true");
});

test("Settings offers a ventures mailbox with a choice of mail encryption", async ({ page }) => {
  await openApp(page, "/settings?tab=business");
  await page.getByText("Mailcow connections", { exact: true }).click();
  const ventures = page.getByRole("region", { name: "Ventures mailboxes" });
  await expect(ventures).toBeVisible();
  await ventures.getByRole("button", { name: "Add mailbox" }).click();
  await expect(ventures.getByLabel("IMAP encryption")).toHaveValue("tls");
  await ventures.getByLabel("SMTP encryption").selectOption("starttls");
  await expect(ventures.getByLabel("SMTP encryption")).toHaveValue("starttls");
  if (SHOTS) {
    await ventures.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/ventures-mailbox.png` });
  }
});
