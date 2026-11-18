import { expect, test } from "@playwright/test";

// The global preflight verifies the disposable API DB before the browser starts.
// This page exercises the settings UI with synthetic provider metadata; no model is called.
for (const width of [1440, 375]) {
  test(`models and workers controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    let config = {
      ok: true,
      directorAgentId: null,
      technicalDirectorAgentId: null as string | null,
      designDirectorAgentId: null as string | null,
      candidates: {},
      directors: [
        { id: "technical", name: "Technical lead", cli_provider: "codex", status: "idle" },
        { id: "design", name: "Design lead", cli_provider: "claude", status: "idle" },
      ],
      localRouting: {
        enabled: false,
        apiProviderId: null as string | null,
        model: null as string | null,
        taskTypes: ["documentation", "analysis"],
        contextWindowTokens: 4096,
      },
      localProviders: [{ id: "precision", name: "Precision", enabled: true, models: ["qwen-routine"] }],
      performance: [
        {
          agent_id: "technical",
          provider: "codex",
          model: "worker-model",
          runs: 3,
          successes: 1,
          failures: 1,
          cancelled: 1,
          success_rate: 0.5,
          rework_runs: 1,
          cost_usd: null,
          cost_reported_runs: 0,
          input_tokens: 100,
          output_tokens: 20,
        },
      ],
    };
    await page.route("**/api/model-director", async (route) => {
      if (route.request().method() === "PUT") config = { ...config, ...route.request().postDataJSON() };
      await route.fulfill({ json: config });
    });
    await page.goto("/team/models");
    await page.getByLabel("technical director", { exact: true }).selectOption("technical");
    await page.getByLabel("design director", { exact: true }).selectOption("design");
    await page.getByLabel("Ollama host", { exact: true }).selectOption("precision");
    await page.getByLabel("Local model", { exact: true }).selectOption("qwen-routine");
    await page.getByLabel("Route selected routine tasks locally").check();
    await page.getByRole("button", { name: "Save director settings" }).click();
    await expect.poll(() => config.localRouting.enabled).toBe(true);
    await page.reload();
    await expect(page.getByLabel("technical director", { exact: true })).toHaveValue("technical");
    await expect(page.getByLabel("design director", { exact: true })).toHaveValue("design");
    await expect(page.getByLabel("Local model", { exact: true })).toHaveValue("qwen-routine");
    await expect(page.getByRole("heading", { name: "Worker performance" })).toBeVisible();
    await expect(page.getByText("codex/worker-model", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.tmp/section11-qa/models-${width}.png`, fullPage: true });
  });
}
