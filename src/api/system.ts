import { bootstrapSession, patch, post, request } from "./core";

/** The ATLAS service: a stable build of a committed version, run and restarted by the supervisor. */
export interface ServiceOverview {
  managed: boolean;
  state: {
    current_sha?: string | null;
    previous_sha?: string | null;
    built_at?: number | null;
    started_at?: number | null;
    supervisor_started_at?: number | null;
    restarts?: number;
    last_exit?: { code: number | null; signal: string | null; at: number } | null;
    last_update?: { at: number; sha: string | null; ok: boolean; detail: string } | null;
    port?: number;
  } | null;
  repo_head: string | null;
  repo_head_subject: string | null;
  commits_behind: number;
  pending_request: { action: string; requested_at: number } | null;
}

export interface BackupSettings {
  enabled: boolean;
  hour: number;
  keep_days: number;
  copy_dir: string | null;
  updated_at: number;
}

export interface BackupRun {
  id: string;
  trigger: "schedule" | "startup" | "manual";
  started_at: number;
  finished_at: number;
  status: "ok" | "failed";
  file: string | null;
  size_bytes: number | null;
  sha256: string | null;
  check_detail: string;
  copy_status: "none" | "ok" | "failed";
  copy_detail: string | null;
  pruned: number;
}

export interface BackupOverview {
  settings: BackupSettings;
  folder: string;
  next_run_at: number | null;
  last_good: BackupRun | null;
  runs: BackupRun[];
  files: Array<{ name: string; size_bytes: number; modified_at: number }>;
}

async function owner() {
  await bootstrapSession({ promptOnUnauthorized: false });
}

export const systemApi = {
  service: async () => {
    await owner();
    return request<ServiceOverview & { ok: true }>("/api/system/service");
  },
  serviceAction: async (action: "update" | "restart") => {
    await owner();
    return post<{ ok: true; request: { action: string; requested_at: number } }>(`/api/system/service/${action}`, {});
  },
  backups: async () => {
    await owner();
    return request<BackupOverview & { ok: true }>("/api/backups");
  },
  saveBackupSettings: async (input: Partial<Omit<BackupSettings, "updated_at">>) => {
    await owner();
    return (await patch<{ ok: true; settings: BackupSettings }>("/api/backups/settings", input)).settings;
  },
  runBackup: async () => {
    await owner();
    return post<{ ok: boolean; run: BackupRun }>("/api/backups/run", {});
  },
  testFolder: async (copy_dir: string) => {
    await owner();
    return post<{ ok: boolean; error: string | null }>("/api/backups/test-folder", { copy_dir });
  },
};
