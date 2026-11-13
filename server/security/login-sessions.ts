import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "exec" | "prepare">;

/** How a browser session was established. Automatic kinds stay valid only while the request still qualifies. */
export type SessionKind = "local" | "network" | "password" | "token";
export type SessionClaims = { kind: SessionKind; epoch: number; expiresAt: number; id: string };

const SESSION_KINDS: readonly SessionKind[] = ["local", "network", "password", "token"];
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

const TOKEN_PREFIX = "s1.";
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_KEYLEN = 64;

const KEY_SIGNING = "session_signing_key";
const KEY_EPOCH = "session_epoch";
const KEY_PASSWORD = "login_password_hash";

let store: Db | null = null;
const memoryConfig = new Map<string, string>();
let signingKeyCache: Buffer | null = null;
let epochCache: number | null = null;

/**
 * Keeps auth secrets in their own table: the general `settings` table is returned to the browser by
 * GET /api/settings and must never hold the password hash or signing key.
 */
export function configureLoginStore(db: Db | null): void {
  if (db) db.exec("CREATE TABLE IF NOT EXISTS auth_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  store = db;
  signingKeyCache = null;
  epochCache = null;
}

export function __resetLoginStoreForTests(): void {
  configureLoginStore(null);
  memoryConfig.clear();
  loginAttempts.clear();
}

function readConfig(key: string): string | null {
  if (!store) return memoryConfig.get(key) ?? null;
  const row = store.prepare("SELECT value FROM auth_config WHERE key = ?").get(key) as { value?: string } | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function writeConfig(key: string, value: string): void {
  if (!store) {
    memoryConfig.set(key, value);
    return;
  }
  store
    .prepare("INSERT INTO auth_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function signingKey(): Buffer {
  if (signingKeyCache) return signingKeyCache;
  let hex = readConfig(KEY_SIGNING);
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    hex = randomBytes(32).toString("hex");
    writeConfig(KEY_SIGNING, hex);
  }
  signingKeyCache = Buffer.from(hex, "hex");
  return signingKeyCache;
}

function currentEpoch(): number {
  if (epochCache !== null) return epochCache;
  const parsed = Number(readConfig(KEY_EPOCH) ?? "1");
  epochCache = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  return epochCache;
}

/** Signs out every browser. Automatic (local / trusted network) sessions re-establish on their next request. */
export function revokeAllSessions(): void {
  const next = currentEpoch() + 1;
  writeConfig(KEY_EPOCH, String(next));
  epochCache = next;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(`atlas-session-v1.${payload}`).digest("base64url");
}

export function createSessionToken(kind: SessionKind, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ k: kind, e: currentEpoch(), x: now + SESSION_TTL_MS, i: randomBytes(9).toString("base64url") }),
  ).toString("base64url");
  return `${TOKEN_PREFIX}${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string, now = Date.now()): SessionClaims | null {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 1024) return null;
  const [payload, signature, extra] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const kind = raw.k as SessionKind;
    if (!SESSION_KINDS.includes(kind)) return null;
    if (raw.e !== currentEpoch()) return null;
    if (typeof raw.x !== "number" || raw.x <= now || raw.x > now + SESSION_TTL_MS + 60_000) return null;
    if (typeof raw.i !== "string" || !raw.i) return null;
    return { kind, epoch: raw.e, expiresAt: raw.x, id: raw.i };
  } catch {
    return null;
  }
}

function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: SCRYPT_MAXMEM };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function isPasswordConfigured(): boolean {
  return Boolean(readConfig(KEY_PASSWORD));
}

export function validateNewPassword(
  value: unknown,
): "password_required" | "password_too_short" | "password_too_long" | null {
  if (typeof value !== "string" || value.length === 0) return "password_required";
  if (value.length < MIN_PASSWORD_LENGTH) return "password_too_short";
  if (value.length > MAX_PASSWORD_LENGTH) return "password_too_long";
  return null;
}

/** Stores a new password hash and signs out every other browser. */
export async function setLoginPassword(password: string): Promise<void> {
  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  writeConfig(KEY_PASSWORD, `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`);
  revokeAllSessions();
}

export async function verifyLoginPassword(password: string): Promise<boolean> {
  const stored = readConfig(KEY_PASSWORD);
  if (!stored || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (
    scheme !== "scrypt" ||
    !saltB64 ||
    !hashB64 ||
    !Object.values(params).every((v) => Number.isInteger(v) && v > 0)
  ) {
    return false;
  }
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Failed sign-in throttling, per client address (in memory; resets on restart)
// ---------------------------------------------------------------------------
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 5000;
const loginAttempts = new Map<string, { failures: number; windowStart: number; lockedUntil: number }>();

export function loginLockRemainingMs(clientKey: string, now = Date.now()): number {
  const entry = loginAttempts.get(clientKey);
  return entry ? Math.max(0, entry.lockedUntil - now) : 0;
}

export function recordLoginFailure(clientKey: string, now = Date.now()): void {
  if (loginAttempts.size >= MAX_TRACKED_CLIENTS) {
    for (const [key, entry] of loginAttempts) {
      if (entry.lockedUntil <= now && now - entry.windowStart > FAILURE_WINDOW_MS) loginAttempts.delete(key);
    }
  }
  const entry = loginAttempts.get(clientKey);
  if (!entry || now - entry.windowStart > FAILURE_WINDOW_MS) {
    loginAttempts.set(clientKey, { failures: 1, windowStart: now, lockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = 0;
    entry.windowStart = now;
  }
}

export function recordLoginSuccess(clientKey: string): void {
  loginAttempts.delete(clientKey);
}
