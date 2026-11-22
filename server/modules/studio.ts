import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { upsertProviderLedgerEntry } from "./finance-store.ts";
import {
  ensureMediaSchema,
  getMediaAsset,
  saveMediaAsset,
  studioSpendThisMonth,
  type MediaAsset,
} from "./media-library.ts";

/**
 * The image studio:
 *
 *   1. The mockup renderer (free, no AI): built-in HTML templates filled with a title, colors and up to four images
 *      from the project, rendered to PNG with headless Chrome. Previews built from the real product files, which an
 *      image generator cannot reproduce faithfully.
 *   2. Images agents make with their own tools (Codex has built-in image generation on the owner's subscription):
 *      the agent saves the file in the project and records it with `media.register`. Free.
 *   3. Optional image API (off unless the owner configures it), for agents on providers without image generation
 *      (local models): any OpenAI-compatible `POST /images/generations`. Each image's cost is recorded and the month's
 *      total may not pass the owner's cap; past it the agent must ask with finance.request_spend.
 *
 * Outputs are saved in the project's `atlas-media/` folder (so listing packages can reference them) and recorded in
 * the media library with their source, prompt, license note and cost.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const MOCKUP_TEMPLATES = ["cover", "grid", "printable", "device"] as const;
export type MockupTemplate = (typeof MOCKUP_TEMPLATES)[number];
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MEDIA_FOLDER = "atlas-media";

export interface StudioContext {
  business: BusinessKey | null;
  projectId: string | null;
  projectPath: string | null;
  opportunityId?: string | null;
  listingId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
}

export interface StudioDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Renders HTML to a PNG; replaced in tests. */
  render?: (html: string, width: number, height: number, chromePath: string | null) => Promise<Buffer>;
}

function fail(message: string): never {
  throw new Error(message);
}

export function ensureStudioSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    provider TEXT NOT NULL DEFAULT 'none' CHECK(provider IN ('none','openai_compatible')),
    base_url TEXT NOT NULL DEFAULT '', api_key_enc TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    image_size TEXT NOT NULL DEFAULT '1024x1024',
    cost_per_image_minor INTEGER NOT NULL DEFAULT 0 CHECK(cost_per_image_minor BETWEEN 0 AND 100000),
    monthly_cap_minor INTEGER NOT NULL DEFAULT 0 CHECK(monthly_cap_minor BETWEEN 0 AND 10000000),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    chrome_path TEXT NOT NULL DEFAULT '', license_note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO studio_settings(id) VALUES (1);`);
}

function settingsRow(db: Db): Row {
  ensureStudioSchema(db);
  return db.prepare("SELECT * FROM studio_settings WHERE id=1").get() as Row;
}

export function studioSettings(db: Db, now = Date.now()) {
  const r = settingsRow(db);
  return {
    provider: String(r.provider),
    base_url: String(r.base_url),
    api_key_set: Boolean(r.api_key_enc),
    model: String(r.model),
    image_size: String(r.image_size),
    cost_per_image_minor: Number(r.cost_per_image_minor),
    monthly_cap_minor: Number(r.monthly_cap_minor),
    enabled: Boolean(r.enabled),
    chrome_path: String(r.chrome_path),
    license_note: String(r.license_note),
    spent_this_month_minor: studioSpendThisMonth(db, now),
    renderer_browser: findChrome(String(r.chrome_path) || null),
  };
}

export function saveStudioSettings(db: Db, input: Row, now = Date.now()) {
  const r = settingsRow(db);
  const str = (key: string, max: number) => {
    if (input[key] === undefined) return String(r[key]);
    if (typeof input[key] !== "string" || (input[key] as string).length > max) fail(`invalid_${key}`);
    return (input[key] as string).trim();
  };
  const int = (key: string, max: number) => {
    if (input[key] === undefined) return Number(r[key]);
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(`invalid_${key}`);
    return value;
  };
  const provider = input.provider === undefined ? String(r.provider) : input.provider;
  if (provider !== "none" && provider !== "openai_compatible") fail("invalid_provider");
  const baseUrl = str("base_url", 500);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return fail("invalid_base_url");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) fail("invalid_base_url");
  }
  const size = str("image_size", 20);
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) fail("invalid_image_size");
  let keyEnc = String(r.api_key_enc);
  if (input.api_key !== undefined) {
    if (typeof input.api_key !== "string" || input.api_key.length > 500) fail("invalid_api_key");
    keyEnc = input.api_key.trim() ? encryptSecret(input.api_key.trim()) : "";
  }
  const enabled = input.enabled === undefined ? Boolean(r.enabled) : input.enabled;
  if (typeof enabled !== "boolean") fail("invalid_enabled");
  const cap = int("monthly_cap_minor", 10_000_000);
  if (enabled && provider === "openai_compatible" && (!baseUrl || !str("model", 200)))
    fail("studio_provider_incomplete");
  db.prepare(
    `UPDATE studio_settings SET provider=?, base_url=?, api_key_enc=?, model=?, image_size=?, cost_per_image_minor=?,
     monthly_cap_minor=?, enabled=?, chrome_path=?, license_note=?, updated_at=? WHERE id=1`,
  ).run(
    provider as string,
    baseUrl,
    keyEnc,
    str("model", 200),
    size,
    int("cost_per_image_minor", 100_000),
    cap,
    enabled ? 1 : 0,
    str("chrome_path", 500),
    str("license_note", 500),
    now,
  );
  return studioSettings(db, now);
}

/** Chrome or Edge for the renderer: the setting, then PW_CHROMIUM_PATH, then the usual install folders. */
export function findChrome(configured: string | null): string | null {
  const candidates = [
    configured,
    process.env.PW_CHROMIUM_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

async function renderWithChrome(
  html: string,
  width: number,
  height: number,
  chromePath: string | null,
): Promise<Buffer> {
  const executable = findChrome(chromePath);
  if (!executable) fail("renderer_unavailable: no Chrome or Edge found (set its path in Settings > Studio)");
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    return fail("renderer_unavailable: Playwright is not installed");
  }
  const browser = await playwright.chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    return await page.screenshot({ type: "png", fullPage: false });
  } finally {
    await browser.close();
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback;
}

function projectRoot(ctx: StudioContext): string | null {
  return ctx.projectPath ? path.resolve(ctx.projectPath) : null;
}

/** A project image as a data URI. Paths must stay inside the project. */
function imageData(ctx: StudioContext, relative: unknown): string {
  const root = projectRoot(ctx) ?? fail("studio_needs_project_for_images");
  if (typeof relative !== "string" || !relative.trim()) fail("invalid_image");
  const full = path.resolve(root, relative.trim());
  if (!full.startsWith(root + path.sep)) fail("studio_image_outside_project");
  const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
  if (!type) fail(`studio_image_type_not_supported: ${relative}`);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(`studio_image_missing: ${relative}`);
  if (fs.statSync(full).size > MAX_IMAGE_BYTES) fail(`studio_image_too_large: ${relative}`);
  return `data:${type};base64,${fs.readFileSync(full).toString("base64")}`;
}

/** The HTML for one mockup. Exported for tests and for previewing templates. */
export function mockupHtml(
  template: MockupTemplate,
  input: { title: string; subtitle: string; background: string; accent: string; text: string; images: string[] },
  width: number,
  height: number,
): string {
  const { title, subtitle, background, accent, text, images } = input;
  const img = (src: string, style = "") => `<img src="${src}" style="${style}" />`;
  const heading = `<div class="title">${escapeHtml(title)}</div>${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}`;
  const body: Record<MockupTemplate, string> = {
    cover: `<div class="cover">${images[0] ? img(images[0], "max-width:52%;max-height:78%;") : ""}<div class="words">${heading}</div></div>`,
    grid: `<div class="gridwrap"><div class="grid">${images
      .slice(0, 4)
      .map((src) => `<div class="cell">${img(src)}</div>`)
      .join("")}</div><div class="strip">${heading}</div></div>`,
    printable: `<div class="desk">${images[0] ? `<div class="sheet">${img(images[0])}</div>` : ""}<div class="label">${heading}</div></div>`,
    device: `<div class="devicewrap"><div class="tablet">${images[0] ? img(images[0]) : ""}</div><div class="words">${heading}</div></div>`,
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
    body { background: ${background}; color: ${text}; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
    img { display: block; object-fit: contain; }
    .title { font-size: ${Math.round(width / 18)}px; font-weight: 700; line-height: 1.1; }
    .sub { font-size: ${Math.round(width / 40)}px; margin-top: ${Math.round(height / 60)}px; color: ${accent}; font-weight: 600; }
    .cover { height: 100%; display: flex; align-items: center; justify-content: space-around; padding: 6%; gap: 4%; }
    .cover img { box-shadow: 0 30px 60px rgba(0,0,0,.25); border-radius: 12px; background: #fff; }
    .cover .words { flex: 1; }
    .gridwrap { height: 100%; display: flex; flex-direction: column; padding: 4%; gap: 3%; }
    .grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 3%; }
    .cell { background: #fff; border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,.15); display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .cell img { width: 92%; height: 92%; }
    .strip { text-align: center; }
    .strip .title { font-size: ${Math.round(width / 26)}px; }
    .desk { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4%;
      background: radial-gradient(circle at 30% 20%, rgba(255,255,255,.35), transparent 60%), ${background}; }
    .sheet { width: 48%; height: 72%; background: #fff; padding: 2.5%; transform: rotate(-3deg); box-shadow: 0 40px 70px rgba(0,0,0,.3); }
    .sheet img { width: 100%; height: 100%; }
    .label { text-align: center; }
    .label .title { font-size: ${Math.round(width / 28)}px; }
    .devicewrap { height: 100%; display: flex; align-items: center; justify-content: space-around; padding: 6%; gap: 4%; }
    .tablet { width: 46%; aspect-ratio: 3 / 4; max-height: 86%; background: #111; border-radius: 36px; padding: 3%; box-shadow: 0 40px 80px rgba(0,0,0,.35); }
    .tablet img { width: 100%; height: 100%; background: #fff; border-radius: 14px; object-fit: cover; }
    .devicewrap .words { flex: 1; }
    .accent-bar { position: absolute; left: 0; bottom: 0; width: 100%; height: 1.2%; background: ${accent}; }
  </style></head><body>${body[template]}<div class="accent-bar"></div></body></html>`;
}

function outputPath(db: Db, ctx: StudioContext, name: string): { full: string; relative: string; project: boolean } {
  const root = projectRoot(ctx);
  if (root) {
    const folder = path.join(root, MEDIA_FOLDER);
    fs.mkdirSync(folder, { recursive: true });
    return { full: path.join(folder, name), relative: `${MEDIA_FOLDER}/${name}`, project: true };
  }
  const dataRoot = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : process.cwd();
  const folder = path.join(dataRoot, "media", ctx.business ?? "shared");
  fs.mkdirSync(folder, { recursive: true });
  return { full: path.join(folder, name), relative: `media/${ctx.business ?? "shared"}/${name}`, project: false };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "image"
  );
}

function pngSize(file: string): { width: number | null; height: number | null } {
  try {
    const head = Buffer.alloc(24);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    if (head.toString("ascii", 1, 4) !== "PNG") return { width: null, height: null };
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * `media.register`: an image an agent made with its own tools (Codex image generation, a design export) goes into
 * the media library, so listings and later tasks can find it. The file must be inside the project; one outside
 * atlas-media/ is copied there. Registering the same file twice returns the existing record. Free.
 */
export function registerImage(db: Db, input: Row, ctx: StudioContext, now = Date.now()): MediaAsset {
  ensureMediaSchema(db);
  const root = projectRoot(ctx) ?? fail("studio_needs_project_for_images");
  if (typeof input.path !== "string" || !input.path.trim()) fail("invalid_path");
  const full = path.resolve(root, input.path.trim());
  if (!full.startsWith(root + path.sep)) fail("studio_image_outside_project: copy the image into the project first");
  const ext = path.extname(full).toLowerCase();
  if (!IMAGE_TYPES[ext] || ext === ".svg") fail(`studio_image_type_not_supported: ${input.path}`);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(`studio_image_missing: ${input.path}`);
  if (fs.statSync(full).size > MAX_IMAGE_BYTES) fail(`studio_image_too_large: ${input.path}`);
  let relative = path.relative(root, full).split(path.sep).join("/");
  let stored = full;
  if (!relative.startsWith(`${MEDIA_FOLDER}/`)) {
    const out = outputPath(db, ctx, `${slug(path.basename(full, ext))}-${now}${ext}`);
    fs.copyFileSync(full, out.full);
    relative = out.relative;
    stored = out.full;
  }
  const existing = db
    .prepare("SELECT id FROM media_assets WHERE project_id IS ? AND path=? LIMIT 1")
    .get(ctx.projectId, relative) as Row | undefined;
  if (existing) return getMediaAsset(db, String(existing.id))!;
  const source =
    typeof input.source === "string" && input.source.trim()
      ? input.source.trim().slice(0, 100)
      : "codex image generation";
  const size = ext === ".png" ? pngSize(stored) : { width: null, height: null };
  return saveMediaAsset(
    db,
    {
      business: ctx.business,
      project_id: ctx.projectId,
      opportunity_id: ctx.opportunityId ?? null,
      listing_id: ctx.listingId ?? null,
      kind: "generated",
      path: relative,
      source,
      prompt: typeof input.prompt === "string" ? input.prompt.trim().slice(0, 4000) : "",
      license: `AI-generated by ${source}. Check the provider's terms before commercial use.`,
      tags: input.tags,
      width: size.width,
      height: size.height,
      cost_minor: 0,
      currency: "USD",
      agent_id: ctx.agentId ?? null,
      task_id: ctx.taskId ?? null,
    },
    now,
  );
}

/** Free: renders one mockup from a template and saves it. */
export async function renderMockup(db: Db, input: Row, ctx: StudioContext, deps: StudioDeps = {}): Promise<MediaAsset> {
  const now = deps.now?.() ?? Date.now();
  const template = (input.template ?? "cover") as MockupTemplate;
  if (!(MOCKUP_TEMPLATES as readonly string[]).includes(template)) fail("invalid_template");
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  if (!title) fail("invalid_title");
  const subtitle = typeof input.subtitle === "string" ? input.subtitle.trim().slice(0, 160) : "";
  const imagesIn = Array.isArray(input.images) ? input.images.slice(0, 4) : [];
  if (template !== "cover" && !imagesIn.length) fail("studio_template_needs_images");
  const images = imagesIn.map((image) => imageData(ctx, image));
  const width = Number.isSafeInteger(input.width) ? Math.min(3000, Math.max(400, input.width as number)) : 2000;
  const height = Number.isSafeInteger(input.height) ? Math.min(3000, Math.max(400, input.height as number)) : 1600;
  const colors = (input.colors && typeof input.colors === "object" ? input.colors : {}) as Row;
  const html = mockupHtml(
    template,
    {
      title,
      subtitle,
      background: color(colors.background, "#f4efe8"),
      accent: color(colors.accent, "#b4542d"),
      text: color(colors.text, "#1f1b16"),
      images,
    },
    width,
    height,
  );
  const png = await (deps.render ?? renderWithChrome)(html, width, height, String(settingsRow(db).chrome_path) || null);
  const out = outputPath(db, ctx, `${slug(title)}-${template}-${now}.png`);
  fs.writeFileSync(out.full, png);
  return saveMediaAsset(
    db,
    {
      business: ctx.business,
      project_id: out.project ? ctx.projectId : null,
      opportunity_id: ctx.opportunityId ?? null,
      listing_id: ctx.listingId ?? null,
      kind: "mockup",
      path: out.relative,
      source: `renderer:${template}`,
      prompt: [title, subtitle].filter(Boolean).join(" — "),
      license: "Made by ATLAS from project files; same rights as those files.",
      tags: input.tags,
      width,
      height,
      cost_minor: 0,
      currency: "USD",
      agent_id: ctx.agentId ?? null,
      task_id: ctx.taskId ?? null,
    },
    now,
  );
}

/** Paid or homelab image API. Refuses when it is off, unconfigured, or would pass the monthly cap. */
export async function generateImage(
  db: Db,
  input: Row,
  ctx: StudioContext,
  deps: StudioDeps = {},
): Promise<MediaAsset> {
  const now = deps.now?.() ?? Date.now();
  const r = settingsRow(db);
  if (!r.enabled || r.provider !== "openai_compatible")
    fail("studio_generation_off: the owner has not set up an image provider");
  if (!r.base_url || !r.model) fail("studio_provider_incomplete");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt.length < 4 || prompt.length > 4000) fail("invalid_prompt");
  const cost = Number(r.cost_per_image_minor);
  const cap = Number(r.monthly_cap_minor);
  if (cost > 0 && studioSpendThisMonth(db, now) + cost > cap)
    fail("studio_monthly_cap_reached: ask for more with finance.request_spend (category ai_tools)");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (r.api_key_enc) headers.authorization = `Bearer ${decryptSecret(String(r.api_key_enc))}`;
  const response = await (deps.fetch ?? fetch)(`${String(r.base_url).replace(/\/$/, "")}/images/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: r.model, prompt, size: r.image_size, n: 1, response_format: "b64_json" }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => ({}))) as Row;
  const data = Array.isArray(body.data) ? (body.data[0] as Row | undefined) : undefined;
  if (!response.ok || !data || typeof data.b64_json !== "string")
    fail(
      `studio_provider_failed: ${String((body.error as Row | undefined)?.message ?? response.status).slice(0, 200)}`,
    );
  const [w, h] = String(r.image_size).split("x").map(Number);
  const out = outputPath(db, ctx, `${slug(prompt)}-generated-${now}.png`);
  fs.writeFileSync(out.full, Buffer.from(data.b64_json as string, "base64"));
  const asset = saveMediaAsset(
    db,
    {
      business: ctx.business,
      project_id: out.project ? ctx.projectId : null,
      opportunity_id: ctx.opportunityId ?? null,
      listing_id: ctx.listingId ?? null,
      kind: "generated",
      path: out.relative,
      source: `provider:${String(r.model).slice(0, 80)}`,
      prompt,
      license: String(r.license_note) || "Generated image; check the provider's terms before selling.",
      tags: input.tags,
      width: w || null,
      height: h || null,
      cost_minor: cost,
      currency: "USD",
      agent_id: ctx.agentId ?? null,
      task_id: ctx.taskId ?? null,
    },
    now,
  );
  if (cost > 0 && ctx.business && isBusinessKey(ctx.business)) {
    upsertProviderLedgerEntry(
      db,
      {
        business: ctx.business,
        kind: "expense",
        amount_minor: cost,
        currency: "USD",
        source: "tool_usage",
        external_id: `studio:${asset.id}`,
        verified: false,
        description: `Image generation (${String(r.model).slice(0, 60)})`,
        occurred_at: now,
        opportunity_id: ctx.opportunityId ?? null,
      },
      now,
    );
  }
  return asset;
}

/** Checks the provider answers (its model list), without making a paid image. */
export async function testStudioProvider(db: Db, deps: StudioDeps = {}) {
  const r = settingsRow(db);
  if (r.provider !== "openai_compatible" || !r.base_url) fail("studio_provider_incomplete");
  const headers: Record<string, string> = {};
  if (r.api_key_enc) headers.authorization = `Bearer ${decryptSecret(String(r.api_key_enc))}`;
  const response = await (deps.fetch ?? fetch)(`${String(r.base_url).replace(/\/$/, "")}/models`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) fail(`studio_provider_failed: HTTP ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as Row;
  const models = Array.isArray(body.data) ? (body.data as Row[]).map((m) => String(m.id)).slice(0, 50) : [];
  return { ok: true, models };
}
