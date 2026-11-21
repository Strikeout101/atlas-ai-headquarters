import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  SKILL_LEARN_PROVIDER_TO_AGENT,
  SKILL_LEARN_REPO_RE,
  SKILLS_NPX_CMD,
  isSkillLearnProvider,
} from "./routes/ops/skills/learn-constants.ts";
import type { SkillLearnProvider } from "./routes/ops/skills/types.ts";

/**
 * Skills for agents, installed with the `skills` CLI (skills.sh) as global (user-level) skills for every AI provider
 * the agents use, and recorded in `skill_learning_history` so they show in Team > Library and in agent prompts.
 *
 *   - Recommended skills: a short, reviewed list useful to most goals (documents, spreadsheets, design, market and
 *     customer research, pricing, copy, launch, SEO). Installed once at startup.
 *   - Requested skills: an agent finds one (`skills.search`) and asks for it (`skills.request`); both VPs review the
 *     request with the skill's own description, and approval installs it.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LIST_TIMEOUT_MS = 2 * 60_000;
const RECOMMENDED_SETTING = "recommended_skills_v1";
const MAX_RECOMMENDED_ATTEMPTS = 3;

/**
 * Reviewed 2026-11-21: Anthropic's official document and design skills, and Corey Haines's marketing skills (plain
 * instructions; the only commands are read-only public feed lookups), plus Nexscope's etsy-seo (a local scoring
 * script, no network). Thin promotional skills were left out.
 */
export const RECOMMENDED_SKILLS: Array<{ repo: string; skills: string[]; why: string }> = [
  {
    repo: "anthropics/skills",
    skills: ["pdf", "docx", "xlsx", "pptx", "canvas-design", "frontend-design"],
    why: "Make printables, documents, spreadsheets, decks, visual designs and web pages.",
  },
  {
    repo: "coreyhaines31/marketingskills",
    skills: [
      "customer-research",
      "competitor-profiling",
      "marketing-ideas",
      "marketing-plan",
      "pricing",
      "offers",
      "copywriting",
      "copy-editing",
      "product-marketing",
      "content-strategy",
      "launch",
      "seo-audit",
      "social",
      "marketing-psychology",
    ],
    why: "Research markets and customers, price, write copy, plan launches and marketing.",
  },
  {
    repo: "nexscope-ai/ecommerce-skills",
    skills: ["etsy-seo"],
    why: "Score and improve Etsy titles, tags and descriptions.",
  },
];

export interface SkillsCliResult {
  code: number | null;
  output: string;
}
export type SkillsCliRunner = (args: string[], timeoutMs: number) => Promise<SkillsCliResult>;

const stripAnsi = (text: string) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*\u0007/g, "");

/** Runs `npx --yes skills@latest ...` and returns its exit code and (ANSI-free) output. */
export const runSkillsCli: SkillsCliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(SKILLS_NPX_CMD, ["--yes", "skills@latest", ...args], {
        env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-200_000);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: stripAnsi(output) });
    });
  });

function validRepo(repo: unknown): string {
  const value =
    typeof repo === "string"
      ? repo
          .trim()
          .replace(/^https:\/\/github\.com\//, "")
          .replace(/\.git$/, "")
      : "";
  if (!SKILL_LEARN_REPO_RE.test(value) || value.length > 200) throw new Error("invalid_skill_repo");
  return value;
}
function validSkill(skill: unknown): string {
  const value = typeof skill === "string" ? skill.trim() : "";
  if (!SKILL_NAME_RE.test(value)) throw new Error("invalid_skill_name");
  return value;
}

/** The skills a repository offers, with their own descriptions, from `skills add <repo> --list`. */
export async function listRepoSkills(repo: unknown, run: SkillsCliRunner = runSkillsCli) {
  const source = validRepo(repo);
  const result = await run(["add", source, "--list", "--yes"], LIST_TIMEOUT_MS);
  if (result.code !== 0)
    throw new Error(`skill_repo_unreadable: ${result.output.trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
  const skills: Array<{ name: string; description: string }> = [];
  const lines = result.output.split(/\r?\n/).map((line) => line.replace(/^[│|]\s?/, ""));
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\s{2,4}([A-Za-z0-9][A-Za-z0-9_.-]{0,79})\s*$/)?.[1];
    if (!name) continue;
    let description = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const text = lines[j].trim();
      if (!text) continue;
      if (/^\s{5,}\S/.test(lines[j])) description = text;
      break;
    }
    if (!skills.some((skill) => skill.name === name)) skills.push({ name, description: description.slice(0, 1200) });
  }
  return skills;
}

/** skills.sh search: published skills matching `query`, most installed first. */
export async function searchSkills(query: unknown, deps: { fetch?: typeof fetch } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (q.length < 2 || q.length > 100) throw new Error("invalid_query");
  const response = await (deps.fetch ?? fetch)(`https://skills.sh/api/search?q=${encodeURIComponent(q)}`, {
    headers: { accept: "application/json", "user-agent": "ATLAS-Research/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`skills_search_failed: ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { skills?: Row[] };
  return (Array.isArray(body.skills) ? body.skills : [])
    .map((skill) => ({
      repo: String(skill.source ?? ""),
      skill: String(skill.skillId ?? skill.name ?? ""),
      installs: Number.isFinite(Number(skill.installs)) ? Number(skill.installs) : null,
    }))
    .filter((skill) => SKILL_LEARN_REPO_RE.test(skill.repo) && SKILL_NAME_RE.test(skill.skill))
    .sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0))
    .slice(0, 15);
}

/** The AI providers ATLAS agents run on that skills can be installed for. */
export function learnableProviders(db: Db): SkillLearnProvider[] {
  const rows = db.prepare("SELECT DISTINCT cli_provider FROM agents WHERE cli_provider IS NOT NULL").all() as Row[];
  const providers = rows.map((row) => String(row.cli_provider)).filter(isSkillLearnProvider);
  return providers.length ? [...new Set(providers)] : ["codex", "claude"];
}

/** Skills already installed successfully, as `repo#skill`. */
export function installedSkills(db: Db): string[] {
  return (
    db.prepare("SELECT DISTINCT repo, skill_id FROM skill_learning_history WHERE status='succeeded'").all() as Row[]
  ).map((row) => `${String(row.repo).toLowerCase()}#${String(row.skill_id).toLowerCase()}`);
}

/** Installs one skill globally for every provider the agents use, recording each provider's result. */
export async function installSkill(
  db: Db,
  input: { repo: unknown; skill: unknown; providers?: SkillLearnProvider[] },
  run: SkillsCliRunner = runSkillsCli,
): Promise<{ ok: boolean; jobId: string; output: string }> {
  const repo = validRepo(input.repo);
  const skill = validSkill(input.skill);
  const providers = input.providers?.length ? input.providers : learnableProviders(db);
  const agents = [...new Set(providers.map((provider) => SKILL_LEARN_PROVIDER_TO_AGENT[provider]))];
  const args = ["add", repo, "-g", "--copy", "--skill", skill, "--yes", "--agent", ...agents];
  const jobId = randomUUID();
  const command = `npx --yes skills@latest ${args.join(" ")}`;
  const record = (status: string, error: string | null, startedAt: number | null, completedAt: number | null) => {
    const now = Date.now();
    for (const provider of providers)
      db.prepare(
        `INSERT INTO skill_learning_history (id,job_id,provider,repo,skill_id,skill_label,status,command,error,run_started_at,run_completed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id, provider) DO UPDATE SET status=excluded.status, error=excluded.error,
           run_started_at=COALESCE(excluded.run_started_at, skill_learning_history.run_started_at),
           run_completed_at=COALESCE(excluded.run_completed_at, skill_learning_history.run_completed_at),
           updated_at=excluded.updated_at`,
      ).run(
        randomUUID(),
        jobId,
        provider,
        repo,
        skill,
        `${repo}#${skill}`,
        status,
        command,
        error,
        startedAt,
        completedAt,
        now,
        now,
      );
  };
  const started = Date.now();
  record("running", null, started, null);
  const result = await run(args, INSTALL_TIMEOUT_MS);
  const ok = result.code === 0;
  record(
    ok ? "succeeded" : "failed",
    ok ? null : result.output.trim().slice(-500) || "install failed",
    null,
    Date.now(),
  );
  return { ok, jobId, output: result.output.slice(-2000) };
}

/**
 * Installs the recommended skills not yet installed. Runs at startup until every one has succeeded, at most three
 * times, one skill at a time in the background.
 */
export async function installRecommendedSkills(db: Db, run: SkillsCliRunner = runSkillsCli) {
  const stored = db.prepare("SELECT value FROM settings WHERE key=?").get(RECOMMENDED_SETTING) as Row | undefined;
  let state: { attempts: number; done: boolean } = { attempts: 0, done: false };
  try {
    if (stored?.value) state = { ...state, ...JSON.parse(String(stored.value)) };
  } catch {
    /* start over */
  }
  if (state.done || state.attempts >= MAX_RECOMMENDED_ATTEMPTS) return { installed: 0, failed: 0, skipped: true };
  const save = (value: typeof state) =>
    db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(RECOMMENDED_SETTING, JSON.stringify(value));
  state.attempts += 1;
  save(state);
  const have = new Set(installedSkills(db));
  let installed = 0;
  let failed = 0;
  for (const group of RECOMMENDED_SKILLS)
    for (const skill of group.skills) {
      if (have.has(`${group.repo.toLowerCase()}#${skill.toLowerCase()}`)) continue;
      const result = await installSkill(db, { repo: group.repo, skill }, run);
      if (result.ok) installed++;
      else failed++;
    }
  state.done = failed === 0;
  save(state);
  return { installed, failed, skipped: false };
}
