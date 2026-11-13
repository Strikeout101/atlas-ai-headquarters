import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Express, Request, Response } from "express";
import { Client, type ConnectConfig } from "ssh2";

import { decryptSecret, encryptSecret } from "../../../oauth/helpers.ts";
import { hasValidCsrfToken, shouldRequireCsrf } from "../../../security/auth.ts";
import { consumeSshApproval, ensureSshApprovalSchema } from "../../ssh-approvals.ts";

type AuthMethod = "password" | "private_key" | "legacy_key_path";
type TargetRow = {
  id: string;
  name: string;
  host: string;
  ssh_user: string;
  port: number;
  enabled: number;
  auth_method: AuthMethod;
  credential_enc: string | null;
  passphrase_enc: string | null;
  host_fingerprint: string | null;
  created_at: number;
  updated_at: number;
};
type RunStatus = "completed" | "failed" | "timeout" | "output_limit" | "spawn_error";
type RunResult = {
  status: RunStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error_code: string | null;
};

export type HomelabRouteOptions = {
  clientFactory?: () => Client;
  timeoutMs?: number;
  outputLimitBytes?: number;
  nowMs?: () => number;
};

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const secretReady = () =>
  Boolean(process.env.OAUTH_ENCRYPTION_SECRET?.trim() && process.env.OAUTH_ENCRYPTION_SECRET !== "__CHANGE_ME__");
const error = (res: Response, status: number, code: string) => res.status(status).json({ error: code });
const csrf = (req: Request, res: Response) => {
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    error(res, 403, "csrf_invalid");
    return false;
  }
  return true;
};

export function ensureHomelabSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS homelab_ssh_targets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL, ssh_user TEXT NOT NULL,
    port INTEGER NOT NULL, key_path TEXT NOT NULL DEFAULT '', known_hosts_path TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1, auth_method TEXT NOT NULL DEFAULT 'legacy_key_path',
    credential_enc TEXT, passphrase_enc TEXT, host_fingerprint TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS homelab_ssh_grants (
    target_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (target_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS homelab_ssh_runs (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL, task_id TEXT, agent_id TEXT,
    command_sha256 TEXT NOT NULL, command_bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','timeout','output_limit','spawn_error')),
    exit_code INTEGER, error_code TEXT, stdout_sha256 TEXT, stderr_sha256 TEXT,
    stdout_bytes INTEGER NOT NULL DEFAULT 0, stderr_bytes INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_homelab_ssh_runs_started ON homelab_ssh_runs(started_at DESC);`);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(homelab_ssh_targets)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, definition] of [
    ["auth_method", "TEXT NOT NULL DEFAULT 'legacy_key_path'"],
    ["credential_enc", "TEXT"],
    ["passphrase_enc", "TEXT"],
    ["host_fingerprint", "TEXT"],
  ] as const)
    if (!columns.has(name)) db.exec(`ALTER TABLE homelab_ssh_targets ADD COLUMN ${name} ${definition}`);
  const grantColumns = new Set(
    (db.prepare("PRAGMA table_info(homelab_ssh_grants)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!grantColumns.has("created_at"))
    db.exec("ALTER TABLE homelab_ssh_grants ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
  const runColumns = new Set(
    (db.prepare("PRAGMA table_info(homelab_ssh_runs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!runColumns.has("completed_at")) db.exec("ALTER TABLE homelab_ssh_runs ADD COLUMN completed_at INTEGER");
  ensureSshApprovalSchema(db);
}

function getTarget(db: DatabaseSync, id: string): TargetRow | undefined {
  return db.prepare("SELECT * FROM homelab_ssh_targets WHERE id = ?").get(id) as TargetRow | undefined;
}
function targetView(db: DatabaseSync, row: TargetRow) {
  const agents = db
    .prepare("SELECT agent_id FROM homelab_ssh_grants WHERE target_id = ? ORDER BY agent_id")
    .all(row.id) as Array<{ agent_id: string }>;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    ssh_user: row.ssh_user,
    port: row.port,
    enabled: Boolean(row.enabled),
    auth_method: row.auth_method,
    has_credential: Boolean(row.credential_enc),
    has_passphrase: Boolean(row.passphrase_enc),
    host_fingerprint: row.host_fingerprint,
    agent_ids: agents.map((a) => a.agent_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function parseTarget(
  input: Record<string, unknown>,
  old?: TargetRow,
): {
  name: string;
  host: string;
  ssh_user: string;
  port: number;
  enabled: number;
  auth_method: AuthMethod;
  credential_enc: string | null;
  passphrase_enc: string | null;
  host_fingerprint: string | null;
} | null {
  const name = input.name === undefined ? old?.name : input.name;
  const host = input.host === undefined ? old?.host : input.host;
  const sshUser = input.ssh_user === undefined ? old?.ssh_user : input.ssh_user;
  const port = input.port === undefined ? old?.port : input.port;
  const enabled = input.enabled === undefined ? Boolean(old?.enabled ?? true) : input.enabled;
  const authMethod = input.auth_method === undefined ? old?.auth_method : input.auth_method;
  const endpointChanged = old && (host !== old.host || port !== old.port);
  const pin = endpointChanged
    ? null
    : input.host_fingerprint === undefined
      ? (old?.host_fingerprint ?? null)
      : input.host_fingerprint;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 100 ||
    typeof host !== "string" ||
    !HOST.test(host) ||
    typeof sshUser !== "string" ||
    !USER.test(sshUser) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof enabled !== "boolean" ||
    (authMethod !== "password" && authMethod !== "private_key") ||
    (pin !== null && (typeof pin !== "string" || !FINGERPRINT.test(pin)))
  )
    return null;
  let credentialEnc = old?.credential_enc ?? null;
  let passphraseEnc = old?.passphrase_enc ?? null;
  if (authMethod !== old?.auth_method) {
    credentialEnc = null;
    passphraseEnc = null;
  }
  if (input.credential !== undefined) {
    if (
      typeof input.credential !== "string" ||
      !input.credential ||
      input.credential.length > 65536 ||
      (authMethod === "password" && input.credential.length > 4096)
    )
      return null;
    credentialEnc = encryptSecret(input.credential);
  }
  if (input.passphrase !== undefined) {
    if (authMethod !== "private_key" || typeof input.passphrase !== "string" || input.passphrase.length > 4096)
      return null;
    passphraseEnc = input.passphrase ? encryptSecret(input.passphrase) : null;
  }
  if (!credentialEnc) return null;
  return {
    name: name.trim(),
    host,
    ssh_user: sshUser,
    port,
    enabled: enabled ? 1 : 0,
    auth_method: authMethod,
    credential_enc: credentialEnc,
    passphrase_enc: passphraseEnc,
    host_fingerprint: pin as string | null,
  };
}

function connectionConfig(
  target: TargetRow,
  verifier: (key: Buffer) => boolean,
  withCredential: boolean,
): ConnectConfig {
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.ssh_user,
    readyTimeout: 15000,
    hostVerifier: verifier,
    tryKeyboard: false,
    algorithms: {
      serverHostKey: [
        "ssh-ed25519",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
      ],
    },
  };
  if (withCredential && target.credential_enc) {
    if (target.auth_method === "password") config.password = decryptSecret(target.credential_enc);
    else if (target.auth_method === "private_key") {
      config.privateKey = decryptSecret(target.credential_enc);
      if (target.passphrase_enc) config.passphrase = decryptSecret(target.passphrase_enc);
    }
  }
  return config;
}

function connect(
  target: TargetRow,
  mode: "probe" | "test" | "run",
  command: string | null,
  options: HomelabRouteOptions,
): Promise<RunResult & { fingerprint?: string }> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 60000);
  const cap = Math.max(1, options.outputLimitBytes ?? 65536);
  return new Promise((resolve) => {
    const client = options.clientFactory?.() ?? new Client();
    let done = false,
      observed: string | undefined,
      mismatch = false;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false;
    let channel: { close?: () => void } | null = null;
    const finish = (status: RunStatus, exit_code: number | null, error_code: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        channel?.close?.();
        client.end();
      } catch {
        /* connection already closed */
      }
      resolve({
        status,
        exit_code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
        error_code,
        ...(observed ? { fingerprint: observed } : {}),
      });
    };
    const timer = setTimeout(() => finish("timeout", null, "ssh_timeout"), timeoutMs);
    const verifier = (key: Buffer) => {
      observed = fingerprint(key);
      if (mode === "probe") {
        finish("failed", null, "host_key_observed");
        return false;
      }
      const trusted = observed === target.host_fingerprint;
      if (!trusted) mismatch = true;
      return trusted;
    };
    client.on("ready", () => {
      if (mode === "test") {
        finish("completed", 0, null);
        return;
      }
      if (mode !== "run" || command === null) {
        finish("failed", null, "ssh_connection_failed");
        return;
      }
      client.exec(command, (err, stream) => {
        if (err || !stream) {
          finish("failed", null, "ssh_exec_failed");
          return;
        }
        channel = stream;
        const receive = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
          if (done) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const available = cap - stdout.length - stderr.length;
          const kept = bytes.subarray(0, Math.max(0, available));
          if (kind === "stdout") stdout = Buffer.concat([stdout, kept]);
          else stderr = Buffer.concat([stderr, kept]);
          if (bytes.length > available) {
            truncated = true;
            finish("output_limit", null, "ssh_output_limit");
          }
        };
        stream.on("data", (chunk: Buffer | string) => receive("stdout", chunk));
        stream.stderr.on("data", (chunk: Buffer | string) => receive("stderr", chunk));
        stream.on("close", (code: number | undefined) =>
          finish(
            code === 0 ? "completed" : "failed",
            typeof code === "number" ? code : null,
            code === 0 ? null : "remote_exit_nonzero",
          ),
        );
        stream.on("error", () => finish("failed", null, "ssh_stream_failed"));
      });
    });
    client.on("error", () => finish("failed", null, mismatch ? "ssh_host_key_mismatch" : "ssh_connection_failed"));
    client.on("close", () => {
      if (!done) finish("failed", null, mismatch ? "ssh_host_key_mismatch" : "ssh_connection_closed");
    });
    try {
      client.connect(connectionConfig(target, verifier, mode !== "probe"));
    } catch {
      finish("spawn_error", null, "ssh_connection_failed");
    }
  });
}

export function registerHomelabRoutes(app: Express, db: DatabaseSync, options: HomelabRouteOptions = {}): void {
  ensureHomelabSchema(db);
  const now = options.nowMs ?? Date.now;
  app.get("/api/homelab/targets", (_req, res) => {
    const rows = db.prepare("SELECT * FROM homelab_ssh_targets ORDER BY name COLLATE NOCASE").all() as TargetRow[];
    res.json({ targets: rows.map((row) => targetView(db, row)) });
  });
  app.post("/api/homelab/targets", (req, res) => {
    if (!csrf(req, res)) return;
    if (!secretReady()) {
      error(res, 503, "ssh_encryption_secret_required");
      return;
    }
    const parsed = parseTarget(req.body ?? {});
    if (!parsed) {
      error(res, 400, "invalid_ssh_target");
      return;
    }
    const id = randomUUID(),
      timestamp = now();
    db.prepare(
      `INSERT INTO homelab_ssh_targets
      (id,name,host,ssh_user,port,key_path,known_hosts_path,enabled,auth_method,credential_enc,passphrase_enc,host_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,'','',?,?,?,?,?,?,?)`,
    ).run(
      id,
      parsed.name,
      parsed.host,
      parsed.ssh_user,
      parsed.port,
      parsed.enabled,
      parsed.auth_method,
      parsed.credential_enc,
      parsed.passphrase_enc,
      parsed.host_fingerprint,
      timestamp,
      timestamp,
    );
    res.status(201).json({ target: targetView(db, getTarget(db, id)!) });
  });
  app.patch("/api/homelab/targets/:id", (req, res) => {
    if (!csrf(req, res)) return;
    const old = getTarget(db, String(req.params.id));
    if (!old) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    if (!secretReady()) {
      error(res, 503, "ssh_encryption_secret_required");
      return;
    }
    const parsed = parseTarget(req.body ?? {}, old);
    if (!parsed) {
      error(res, 400, "invalid_ssh_target");
      return;
    }
    db.prepare(
      `UPDATE homelab_ssh_targets SET name=?,host=?,ssh_user=?,port=?,enabled=?,auth_method=?,credential_enc=?,
      passphrase_enc=?,host_fingerprint=?,updated_at=? WHERE id=?`,
    ).run(
      parsed.name,
      parsed.host,
      parsed.ssh_user,
      parsed.port,
      parsed.enabled,
      parsed.auth_method,
      parsed.credential_enc,
      parsed.passphrase_enc,
      parsed.host_fingerprint,
      now(),
      old.id,
    );
    res.json({ target: targetView(db, getTarget(db, old.id)!) });
  });
  app.delete("/api/homelab/targets/:id", (req, res) => {
    if (!csrf(req, res)) return;
    const id = String(req.params.id);
    if (!getTarget(db, id)) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    db.prepare("DELETE FROM homelab_ssh_grants WHERE target_id = ?").run(id);
    db.prepare("DELETE FROM homelab_ssh_targets WHERE id = ?").run(id);
    res.json({ ok: true });
  });
  app.put("/api/homelab/targets/:id/grants", (req, res) => {
    if (!csrf(req, res)) return;
    const id = String(req.params.id),
      target = getTarget(db, id);
    if (!target) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    const ids = req.body?.agent_ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((value) => typeof value !== "string" || !value || value.length > 100)
    ) {
      error(res, 400, "invalid_agent_ids");
      return;
    }
    const unique = [...new Set(ids)] as string[];
    if (unique.some((agentId) => !db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId))) {
      error(res, 400, "ssh_agent_not_found");
      return;
    }
    db.prepare("DELETE FROM homelab_ssh_grants WHERE target_id = ?").run(id);
    for (const agentId of unique)
      db.prepare("INSERT INTO homelab_ssh_grants (target_id,agent_id,created_at) VALUES (?,?,?)").run(
        id,
        agentId,
        now(),
      );
    res.json({ target: targetView(db, target) });
  });
  app.post("/api/homelab/targets/:id/probe", async (req, res) => {
    if (!csrf(req, res)) return;
    const target = getTarget(db, String(req.params.id));
    if (!target) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    const result = await connect(target, "probe", null, options);
    if (!result.fingerprint) {
      res.status(502).json({ ok: false, error_code: result.error_code });
      return;
    }
    res.json({
      ok: true,
      fingerprint: result.fingerprint,
      matches_pin: result.fingerprint === target.host_fingerprint,
    });
  });
  app.post("/api/homelab/targets/:id/test", async (req, res) => {
    if (!csrf(req, res)) return;
    const target = getTarget(db, String(req.params.id));
    if (!target) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    if (!secretReady()) {
      error(res, 503, "ssh_encryption_secret_required");
      return;
    }
    if (!target.host_fingerprint || !target.credential_enc || target.auth_method === "legacy_key_path") {
      error(res, 409, "ssh_target_not_ready");
      return;
    }
    const result = await connect(target, "test", null, options);
    res.json({
      ok: result.status === "completed",
      status: result.status,
      fingerprint: result.fingerprint,
      error_code: result.error_code,
    });
  });
  app.post("/api/homelab/targets/:id/run", async (req, res) => {
    if (!csrf(req, res)) return;
    const target = getTarget(db, String(req.params.id));
    if (!target) {
      error(res, 404, "ssh_target_not_found");
      return;
    }
    if (
      !target.enabled ||
      !target.host_fingerprint ||
      !target.credential_enc ||
      target.auth_method === "legacy_key_path"
    ) {
      error(res, 409, "ssh_target_not_ready");
      return;
    }
    if (!secretReady()) {
      error(res, 503, "ssh_encryption_secret_required");
      return;
    }
    const command = req.body?.command;
    if (typeof command !== "string" || !command.trim() || command.length > 8000 || command.includes("\0")) {
      error(res, 400, "invalid_ssh_command");
      return;
    }
    let taskId: string | null = null,
      agentId: string | null = null;
    if (req.body?.task_id !== undefined) {
      if (typeof req.body.task_id !== "string" || !req.body.task_id) {
        error(res, 400, "invalid_task_id");
        return;
      }
      const task = db.prepare("SELECT status,assigned_agent_id FROM tasks WHERE id = ?").get(req.body.task_id) as
        | { status: string; assigned_agent_id: string | null }
        | undefined;
      if (!task || task.status !== "in_progress" || !task.assigned_agent_id) {
        error(res, 403, "ssh_task_unavailable");
        return;
      }
      taskId = req.body.task_id;
      agentId = task.assigned_agent_id;
      if (
        !db.prepare("SELECT 1 FROM homelab_ssh_grants WHERE target_id = ? AND agent_id = ?").get(target.id, agentId)
      ) {
        error(res, 403, "ssh_agent_not_granted");
        return;
      }
      const approvalId = req.body?.approval_id;
      if (
        typeof approvalId !== "string" ||
        !consumeSshApproval(db, approvalId, target.id, req.body.task_id, task.assigned_agent_id, command)
      ) {
        error(res, 403, "ssh_command_approval_required");
        return;
      }
    }
    const id = randomUUID(),
      startedAt = now();
    db.prepare(
      `INSERT INTO homelab_ssh_runs (id,target_id,task_id,agent_id,command_sha256,command_bytes,status,started_at)
      VALUES (?,?,?,?,?,?,'running',?)`,
    ).run(id, target.id, taskId, agentId, digest(command), Buffer.byteLength(command), startedAt);
    const result = await connect(target, "run", command, options);
    db.prepare(
      `UPDATE homelab_ssh_runs SET status=?,exit_code=?,error_code=?,stdout_sha256=?,stderr_sha256=?,
      stdout_bytes=?,stderr_bytes=?,completed_at=? WHERE id=?`,
    ).run(
      result.status,
      result.exit_code,
      result.error_code,
      digest(result.stdout),
      digest(result.stderr),
      Buffer.byteLength(result.stdout),
      Buffer.byteLength(result.stderr),
      now(),
      id,
    );
    res.json({ ok: result.status === "completed", run_id: id, ...result });
  });
  app.get("/api/homelab/runs", (req, res) => {
    const targetId = typeof req.query.target_id === "string" ? req.query.target_id : null;
    const rows = targetId
      ? db
          .prepare("SELECT * FROM homelab_ssh_runs WHERE target_id = ? ORDER BY started_at DESC LIMIT 100")
          .all(targetId)
      : db.prepare("SELECT * FROM homelab_ssh_runs ORDER BY started_at DESC LIMIT 100").all();
    res.json({ runs: rows });
  });
}
