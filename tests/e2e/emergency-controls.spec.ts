import { expect, test, type Page } from "@playwright/test";

/**
 * Browser checks for the owner's emergency controls. Runs against the isolated e2e database and never starts an
 * agent run: the only work-starting request made here is sent while everything is stopped, to prove it is refused.
 */

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await expect(page.locator("main header h1")).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // let button colour transitions finish
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function mode(page: Page): Promise<string> {
  const res = await page.request.get("/api/control");
  return (await res.json()).state.mode;
}

const controls = (page: Page) => page.getByRole("group", { name: "Emergency controls" });

test.describe("emergency controls", () => {
  test.use({ viewport: { width: 1440, height: 800 } });

  test.afterEach(async ({ page }) => {
    // Leave the runtime running for whichever spec comes next.
    if ((await mode(page)) !== "running") {
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => void dialog.accept());
      await openApp(page);
      await page
        .getByRole("status")
        .getByRole("button", { name: /Resume (everything|autonomy)/ })
        .click();
      await expect(page.getByRole("status")).toHaveCount(0);
    }
  });

  test("both buttons are on every page", async ({ page }) => {
    for (const path of ["/", "/work", "/tech", "/homelab", "/team", "/office", "/settings"]) {
      await openApp(page, path);
      await expect(controls(page).getByRole("button", { name: "Pause autonomy" })).toBeVisible();
      await expect(controls(page).getByRole("button", { name: "Stop everything" })).toBeVisible();
    }
    await shot(page, "controls-running");
  });

  test("pause autonomy shows a banner, reaches other open tabs, and resumes", async ({ page, context }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    const otherTab = await context.newPage();
    await openApp(otherTab, "/work");
    await openApp(page);

    await controls(page).getByRole("button", { name: "Pause autonomy" }).click();
    await expect(page.getByRole("status")).toContainText("Autonomy is paused");
    expect(await mode(page)).toBe("autonomy_paused");
    await shot(page, "controls-autonomy-paused");

    // The other tab learns about it over the live connection, without a reload.
    await expect(otherTab.getByRole("status")).toContainText("Autonomy is paused");

    // It survives a reload, and stopping everything is still one click away.
    await page.reload();
    await expect(page.getByRole("status")).toContainText("Autonomy is paused");
    await expect(controls(page).getByRole("button", { name: "Stop everything" })).toBeVisible();

    await page.getByRole("status").getByRole("button", { name: "Resume autonomy" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(await mode(page)).toBe("running");
    await expect(otherTab.getByRole("status")).toHaveCount(0);
  });

  test("stop everything refuses new work until the owner resumes", async ({ page }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await openApp(page);
    await controls(page).getByRole("button", { name: "Stop everything" }).click();
    await expect(page.getByRole("status")).toContainText("Everything is stopped");
    expect(await mode(page)).toBe("stopped");
    await shot(page, "controls-stopped");

    // An outside message that would normally start agent work is refused while stopped.
    const inbox = await page.request.post("/api/inbox", {
      headers: { "x-inbox-secret": "claw-e2e-inbox-secret" },
      data: { source: "e2e", text: "should not start anything" },
    });
    expect(inbox.status()).toBe(503);
    expect((await inbox.json()).error).toBe("runs_halted_by_owner");

    // First step back: only the owner's own work, autonomy still held.
    await page.getByRole("status").getByRole("button", { name: "Resume my work only" }).click();
    await expect(page.getByRole("status")).toContainText("Autonomy is paused");
    expect(await mode(page)).toBe("autonomy_paused");
  });

  test("declining the confirm changes nothing", async ({ page }) => {
    page.on("dialog", (dialog) => void dialog.dismiss());
    await openApp(page);
    await controls(page).getByRole("button", { name: "Stop everything" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(await mode(page)).toBe("running");
  });
});

test.describe("emergency controls on a phone", () => {
  test.use({ viewport: { width: 375, height: 760 } });

  test("both buttons fit in the header without sideways scrolling", async ({ page }) => {
    page.on("dialog", (dialog) => void dialog.accept());
    await openApp(page);
    await expect(controls(page).getByRole("button", { name: "Pause autonomy" })).toBeVisible();
    await expect(controls(page).getByRole("button", { name: "Stop everything" })).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);

    await controls(page).getByRole("button", { name: "Stop everything" }).click();
    await expect(page.getByRole("status")).toContainText("Everything is stopped");
    expect(await fits()).toBe(true);
    await shot(page, "controls-stopped-phone");

    await page.getByRole("status").getByRole("button", { name: "Resume everything" }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
  });
});
