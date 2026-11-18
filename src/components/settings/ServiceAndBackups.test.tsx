import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ServiceAndBackups from "./ServiceAndBackups";
import { systemApi, type BackupOverview, type ServiceOverview } from "../../api/system";

vi.mock("../../api/system", () => ({
  systemApi: {
    service: vi.fn(),
    serviceAction: vi.fn(),
    backups: vi.fn(),
    saveBackupSettings: vi.fn(),
    runBackup: vi.fn(),
    testFolder: vi.fn(),
  },
}));

const managed: ServiceOverview & { ok: true } = {
  ok: true,
  managed: true,
  state: { current_sha: "aaaaaaa1111", built_at: 1, started_at: 1, restarts: 2, last_update: null },
  repo_head: "bbbbbbb2222",
  repo_head_subject: "Section 12",
  commits_behind: 3,
  pending_request: null,
};
const run = {
  id: "r1",
  trigger: "manual" as const,
  started_at: Date.now(),
  finished_at: Date.now(),
  status: "ok" as const,
  file: "C:/atlas/backups/auto/claw-empire-2026-11-18-030000.sqlite",
  size_bytes: 2 << 20,
  sha256: "x",
  check_detail: "integrity ok",
  copy_status: "none" as const,
  copy_detail: null,
  pruned: 0,
};
const backups: BackupOverview & { ok: true } = {
  ok: true,
  settings: { enabled: true, hour: 3, keep_days: 30, copy_dir: null, updated_at: 0 },
  folder: "C:/atlas/backups/auto",
  next_run_at: Date.now() + 3600_000,
  last_good: run,
  runs: [run],
  files: [],
};

beforeEach(() => {
  for (const fn of Object.values(systemApi)) vi.mocked(fn).mockReset();
  vi.mocked(systemApi.service).mockResolvedValue(managed);
  vi.mocked(systemApi.backups).mockResolvedValue(backups);
});

describe("Service panel", () => {
  it("shows the running version, offers the update and sends it", async () => {
    const user = userEvent.setup();
    vi.mocked(systemApi.serviceAction).mockResolvedValue({ ok: true, request: { action: "update", requested_at: 1 } });
    render(<ServiceAndBackups />);
    expect(await screen.findByText("Running aaaaaaa · update available (3 commits)")).toBeInTheDocument();
    await user.click(screen.getByText("Service"));
    expect(screen.getByText(/bbbbbbb · Section 12/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Update to latest commit" }));
    expect(systemApi.serviceAction).toHaveBeenCalledWith("update");
    expect(await screen.findByText(/rolls back on its own/)).toBeVisible();
  });

  it("explains how to install the service when ATLAS runs in dev mode", async () => {
    const user = userEvent.setup();
    vi.mocked(systemApi.service).mockResolvedValue({ ...managed, managed: false, state: null });
    render(<ServiceAndBackups />);
    await user.click(await screen.findByText("Not running as a service"));
    expect(screen.getByText(/atlas-service.ps1 install/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update to latest commit" })).toBeNull();
  });
});

describe("Backups panel", () => {
  it("tests a folder before saving it and reports a folder ATLAS cannot use", async () => {
    const user = userEvent.setup();
    vi.mocked(systemApi.testFolder).mockResolvedValueOnce({ ok: false, error: "That folder does not exist." });
    render(<ServiceAndBackups />);
    await user.click(await screen.findByText("Backups"));
    const form = screen.getByRole("form", { name: "Copy backups off this PC" });
    await user.type(within(form).getByLabelText(/Copy backups off this PC/), "Z:\\missing");
    await user.click(within(form).getByRole("button", { name: "Test and save folder" }));
    expect(systemApi.testFolder).toHaveBeenCalledWith("Z:\\missing");
    expect(systemApi.saveBackupSettings).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder does not exist.");

    vi.mocked(systemApi.testFolder).mockResolvedValueOnce({ ok: true, error: null });
    vi.mocked(systemApi.saveBackupSettings).mockResolvedValue({ ...backups.settings, copy_dir: "Z:\\missing" });
    await user.click(within(form).getByRole("button", { name: "Test and save folder" }));
    expect(systemApi.saveBackupSettings).toHaveBeenCalledWith({ copy_dir: "Z:\\missing" });
    expect(await screen.findByText(/Each good backup is copied there too/)).toBeVisible();
  });

  it("runs a backup on demand and shows the check result", async () => {
    const user = userEvent.setup();
    vi.mocked(systemApi.runBackup).mockResolvedValue({ ok: true, run });
    render(<ServiceAndBackups />);
    await user.click(await screen.findByText("Backups"));
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup saved and checked (2.0 MB).")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Recent backups" })).getByText("checked OK")).toBeVisible();
  });
});
