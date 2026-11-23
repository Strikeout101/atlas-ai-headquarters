import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { approvalSnapshot } from "../../server/modules/approval-review-state.ts";

test.beforeAll(async ({ request }) => {
  const runtimeId = fs.readFileSync(path.resolve(".tmp/e2e-runtime/runtime-id.txt"), "utf8").trim();
  await request.get("/api/auth/session");
  const settings = await (await request.get("/api/settings")).json();
  expect(settings.settings.__e2eRuntimeId).toBe(runtimeId);
  const db = new DatabaseSync(path.resolve(".tmp/e2e-runtime/atlas.e2e.sqlite"));
  try {
    const vp = db.prepare("SELECT id,name FROM agents WHERE role='vp' AND cli_provider='codex'").get() as {
      id: string;
      name: string;
    };
    const payload = {
      department_id: "qa",
      agents_action: "reassign",
      reassign_department_id: "dev",
      reason: "Consolidate review capacity",
    };
    const item = {
      kind: "org_request",
      id: "e2e-vp-org",
      created_at: Date.now(),
      task_id: null,
      task_title: null,
      agent_id: vp.id,
      agent_name: vp.name,
      org_kind: "dissolve_department",
      payload,
      reason: payload.reason,
      decide_path: "/api/org-requests/e2e-vp-org/decide",
    };
    db.prepare(
      "INSERT INTO org_requests(id,kind,requested_by,payload,status,reason,created_at) VALUES(?,?,?,?,'pending',?,?)",
    ).run(item.id, item.org_kind, vp.id, JSON.stringify(payload), payload.reason, item.created_at);
    const hash = approvalSnapshot(item);
    db.prepare(
      "INSERT INTO approval_vp_state(approval_kind,approval_id,snapshot_hash,status,reason,outcome,updated_at) VALUES(?,?,?,'escalated',?,NULL,?)",
    ).run(
      item.kind,
      item.id,
      hash,
      "Codex VP: approve: Team coverage retained\nClaude VP: escalate: Default department needs owner",
      Date.now(),
    );
    db.prepare(
      "INSERT INTO approval_vp_state(approval_kind,approval_id,snapshot_hash,status,reason,outcome,updated_at) VALUES('task_proposal','e2e-vp-denied','fixture','decided',?,'deny',?)",
    ).run("Codex VP: deny: Duplicate work\nClaude VP: deny: Already complete", Date.now() + 1);
  } finally {
    db.close();
  }
});

for (const width of [1440, 375]) {
  test(`VP decisions and escalations remain readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/team/vp-decisions");
    await expect(page.getByRole("heading", { name: "VP decisions" }).last()).toBeVisible();
    await expect(page.getByText(/Duplicate work/)).toHaveText(/Already complete/);
    await expect(page.getByRole("tab", { name: "VP decisions" })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/");
    await expect(page.getByText(/Team coverage retained/)).toHaveText(/Default department needs owner/);
    await expect(page.getByText("dev", { exact: true })).toBeVisible();
    if (process.env.E2E_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/vp-escalation-${width}.png` });
  });
}

test("seeded VP provider and role cannot be edited", async ({ page }) => {
  await page.goto("/team");
  await expect(page.locator("main header h1")).toBeVisible();
  const response = await page.request.get("/api/agents");
  const { agents } = await response.json();
  const vps = agents.filter((agent: { role: string }) => agent.role === "vp");
  expect(vps).toHaveLength(2);
  expect(vps.map((agent: { cli_provider: string }) => agent.cli_provider).sort()).toEqual(["claude", "codex"]);
  const session = await (await page.request.get("/api/auth/session")).json();
  const changed = await page.request.patch(`/api/agents/${vps[0].id}`, {
    headers: { "x-csrf-token": session.csrf_token },
    data: { cli_provider: "gemini" },
  });
  expect(changed.status()).toBe(400);
});
