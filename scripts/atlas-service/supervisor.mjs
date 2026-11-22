#!/usr/bin/env node
/**
 * ATLAS service supervisor.
 *
 * Runs a built copy ("release") of a committed version of this repository, so edits in the working folder never
 * touch the running app until the owner asks for an update. Releases live outside the repo in
 * %LOCALAPPDATA%\ATLAS\releases\<sha> (git worktrees with their own node_modules and dist/). The server still uses
 * the repo folder for its data: the database, logs, knowledge/ and the agent tool script.
 *
 * - Restarts the server after a crash (backoff 2s up to 60s) and when /api/health stops answering.
 * - Picks up requests from request.json in the service folder: update (build HEAD, switch, roll back if it is not
 *   healthy within 90s), restart, stop.
 * - Writes its state to service.json, which Settings > General > Service shows.
 * - Server output goes to logs/server/atlas-YYYY-MM-DD.log, kept 14 days.
 *
 * Usage: node scripts/atlas-service/supervisor.mjs [--port 8800] [--host 0.0.0.0] [--service-dir DIR] [--data-dir DIR]
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HEALTH_INTERVAL_MS = 60_000;
export const HEALTH_FAILURES_BEFORE_RESTART = 3;
export const STARTUP_GRACE_MS = 120_000;
export const UPDATE_HEALTH_TIMEOUT_MS = 90_000;
export const HEALTHY_RESET_MS = 10 * 60_000;
export const KEEP_RELEASES = 3;
export const KEEP_LOG_DAYS = 14;
/** A watch-loop pass that takes longer than this is logged with the step it was on, and the loop moves on. */
export const TICK_STALL_MS = 15 * 60_000;
/** One "alive" line in supervisor.log this often, so a stalled loop shows when it stopped. */
export const HEARTBEAT_MS = 30 * 60_000;

/**
 * Settles with `fallback` after `ms` even if `promise` never does. The timer is a normal (ref'd) one, so it fires
 * whatever else the event loop is doing; a never-settling fetch or child process cannot freeze the caller.
 */
export function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Backoff before restarting after the nth crash in a row: 2s, 4s, 8s ... up to 60s. */
export function restartDelay(crashesInARow) {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, crashesInARow - 1));
}

/** Parses a .env file the same way the server does (KEY=VALUE, # comments). */
export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

/** The server's environment: the repo .env, then the service's own settings, which always win. */
export function serverEnv({ baseEnv, envFileText, port, host, dataDir, serviceDir }) {
  const env = { ...baseEnv, ...parseEnvFile(envFileText ?? "") };
  delete env.VITE_DEV;
  return {
    ...env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: host,
    APP_DATA_DIR: dataDir,
    ATLAS_SERVICE_DIR: serviceDir,
  };
}

export function logFileFor(logDir, now) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(logDir, `atlas-${day}.log`);
}

export function pruneLogs(logDir, now, keepDays = KEEP_LOG_DAYS) {
  if (!fs.existsSync(logDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(logDir)) {
    if (!/^atlas-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const file = path.join(logDir, name);
    if (fs.statSync(file).mtimeMs < now - keepDays * 86_400_000) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/**
 * The supervisor's logic, with every side effect injected so it can be tested without real processes:
 *   deps.git(args) -> string, deps.buildRelease(sha) -> releaseDir, deps.startServer(releaseDir) -> child,
 *   deps.stopServer(child) -> Promise, deps.checkHealth() -> Promise<boolean>, deps.sleep(ms), deps.now(),
 *   deps.readState(), deps.writeState(state), deps.takeRequest() -> {action}|null, deps.pruneReleases(keepShas),
 *   deps.log(message)
 * A child is any object with `once("exit", (code, signal) => ...)`.
 */
export function createSupervisor(deps) {
  const state = {
    current_sha: null,
    previous_sha: null,
    built_at: null,
    started_at: null,
    supervisor_started_at: deps.now(),
    restarts: 0,
    last_exit: null,
    last_update: null,
    port: deps.port ?? null,
    ...(deps.readState() ?? {}),
  };
  state.supervisor_started_at = deps.now();
  let child = null;
  let expectedExit = false;
  let crashesInARow = 0;
  let healthFailures = 0;
  let stopping = false;
  let busy = false;
  /** What the supervisor is waiting on right now, for the stall log. */
  let step = "idle";
  const save = () => deps.writeState({ ...state, server_pid: child?.pid ?? null });

  function watch(proc) {
    proc.once("exit", (code, signal) => {
      if (proc !== child) return;
      child = null;
      state.last_exit = { code: code ?? null, signal: signal ?? null, at: deps.now() };
      save();
      if (expectedExit || stopping) return;
      crashesInARow += 1;
      state.restarts += 1;
      const delay = restartDelay(crashesInARow);
      deps.log(`server exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
      void deps.sleep(delay).then(() => {
        if (!stopping && !child && !busy) start(state.current_sha);
      });
    });
  }

  function start(sha) {
    const release = deps.releaseDir(sha);
    expectedExit = false;
    healthFailures = 0;
    child = deps.startServer(release);
    state.started_at = deps.now();
    watch(child);
    save();
    deps.log(`server started from ${sha.slice(0, 12)} (pid ${child.pid ?? "?"})`);
    return child;
  }

  async function stopChild() {
    if (!child) return;
    expectedExit = true;
    const proc = child;
    step = `stopping server pid ${proc.pid ?? "?"}`;
    await deps.stopServer(proc);
    if (child === proc) child = null;
  }

  async function waitHealthy(timeoutMs) {
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      if (!child) return false;
      step = "waiting for the new server to be healthy";
      if (await deps.checkHealth()) return true;
      await deps.sleep(2_000);
    }
    return false;
  }

  /** Builds HEAD (or the current release on first start) and runs it. */
  async function boot() {
    const sha = state.current_sha ?? deps.git(["rev-parse", "HEAD"]);
    deps.buildRelease(sha);
    if (!state.current_sha) {
      state.current_sha = sha;
      state.built_at = deps.now();
    }
    start(sha);
  }

  async function update() {
    const target = deps.git(["rev-parse", "HEAD"]);
    const from = state.current_sha;
    if (target === from) {
      state.last_update = { at: deps.now(), sha: target, ok: true, detail: "Already running the latest commit." };
      save();
      return state.last_update;
    }
    try {
      deps.buildRelease(target);
    } catch (error) {
      state.last_update = {
        at: deps.now(),
        sha: target,
        ok: false,
        detail: `Build failed; still running ${from?.slice(0, 12)}. ${String(error?.message ?? error).slice(0, 500)}`,
      };
      save();
      return state.last_update;
    }
    await stopChild();
    start(target);
    if (await waitHealthy(UPDATE_HEALTH_TIMEOUT_MS)) {
      state.previous_sha = from;
      state.current_sha = target;
      state.built_at = deps.now();
      crashesInARow = 0;
      state.last_update = { at: deps.now(), sha: target, ok: true, detail: `Updated from ${from?.slice(0, 12)}.` };
      deps.pruneReleases([target, from].filter(Boolean));
    } else {
      await stopChild();
      start(from);
      state.last_update = {
        at: deps.now(),
        sha: target,
        ok: false,
        detail: `The new version did not become healthy within ${UPDATE_HEALTH_TIMEOUT_MS / 1000}s; rolled back to ${from?.slice(0, 12)}.`,
      };
    }
    save();
    return state.last_update;
  }

  async function handle(request) {
    if (!request || busy) return;
    busy = true;
    try {
      deps.log(`request: ${request.action}`);
      if (request.action === "update") await update();
      else if (request.action === "restart") {
        await stopChild();
        start(state.current_sha);
      } else if (request.action === "stop") {
        stopping = true;
        await stopChild();
        save();
      }
    } finally {
      busy = false;
    }
  }

  /** One pass of the watch loop: requests first, then health. */
  async function tick() {
    step = "reading requests";
    await handle(deps.takeRequest());
    step = "idle";
    if (stopping || busy || !child) return;
    if (deps.now() - (state.started_at ?? 0) < STARTUP_GRACE_MS) return;
    step = "health check";
    const healthy = await deps.checkHealth();
    step = "idle";
    if (healthy) {
      healthFailures = 0;
      if (crashesInARow && deps.now() - (state.started_at ?? 0) > HEALTHY_RESET_MS) crashesInARow = 0;
      return;
    }
    healthFailures += 1;
    deps.log(`health check failed (${healthFailures}/${HEALTH_FAILURES_BEFORE_RESTART})`);
    if (healthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
      state.restarts += 1;
      await stopChild();
      start(state.current_sha);
    }
  }

  return {
    state,
    boot,
    tick,
    handle,
    update,
    isStopping: () => stopping,
    currentStep: () => step,
    child: () => child,
    shutdown: async () => {
      stopping = true;
      await stopChild();
      save();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Real side effects (Windows first; works on other systems too)
// ---------------------------------------------------------------------------------------------------------------
function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function run(cmd, args, cwd, timeoutMs = 20 * 60_000) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    shell: process.platform === "win32" && cmd === "pnpm",
    windowsHide: true,
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function main() {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const port = Number(argValue("port", "8800"));
  const host = argValue("host", "0.0.0.0");
  const serviceDir = path.resolve(
    argValue("service-dir", path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "ATLAS")),
  );
  const dataDir = path.resolve(argValue("data-dir", repoDir));
  const releasesDir = path.join(serviceDir, "releases");
  const logDir = path.join(dataDir, "logs", "server");
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const stateFile = path.join(serviceDir, "service.json");
  const requestFile = path.join(serviceDir, "request.json");
  const lockFile = path.join(serviceDir, "supervisor.pid");
  const supervisorLog = path.join(serviceDir, "supervisor.log");
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(supervisorLog, line);
    // Only echo when run by hand in a terminal; the login task runs hidden and the log file is the record.
    if (process.argv.includes("--echo")) process.stdout.write(line);
  };

  // One supervisor at a time.
  if (fs.existsSync(lockFile)) {
    const other = Number(fs.readFileSync(lockFile, "utf8"));
    if (other && other !== process.pid && isAlive(other)) {
      log(`another supervisor is running (pid ${other}); exiting`);
      process.exit(0);
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      return null;
    }
  };
  // A server left running by a supervisor that was killed would hold the port: stop it first.
  const previous = readState();
  if (previous?.server_pid && isAlive(previous.server_pid)) {
    log(`stopping a server left from the last run (pid ${previous.server_pid})`);
    killTree(previous.server_pid);
  }

  const git = (args) => run("git", args, repoDir).trim();
  const releaseDir = (sha) => path.join(releasesDir, sha);
  const buildRelease = (sha) => {
    const dir = releaseDir(sha);
    const marker = path.join(dir, ".atlas-release.json");
    if (fs.existsSync(marker)) return dir;
    log(`building release ${sha.slice(0, 12)}`);
    if (fs.existsSync(dir)) {
      try {
        git(["worktree", "remove", "--force", dir]);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    git(["worktree", "prune"]);
    git(["worktree", "add", "--detach", dir, sha]);
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], dir);
    run("pnpm", ["exec", "vite", "build"], dir);
    if (!fs.existsSync(path.join(dir, "dist", "index.html"))) throw new Error("vite build produced no dist/index.html");
    fs.writeFileSync(marker, JSON.stringify({ sha, built_at: Date.now() }));
    log(`release ${sha.slice(0, 12)} ready`);
    return dir;
  };
  const pruneReleases = (keep) => {
    const keepSet = new Set(keep);
    const dirs = fs
      .readdirSync(releasesDir)
      .map((name) => ({ name, mtime: fs.statSync(path.join(releasesDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    let kept = 0;
    for (const { name } of dirs) {
      if (keepSet.has(name) || kept < KEEP_RELEASES - keepSet.size) {
        if (!keepSet.has(name)) kept += 1;
        continue;
      }
      try {
        git(["worktree", "remove", "--force", path.join(releasesDir, name)]);
      } catch {
        fs.rmSync(path.join(releasesDir, name), { recursive: true, force: true });
      }
    }
    try {
      git(["worktree", "prune"]);
    } catch {
      // ignore
    }
  };

  let logStream = null;
  let logPath = null;
  const writeLog = (chunk) => {
    const file = logFileFor(logDir, Date.now());
    if (file !== logPath) {
      logStream?.end();
      logPath = file;
      logStream = fs.createWriteStream(file, { flags: "a" });
      pruneLogs(logDir, Date.now());
    }
    logStream.write(chunk);
  };

  const envFile = path.join(repoDir, ".env");
  const startServer = (release) => {
    const env = serverEnv({
      baseEnv: process.env,
      envFileText: fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "",
      port,
      host,
      dataDir,
      serviceDir,
    });
    const loader = pathToFileURL(path.join(release, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
    const proc = spawn(process.execPath, ["--import", loader, path.join(release, "server", "index.ts")], {
      cwd: dataDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout.on("data", writeLog);
    proc.stderr.on("data", writeLog);
    return proc;
  };
  const stopServer = (proc) =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", () => resolve());
      killTree(proc.pid);
      setTimeout(resolve, 10_000).unref();
    });
  // AbortSignal.timeout alone has been seen to leave a fetch pending forever (the watch loop then stopped reading
  // requests, 2026-11-21); an AbortController with its own timer plus a hard deadline cannot hang.
  const checkHealth = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await withDeadline(
        fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal }),
        12_000,
        null,
      );
      return Boolean(response?.ok);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const takeRequest = () => {
    if (!fs.existsSync(requestFile)) return null;
    try {
      // Windows PowerShell 5.1 writes UTF-8 with a byte-order mark; strip it before parsing.
      const text = fs.readFileSync(requestFile, "utf8").trim(); // trim() also removes a byte-order mark
      fs.rmSync(requestFile, { force: true });
      return JSON.parse(text);
    } catch (error) {
      log(`ignored an unreadable request: ${error?.message ?? error}`);
      fs.rmSync(requestFile, { force: true });
      return null;
    }
  };

  const supervisor = createSupervisor({
    port,
    git,
    releaseDir,
    buildRelease,
    pruneReleases,
    startServer,
    stopServer,
    checkHealth,
    takeRequest,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readState,
    writeState: (value) => {
      const temp = `${stateFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value, null, 2));
      fs.renameSync(temp, stateFile);
    },
    log,
  });

  const shutdown = async (reason) => {
    log(`supervisor stopping (${reason})`);
    await supervisor.shutdown();
    fs.rmSync(lockFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log(`supervisor started (pid ${process.pid}, port ${port}, data ${dataDir})`);
  await supervisor.boot();
  let lastHealth = 0;
  let lastHeartbeat = Date.now();
  let tickRunning = null;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (supervisor.isStopping()) break;
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      log(`alive (server pid ${supervisor.child()?.pid ?? "none"}${tickRunning ? ", a pass is still running" : ""})`);
    }
    // A pass that stalled keeps running in the background; the loop does not wait on it again.
    if (tickRunning) continue;
    // Requests are checked every 2s; health once a minute.
    if (fs.existsSync(requestFile) || Date.now() - lastHealth >= HEALTH_INTERVAL_MS) {
      if (!fs.existsSync(requestFile)) lastHealth = Date.now();
      const pass = supervisor.tick().catch((error) => log(`error: ${error?.message ?? error}`));
      tickRunning = pass;
      const finished = await withDeadline(
        pass.then(() => true),
        TICK_STALL_MS,
        false,
      );
      if (finished) tickRunning = null;
      else {
        log(`watch pass stalled for ${TICK_STALL_MS / 60_000} min at "${supervisor.currentStep()}"; carrying on`);
        void pass.finally(() => {
          tickRunning = null;
          log("the stalled watch pass finished");
        });
      }
    }
  }
  fs.rmSync(lockFile, { force: true });
  log("supervisor stopped");
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
