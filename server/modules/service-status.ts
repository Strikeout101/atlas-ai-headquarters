import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The ATLAS service (scripts/atlas-service/supervisor.mjs) runs a built copy of a committed version and keeps its
 * state in `service.json` in the service folder. The supervisor passes that folder to the server as
 * ATLAS_SERVICE_DIR; when it is missing, ATLAS is running some other way (for example `pnpm dev`).
 * Update and restart are requests the supervisor picks up from `request.json`, so the server never restarts itself.
 */
export const SERVICE_ACTIONS = ["update", "restart"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export interface ServiceState {
  current_sha?: string | null;
  previous_sha?: string | null;
  built_at?: number | null;
  started_at?: number | null;
  supervisor_started_at?: number | null;
  restarts?: number;
  last_exit?: { code: number | null; signal: string | null; at: number } | null;
  last_update?: { at: number; sha: string | null; ok: boolean; detail: string } | null;
  port?: number;
}

function git(repoDir: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function serviceDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.ATLAS_SERVICE_DIR?.trim();
  return dir ? dir : null;
}

export function readServiceState(dir: string): ServiceState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "service.json"), "utf8")) as ServiceState;
  } catch {
    return null;
  }
}

export function serviceOverview(repoDir: string, env: NodeJS.ProcessEnv = process.env) {
  const dir = serviceDir(env);
  const state = dir ? readServiceState(dir) : null;
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  const current = state?.current_sha ?? null;
  const behind =
    current && head && current !== head ? Number(git(repoDir, ["rev-list", "--count", `${current}..${head}`]) ?? 0) : 0;
  const pending = dir ? readPendingRequest(dir) : null;
  return {
    managed: Boolean(dir && state),
    state,
    repo_head: head,
    repo_head_subject: head ? git(repoDir, ["log", "-1", "--format=%s", head]) : null,
    commits_behind: behind,
    pending_request: pending,
  };
}

export function readPendingRequest(dir: string): { action: ServiceAction; requested_at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Leaves a request for the supervisor. Written to a temp file and renamed, so the supervisor never reads half of it. */
export function requestServiceAction(action: unknown, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (!(SERVICE_ACTIONS as readonly unknown[]).includes(action)) throw new Error("invalid_service_action");
  const dir = serviceDir(env);
  if (!dir || !readServiceState(dir)) throw new Error("service_not_running");
  const request = { action: action as ServiceAction, requested_at: now };
  const temp = path.join(dir, `request.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(request));
  fs.renameSync(temp, path.join(dir, "request.json"));
  return request;
}
