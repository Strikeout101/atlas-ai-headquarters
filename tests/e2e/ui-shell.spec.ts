import { expect, test, type Page } from "@playwright/test";

/**
 * Browser checks for the ATLAS shell: navigation, addresses, the command bar, Team and Settings tabs, the business
 * workspaces and the task drawer. Runs against the isolated e2e database and never starts an agent run.
 */

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" }).first();

async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("main header h1")).toBeVisible({ timeout: 30_000 });
}

test.describe("ATLAS shell", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("opens on Today and lists every area in the sidebar", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("main h2", { hasText: "Today" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("ATLAS");
    for (const label of [
      "Today",
      "Work",
      "Tech Services",
      "Events and Rentals",
      "Ventures",
      "Outreach",
      "Homelab",
      "Team",
      "Office",
      "Settings",
    ]) {
      await expect(sidebar(page).getByRole("button", { name: label, exact: false }).first()).toBeVisible();
    }
  });

  test("gives every page an address that survives reloads and Back", async ({ page }) => {
    await openApp(page);
    await sidebar(page).getByRole("button", { name: "Work" }).click();
    await expect(page).toHaveURL(/\/work$/);
    await sidebar(page).getByRole("button", { name: "Homelab" }).click();
    await expect(page).toHaveURL(/\/homelab$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/work$/);
    await page.reload();
    await expect(page.locator("header h1")).toHaveText("Work");
  });

  test("keeps old Business links working", async ({ page }) => {
    await openApp(page, "/business");
    await expect(page.locator("main header h1")).toHaveText("Tech Services");
  });

  test("command bar jumps to pages and settings tabs", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Control+k");
    const search = page.getByPlaceholder("Search pages, actions, agents and tasks…");
    await expect(search).toBeFocused();
    await search.fill("outreach");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/outreach$/);

    await page.keyboard.press("Control+k");
    await page.getByPlaceholder("Search pages, actions, agents and tasks…").fill("ollama");
    await expect(page.getByRole("option", { name: /Settings › API/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\?tab=api$/);
    await expect(page.getByRole("tab", { name: "API", selected: true })).toBeVisible();
  });

  test("Team is one area with three tabs and the renamed default agents", async ({ page }) => {
    await openApp(page, "/team");
    const tabs = page.getByRole("tablist", { name: "Team" });
    await expect(tabs.getByRole("tab", { name: "Agents", selected: true })).toBeVisible();
    await expect(page.getByText("Marcus").first()).toBeVisible();
    await tabs.getByRole("tab", { name: "Model Director" }).click();
    await expect(page).toHaveURL(/\/team\/models$/);
    await expect(sidebar(page).locator('[aria-current="page"]')).toContainText("Team");
  });

  test("Settings removes the obsolete SSH tab while Homelab remains available", async ({ page }) => {
    await openApp(page, "/settings?tab=ssh");
    await expect(page.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=general/);
    await expect(page.getByRole("tab", { name: "SSH hosts" })).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: "Homelab", exact: false }).click();
    await expect(page).toHaveURL(/\/homelab$/);
  });

  test("task drawer opens from the board and by link, and closes with Escape", async ({ page, request }) => {
    const session = await request.get("/api/auth/session");
    const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
    const created = await request.post("/api/tasks", {
      headers: { "x-csrf-token": csrf },
      data: { title: "E2E drawer task", description: "No agent, never runs.", status: "inbox", priority: 2 },
    });
    expect(created.ok()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    try {
      await openApp(page, "/work");
      await page.getByRole("button", { name: "E2E drawer task" }).click();
      const drawer = page.getByRole("dialog", { name: "E2E drawer task" });
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`task=${id}`));
      await drawer.getByRole("button", { name: /Run/ }).click();
      await expect(drawer.getByText("Please assign an agent!")).toBeVisible();

      await page.reload();
      await expect(page.getByRole("dialog", { name: "E2E drawer task" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "E2E drawer task" })).toBeHidden();
      await expect(page).toHaveURL(/\/work$/);
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers: { "x-csrf-token": csrf } });
    }
  });
});

test.describe("ATLAS shell on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("bottom tabs, menu, Escape and backdrop work without Office", async ({ page }) => {
    await openApp(page, "/office");
    await expect(page).toHaveURL(/\/$/);
    const tabs = page.getByRole("navigation", { name: "Main", exact: true }).last();
    await expect(tabs.getByRole("button", { name: "Today" })).toBeVisible();
    for (const [label, path] of [
      ["Work", "/work"],
      ["Autonomy", "/autonomy"],
      ["Revenue", "/revenue"],
    ]) {
      await tabs.getByRole("button", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
    await tabs.getByRole("button", { name: "Menu", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Office", exact: true })).toHaveCount(0);
    const bounds = await drawer.locator("aside").boundingBox();
    expect(bounds?.x).toBe(0);
    await page.screenshot({ path: ".tmp/phone-menu.png" });
    await drawer.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(drawer).toHaveCount(0);
    await tabs.getByRole("button", { name: "Menu", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
    await tabs.getByRole("button", { name: "Menu", exact: true }).click();
    await page.mouse.click(350, 400);
    await expect(drawer).toHaveCount(0);
    await tabs.getByRole("button", { name: "Today" }).click();
    await expect(page.locator("main h2", { hasText: "Today" })).toBeVisible();
    await page.screenshot({ path: ".tmp/phone-layout.png" });
  });

  test("landscape touch phones keep phone navigation; desktop resizing restores Office", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page);
    await page.setViewportSize({ width: 1100, height: 440 });
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByRole("button", { name: "Office", exact: true })).toBeVisible();
  });

  test("no page scrolls sideways", async ({ page }) => {
    await openApp(page);
    for (const path of [
      "/",
      "/work",
      "/autonomy",
      "/revenue",
      "/tech",
      "/events",
      "/ventures",
      "/outreach",
      "/homelab",
      "/team",
      "/settings",
    ]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `${path} scrolls sideways`).toBe(false);
    }
  });
});
