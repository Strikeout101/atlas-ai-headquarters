import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { getCsrfToken } from "../security/auth.ts";
import { createAgentTaskToken } from "../security/agent-task-token.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import {
  backupDue,
  backupFileName,
  ensureBackupSchema,
  latestSlot,
  pruneBackupFolder,
  runBackup,
  saveBackupSettings,
  testBackupFolder,
  verifyBackup,
} from "./db-backups.ts";
import { registerSystemRoutes } from "./routes/ops/system.ts";
import { requestServiceAction, serviceOverview } from "./service-status.ts";
import { upstreamUpdatesLocked } from "./routes/core/update-auto/upstream-lock.ts";
// The supervisor is plain JavaScript run by Node directly; its logic is tested here with fake processes.
// @ts-expect-error -- no type declarations for the .mjs script
import * as supervisor from "../../scripts/atlas-service/supervisor.mjs";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-reliability-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function liveDb(dir: string) {
  const dbPath = path.join(dir, "claw-empire.sqlite");
  const db = new DatabaseSync(dbPath);
  cleanup.push(() => db.close());
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY);
    INSERT INTO tasks VALUES ('t1','One'),('t2','Two');
    INSERT INTO agents VALUES ('a1');`);
  ensureBackupSchema(db);
  return { db, dbPath };
}

describe("database backups", () => {
  it("copies the live database, restore-tests the copy and records the run", () => {
    const dir = tempDir();
    const { db, dbPath } = liveDb(dir);
    const run = runBackup(db, { dbPath, trigger: "manual" });
    expect(run.status).toBe("ok");
    expect(run.check_detail).toContain("integrity ok; tasks 2, agents 1");
    expect(path.dirname(run.file!)).toBe(path.join(dir, "backups", "auto"));
    const copy = new DatabaseSync(run.file!, { readOnly: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    copy.close();
    expect(run.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare("SELECT status, trigger FROM backup_runs").all()).toEqual([{ status: "ok", trigger: "manual" }]);
  });

  it("marks a corrupted or mismatched copy as failed", () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad.sqlite");
    fs.writeFileSync(bad, "not a database at all");
    expect(verifyBackup(bad, {}).ok).toBe(false);
    const { db, dbPath } = liveDb(dir);
    const run = runBackup(db, { dbPath, trigger: "manual" });
    expect(verifyBackup(run.file!, { tasks: 5 })).toMatchObject({
      ok: false,
      detail: "row counts differ: tasks 2 vs 5",
    });
  });

  it("prunes only old automatic backups, always keeps the newest three, and never touches other files", () => {
    const dir = tempDir();
    const now = new Date(2026, 10, 18, 3, 0, 0).getTime();
    const day = 86_400_000;
    const make = (daysAgo: number) => {
      const file = path.join(dir, backupFileName(now - daysAgo * day));
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, new Date(now - daysAgo * day), new Date(now - daysAgo * day));
      return path.basename(file);
    };
    const names = [40, 35, 31, 5, 1].map(make);
    fs.writeFileSync(path.join(dir, "claw-empire.before-accounts-2026-11-17.sqlite"), "manual");
    fs.utimesSync(path.join(dir, "claw-empire.before-accounts-2026-11-17.sqlite"), new Date(0), new Date(0));
    expect(pruneBackupFolder(dir, 30, now)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(
      [names[2], names[3], names[4], "claw-empire.before-accounts-2026-11-17.sqlite"].sort(),
    );
    // With only three left, even very old ones stay.
    expect(pruneBackupFolder(dir, 1, now + 400 * day)).toBe(0);
  });

  it("copies good backups to the owner's folder and keeps the local one when that copy fails", () => {
    const dir = tempDir();
    const { db, dbPath } = liveDb(dir);
    const offsite = path.join(dir, "nas");
    fs.mkdirSync(offsite);
    expect(testBackupFolder(offsite)).toEqual({ ok: true, error: null });
    expect(testBackupFolder("relative/path").ok).toBe(false);
    expect(testBackupFolder(path.join(dir, "missing")).error).toMatch(/does not exist/);
    saveBackupSettings(db, { copy_dir: offsite });
    const run = runBackup(db, { dbPath, trigger: "manual" });
    expect(run).toMatchObject({ status: "ok", copy_status: "ok" });
    expect(fs.readdirSync(offsite)).toEqual([path.basename(run.file!)]);

    saveBackupSettings(db, { copy_dir: path.join(dir, "unplugged-drive") });
    const second = runBackup(db, { dbPath, trigger: "manual", now: Date.now() + 1000 });
    expect(second).toMatchObject({ status: "ok", copy_status: "failed" });
    expect(fs.existsSync(second.file!)).toBe(true);
    expect(() => saveBackupSettings(db, { copy_dir: "backups" })).toThrow("copy_dir_must_be_absolute");
  });

  it("is due once per daily slot, and waits an hour after a failure", () => {
    const dir = tempDir();
    const { db, dbPath } = liveDb(dir);
    const morning = new Date(2026, 10, 18, 9, 0, 0).getTime();
    expect(latestSlot(3, morning)).toBe(new Date(2026, 10, 18, 3, 0, 0).getTime());
    expect(latestSlot(23, morning)).toBe(new Date(2026, 10, 17, 23, 0, 0).getTime());
    expect(backupDue(db, morning)).toBe(true);
    runBackup(db, { dbPath, trigger: "startup", now: morning });
    expect(backupDue(db, morning + 60_000)).toBe(false);
    expect(backupDue(db, new Date(2026, 10, 19, 3, 5, 0).getTime())).toBe(true);
    db.prepare(
      "INSERT INTO backup_runs (id,trigger,started_at,finished_at,status) VALUES ('f','schedule',?,?,'failed')",
    ).run(new Date(2026, 10, 19, 3, 5, 0).getTime(), new Date(2026, 10, 19, 3, 5, 0).getTime());
    expect(backupDue(db, new Date(2026, 10, 19, 3, 30, 0).getTime())).toBe(false);
    expect(backupDue(db, new Date(2026, 10, 19, 4, 10, 0).getTime())).toBe(true);
    saveBackupSettings(db, { enabled: false });
    expect(backupDue(db, new Date(2026, 10, 19, 4, 10, 0).getTime())).toBe(false);
  });
});

describe("system routes", () => {
  it("are owner-only, refuse agents, and request service actions from the supervisor", async () => {
    const dir = tempDir();
    const { db, dbPath } = liveDb(dir);
    const serviceDir = path.join(dir, "service");
    fs.mkdirSync(serviceDir);
    fs.writeFileSync(path.join(serviceDir, "service.json"), JSON.stringify({ current_sha: "abc", restarts: 2 }));
    const env = { ATLAS_SERVICE_DIR: serviceDir };
    const app = express();
    app.use(express.json());
    registerSystemRoutes(app, db, dbPath, { repoDir: dir, env });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    await request(app).get("/api/backups").expect(403);
    await request(app).get("/api/backups").set("x-agent-task-token", createAgentTaskToken("t1", "a1")).expect(403);
    const overview = await request(app).get("/api/system/service").set("Cookie", cookie).expect(200);
    expect(overview.body).toMatchObject({ managed: true, state: { current_sha: "abc", restarts: 2 } });
    await request(app)
      .post("/api/system/service/update")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .expect(202);
    expect(JSON.parse(fs.readFileSync(path.join(serviceDir, "request.json"), "utf8")).action).toBe("update");
    await request(app)
      .post("/api/system/service/delete-everything")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .expect(400);
    const backup = await request(app)
      .post("/api/backups/run")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .expect(200);
    expect(backup.body.run.status).toBe("ok");
    const listed = await request(app).get("/api/backups").set("Cookie", cookie).expect(200);
    expect(listed.body.files).toHaveLength(1);
    expect(listed.body.last_good.id).toBe(backup.body.run.id);
  });

  it("reports when ATLAS is not running as a service", () => {
    expect(serviceOverview(tempDir(), {}).managed).toBe(false);
    expect(() => requestServiceAction("restart", {})).toThrow("service_not_running");
  });
});

describe("upstream updater lock", () => {
  it("stays locked unless ATLAS_ALLOW_UPSTREAM_UPDATE=1", () => {
    expect(upstreamUpdatesLocked({})).toBe(true);
    expect(upstreamUpdatesLocked({ ATLAS_ALLOW_UPSTREAM_UPDATE: "true" })).toBe(true);
    expect(upstreamUpdatesLocked({ ATLAS_ALLOW_UPSTREAM_UPDATE: "1" })).toBe(false);
  });
});

describe("service supervisor", () => {
  class FakeChild extends EventEmitter {
    constructor(
      public release: string,
      public pid: number,
    ) {
      super();
    }
  }

  function harness(options: { head?: string; healthy?: (release: string) => boolean; buildFails?: boolean } = {}) {
    let clock = 1_000_000;
    let pid = 100;
    const children: FakeChild[] = [];
    const requests: Array<{ action: string }> = [];
    const written: Array<Record<string, unknown>> = [];
    const built: string[] = [];
    const pruned: string[][] = [];
    const deps = {
      port: 8800,
      git: () => options.head ?? "new",
      releaseDir: (sha: string) => `releases/${sha}`,
      buildRelease: (sha: string) => {
        if (options.buildFails && sha !== "old") throw new Error("vite build failed");
        built.push(sha);
        return `releases/${sha}`;
      },
      pruneReleases: (keep: string[]) => pruned.push(keep),
      startServer: (release: string) => {
        const child = new FakeChild(release, (pid += 1));
        children.push(child);
        return child;
      },
      stopServer: async (child: FakeChild) => {
        child.emit("exit", null, "SIGTERM");
      },
      checkHealth: async () => (options.healthy ?? (() => true))(children[children.length - 1]?.release ?? ""),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      readState: () => ({ current_sha: "old", restarts: 0 }),
      writeState: (state: Record<string, unknown>) => written.push(state),
      takeRequest: () => requests.shift() ?? null,
      log: () => {},
    };
    const sup = supervisor.createSupervisor(deps);
    return { sup, children, requests, written, built, pruned, advance: (ms: number) => (clock += ms) };
  }

  it("backs off restarts after crashes: 2s, 4s, 8s ... up to a minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(supervisor.restartDelay)).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it("starts the current release and restarts it after a crash", async () => {
    const h = harness();
    await h.sup.boot();
    expect(h.children.map((c) => c.release)).toEqual(["releases/old"]);
    h.children[0].emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.children.map((c) => c.release)).toEqual(["releases/old", "releases/old"]);
    expect(h.sup.state.restarts).toBe(1);
    expect(h.sup.state.last_exit).toMatchObject({ code: 1 });
  });

  it("never lets a step that does not settle freeze the watch loop", async () => {
    const never = new Promise(() => {});
    expect(await supervisor.withDeadline(never, 20, "gave up")).toBe("gave up");
    expect(await supervisor.withDeadline(Promise.resolve("done"), 1000, "gave up")).toBe("done");
  });

  it("still handles an update sent after a restart, and reports what it is doing", async () => {
    const h = harness();
    await h.sup.boot();
    h.requests.push({ action: "restart" });
    await h.sup.tick();
    expect(h.sup.currentStep()).toBe("idle");
    h.requests.push({ action: "update" });
    await h.sup.tick();
    expect(h.sup.state).toMatchObject({ current_sha: "new", last_update: { ok: true } });
    expect(h.children.map((c) => c.release)).toEqual(["releases/old", "releases/old", "releases/new"]);
  });

  it("updates to HEAD when the new build is healthy", async () => {
    const h = harness();
    await h.sup.boot();
    h.requests.push({ action: "update" });
    await h.sup.tick();
    expect(h.built).toContain("new");
    expect(h.sup.state).toMatchObject({ current_sha: "new", previous_sha: "old", last_update: { ok: true } });
    expect(h.children.at(-1)!.release).toBe("releases/new");
    expect(h.pruned.at(-1)).toEqual(["new", "old"]);
  });

  it("rolls back when the new build never becomes healthy", async () => {
    const h = harness({ healthy: (release) => release !== "releases/new" });
    await h.sup.boot();
    h.requests.push({ action: "update" });
    await h.sup.tick();
    expect(h.sup.state.current_sha).toBe("old");
    expect(h.sup.state.last_update).toMatchObject({ ok: false });
    expect(h.sup.state.last_update.detail).toMatch(/rolled back to old/);
    expect(h.children.at(-1)!.release).toBe("releases/old");
  });

  it("keeps the running version when the build fails", async () => {
    const h = harness({ buildFails: true });
    await h.sup.boot();
    h.requests.push({ action: "update" });
    await h.sup.tick();
    expect(h.children).toHaveLength(1);
    expect(h.sup.state.last_update.detail).toMatch(/Build failed; still running old/);
  });

  it("restarts after three failed health checks once past the startup grace", async () => {
    let healthy = true;
    const h = harness({ healthy: () => healthy });
    await h.sup.boot();
    healthy = false;
    await h.sup.tick();
    expect(h.children).toHaveLength(1);
    h.advance(supervisor.STARTUP_GRACE_MS + 1);
    await h.sup.tick();
    await h.sup.tick();
    expect(h.children).toHaveLength(1);
    await h.sup.tick();
    expect(h.children).toHaveLength(2);
  });

  it("builds the server environment from .env with the service settings winning", () => {
    const env = supervisor.serverEnv({
      baseEnv: { VITE_DEV: "1", PATH: "x" },
      envFileText: "# comment\nPORT=8790\nOAUTH_ENCRYPTION_SECRET=abc\nHOST=127.0.0.1\n",
      port: 8800,
      host: "0.0.0.0",
      dataDir: "C:/repo",
      serviceDir: "C:/svc",
    });
    expect(env).toMatchObject({
      PORT: "8800",
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      OAUTH_ENCRYPTION_SECRET: "abc",
      APP_DATA_DIR: "C:/repo",
      ATLAS_SERVICE_DIR: "C:/svc",
      PATH: "x",
    });
    expect(env.VITE_DEV).toBeUndefined();
  });
});
