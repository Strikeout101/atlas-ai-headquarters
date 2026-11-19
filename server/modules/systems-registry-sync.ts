import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { knowledgeDir } from "./agent-knowledge.ts";

/**
 * Keeps one section of the private systems registry (`knowledge/systems.md`) in step with what ATLAS itself knows:
 * projects, connected accounts, mailboxes, SSH hosts and model hosts. The owner's own text is never touched; only the
 * part between the two markers is rewritten, and only when something changed.
 *
 * Names, logins and locations only. Columns holding tokens, passwords or keys are never read.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const AUTO_START = "<!-- ATLAS:AUTO START (rewritten by ATLAS; edit the rest of this file freely) -->";
export const AUTO_END = "<!-- ATLAS:AUTO END -->";
const SYNC_INTERVAL_MS = 10 * 60_000;

function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}
/** Rows of `table` with only the listed columns that exist (never a `*_enc` column). */
function rows(db: Db, table: string, wanted: string[], orderBy: string): Row[] {
  if (!tableExists(db, table)) return [];
  const have = columns(db, table);
  const cols = wanted.filter((c) => have.has(c) && !c.endsWith("_enc"));
  if (!cols.length) return [];
  const order = have.has(orderBy) ? ` ORDER BY ${orderBy}` : "";
  return db.prepare(`SELECT ${cols.join(", ")} FROM ${table}${order}`).all() as Row[];
}
const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const tested = (ok: unknown) =>
  ok === 1 || ok === true ? "test passed" : ok === 0 || ok === false ? "test failed" : "";
const join = (...parts: string[]) => parts.filter(Boolean).join(", ");

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
}

/** The generated markdown, without the markers. */
export function buildAutoSection(db: Db): string {
  const out: string[] = ["## Current setup (kept up to date by ATLAS)", ""];
  const list = (heading: string, items: string[], empty: string) => {
    out.push(`### ${heading}`, "", ...(items.length ? items.map((item) => `- ${item}`) : [`- ${empty}`]), "");
  };

  list(
    "Projects",
    rows(db, "projects", ["name", "business", "project_path", "github_repo"], "name").map((r) =>
      join(text(r.name), r.business ? `business ${text(r.business)}` : "", text(r.project_path), text(r.github_repo)),
    ),
    "none registered yet",
  );
  list(
    "GitHub accounts",
    rows(db, "github_accounts", ["label", "login", "business", "is_default", "last_test_ok"], "label").map((r) =>
      join(
        text(r.label),
        r.login ? `login ${text(r.login)}` : "",
        r.business ? `for ${text(r.business)}` : "",
        r.is_default ? "default" : "",
        tested(r.last_test_ok),
      ),
    ),
    "none connected",
  );
  const mapped = new Map<string, string[]>();
  for (const r of rows(db, "square_location_mappings", ["business", "connection_id"], "business")) {
    const key = text(r.connection_id);
    mapped.set(key, [...(mapped.get(key) ?? []), text(r.business)]);
  }
  list(
    "Square connections",
    rows(db, "square_connection", ["id", "label", "environment", "enabled"], "label").map((r) =>
      join(
        text(r.label) || "Square",
        text(r.environment),
        r.enabled ? "sync on" : "sync off",
        mapped.get(text(r.id))?.length ? `businesses ${[...new Set(mapped.get(text(r.id)))].join("/")}` : "",
      ),
    ),
    "none connected",
  );
  list(
    "Mailboxes",
    rows(db, "business_mailboxes", ["business", "email", "imap_host", "smtp_host", "last_test_ok"], "business").map(
      (r) =>
        join(
          `${text(r.business)}: ${text(r.email)}`,
          r.imap_host ? `IMAP ${text(r.imap_host)}` : "",
          r.smtp_host ? `SMTP ${text(r.smtp_host)}` : "",
          tested(r.last_test_ok),
        ),
    ),
    "none configured",
  );
  const socialHasToken =
    tableExists(db, "business_social_accounts") && columns(db, "business_social_accounts").has("token_enc");
  const tokenSet = new Set(
    socialHasToken
      ? (
          db
            .prepare("SELECT id FROM business_social_accounts WHERE token_enc IS NOT NULL AND token_enc <> ''")
            .all() as Row[]
        ).map((r) => text(r.id))
      : [],
  );
  list(
    "Social accounts",
    rows(db, "business_social_accounts", ["id", "business", "platform", "username"], "business").map((r) =>
      join(
        `${text(r.business)}: ${text(r.platform)} ${text(r.username)}`.trim(),
        tokenSet.has(text(r.id)) ? "token stored" : "no token yet",
      ),
    ),
    "none configured",
  );
  list(
    "SSH hosts",
    rows(db, "homelab_ssh_targets", ["name", "host", "ssh_user", "port", "enabled", "auth_method"], "name").map((r) =>
      join(
        text(r.name),
        `${text(r.ssh_user) ? `${text(r.ssh_user)}@` : ""}${text(r.host)}${r.port ? `:${String(r.port)}` : ""}`,
        text(r.auth_method) ? `${text(r.auth_method)} auth` : "",
        r.enabled ? "" : "disabled",
      ),
    ),
    "none configured",
  );
  list(
    "Model hosts and API providers",
    rows(db, "api_providers", ["name", "type", "base_url", "enabled"], "name").map((r) =>
      join(text(r.name), text(r.type), hostOf(r.base_url), r.enabled ? "enabled" : "disabled"),
    ),
    "none configured",
  );
  list(
    "Subscription sign-ins",
    rows(db, "oauth_accounts", ["provider", "label", "status"], "provider").map((r) =>
      join(text(r.provider), text(r.label), text(r.status)),
    ),
    "none",
  );
  return out.join("\n").trimEnd();
}

/** `existing` with the generated section replaced (or added at the end). */
export function mergeAutoSection(existing: string, section: string): string {
  const block = `${AUTO_START}\n${section}\n${AUTO_END}`;
  const start = existing.indexOf(AUTO_START);
  const end = existing.indexOf(AUTO_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + AUTO_END.length);
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/**
 * Rewrites the generated section of the registry if it changed. Does nothing when the owner has no registry yet,
 * so it never creates the private file on its own.
 */
export function syncSystemsRegistry(
  db: Db,
  file = path.join(knowledgeDir(), "systems.md"),
): "updated" | "unchanged" | "no_registry" {
  if (!fs.existsSync(file)) return "no_registry";
  const existing = fs.readFileSync(file, "utf8");
  const next = mergeAutoSection(existing, buildAutoSection(db));
  if (next === existing) return "unchanged";
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, file);
  return "updated";
}

/** At startup, then every 10 minutes. Failures are logged and retried next time. */
export function startSystemsRegistrySync(db: Db, log: (message: string) => void = console.log): () => void {
  const run = () => {
    try {
      if (syncSystemsRegistry(db) === "updated") log("[ATLAS] systems registry: current setup section updated");
    } catch (error) {
      log(`[ATLAS] systems registry sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(run, 15_000);
  const timer = setInterval(run, SYNC_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
