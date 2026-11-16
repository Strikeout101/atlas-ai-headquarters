import { test, expect } from "@playwright/test";

test("owner can review an exact email and explicitly approve sending from Today", async ({ page }) => {
  let pending = true;
  const item = {
    kind: "business_email",
    id: "browser-email",
    created_at: Date.now(),
    task_id: "test-task",
    task_title: "Test email",
    agent_id: "worker",
    agent_name: "Felix",
    business: "tech",
    sender: "info@example.com",
    recipient: "owner@example.net",
    subject: "Exact approval browser check",
    body: "This exact body is approved once.",
  };
  await page.route("**/api/approvals", (route) =>
    route.fulfill({ json: { ok: true, count: pending ? 1 : 0, items: pending ? [item] : [] } }),
  );
  // The send endpoint is mocked; this browser test must never contact a mail server.
  await page.route("**/api/business/email-approvals/browser-email/decide", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ approve: true });
    pending = false;
    await route.fulfill({ json: { ok: true, item: { ...item, status: "sent" } } });
  });
  await page.goto("/");
  await expect(page.getByText("From: info@example.com")).toBeVisible();
  await expect(page.getByText("To: owner@example.net")).toBeVisible();
  await expect(page.getByText(item.body)).toBeVisible();
  await page.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByText("From: info@example.com")).not.toBeVisible();
});

test("business settings retain profiles and nonsecret Mailcow configuration after reload", async ({ page }) => {
  await page.goto("/settings?tab=business");
  await expect(page.getByRole("heading", { name: "Business settings", exact: true })).toBeVisible();
  await page.getByText("Business profiles", { exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Tech services$/ })
    .click();
  await page.locator("#tech-name").fill("Business settings browser check");
  await page.locator("#tech-brand_voice").fill("Clear, helpful, and practical");
  await page
    .locator("#tech-name")
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Save business profile" })
    .click();
  await expect(page.getByText("Business profile saved.")).toBeVisible();
  await page.getByText("Mailcow connections", { exact: true }).click();
  const techMailboxes = page.getByRole("region", { name: "Tech mailboxes" });
  await techMailboxes.getByRole("button", { name: "Add mailbox", exact: true }).click();
  const mailbox = page.locator("#mailbox-new-tech-email").locator("xpath=ancestor::form");
  await mailbox.getByLabel("Mailbox address", { exact: true }).fill("info@example.com");
  await mailbox.getByLabel("IMAP hostname").fill("mail.example.com");
  await mailbox.getByLabel("SMTP hostname").fill("mail.example.com");
  await mailbox.getByRole("button", { name: "Add mailbox", exact: true }).click();
  await expect(techMailboxes.locator("summary").filter({ hasText: "info@example.com" })).toBeVisible();
  await techMailboxes.getByRole("button", { name: "Add mailbox", exact: true }).click();
  await page.locator("#mailbox-new-tech-email").fill("sales@example.com");
  await expect(page.locator("#mailbox-new-tech-imap_host")).toHaveValue("mail.example.com");
  await page
    .locator("#mailbox-new-tech-email")
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Add mailbox", exact: true })
    .click();
  await techMailboxes.locator("summary").filter({ hasText: "sales@example.com" }).click();
  await techMailboxes.getByRole("button", { name: "Use as default sender" }).click();
  await expect(techMailboxes.locator("summary").filter({ hasText: "sales@example.com" })).toContainText("Default");
  await page.reload();
  await page.getByText("Business profiles", { exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Business settings browser check$/ })
    .click();
  await expect(page.locator("#tech-name")).toHaveValue("Business settings browser check");
  await expect(page.locator("#tech-brand_voice")).toHaveValue("Clear, helpful, and practical");
  await page.getByText("Mailcow connections", { exact: true }).click();
  await expect(techMailboxes.locator("summary").filter({ hasText: "sales@example.com" })).toContainText("Default");
  await techMailboxes.locator("summary").filter({ hasText: "info@example.com" }).click();
  const savedMailbox = techMailboxes
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: "info@example.com" }) })
    .locator("form");
  await expect(savedMailbox.getByLabel("Mailbox address", { exact: true })).toHaveValue("info@example.com");
  await expect(savedMailbox.getByLabel("Mailbox password", { exact: true })).toHaveValue("");
  await expect(savedMailbox.getByRole("button", { name: "Test saved connection" })).toBeDisabled();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Instagram profiles save for planning without claiming a live connection", async ({ page }) => {
  await page.goto("/settings?tab=business");
  await page.getByText("Social accounts", { exact: true }).click();
  const rental = page.getByRole("region", { name: "Rental social accounts" });
  await rental.getByRole("button", { name: "Add Instagram", exact: true }).click();
  await page.locator("#social-new-rental-username").fill("primroseevents_");
  await rental.getByRole("button", { name: "Add Instagram account", exact: true }).click();
  const summary = rental.locator("summary").filter({ hasText: "@primroseevents_" });
  await expect(summary).toContainText("Not connected");
  await summary.click();
  await expect(rental.getByRole("button", { name: "Verify saved connection" })).toBeDisabled();
  await expect(rental.getByRole("button", { name: "Load recent posts" })).toBeDisabled();
  await page.reload();
  await page.getByText("Social accounts", { exact: true }).click();
  await expect(summary).toContainText("Not connected");
});

test("all Settings tabs share the wide centered layout and disclosures without an SSH tab", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  for (const tab of ["general", "business", "security", "cli", "oauth", "api", "gateway"]) {
    await page.goto(`/settings?tab=${tab}`);
    const layout = page.locator("[data-settings-layout]");
    await expect(layout).toBeVisible();
    await expect(layout.locator("details > summary").first()).toBeVisible();
    const box = await layout.boundingBox();
    expect(box!.width).toBeGreaterThan(900);
    expect(box!.width).toBeLessThanOrEqual(1400);
    await expect(page.getByRole("tab", { name: "SSH hosts" })).toHaveCount(0);
  }
  await page.goto("/settings?tab=business");
  await expect(page.getByRole("heading", { name: "Business settings" })).toBeVisible();
  await page.screenshot({ path: ".tmp/settings-businesses-wide.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: ".tmp/settings-businesses-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
