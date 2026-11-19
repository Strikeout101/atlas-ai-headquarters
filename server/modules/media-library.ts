import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";

/**
 * The media library: every image ATLAS makes or is given, with where it came from, its license terms, its cost and
 * tags agents can search. Files made for a project live inside that project (`atlas-media/`), so listing packages can
 * reference them by the same relative paths as product files.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const MEDIA_KINDS = ["mockup", "generated", "upload"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaAsset {
  id: string;
  business: BusinessKey | null;
  project_id: string | null;
  opportunity_id: string | null;
  listing_id: string | null;
  kind: MediaKind;
  /** Relative to the project folder when project_id is set; otherwise relative to the ATLAS data folder. */
  path: string;
  source: string;
  prompt: string;
  license: string;
  tags: string[];
  width: number | null;
  height: number | null;
  cost_minor: number;
  currency: string;
  agent_id: string | null;
  task_id: string | null;
  created_at: number;
}

export function ensureMediaSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY, business TEXT, project_id TEXT, opportunity_id TEXT, listing_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('mockup','generated','upload')), path TEXT NOT NULL,
    source TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', license TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
    width INTEGER, height INTEGER, cost_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
    agent_id TEXT, task_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_business ON media_assets(business, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_opportunity ON media_assets(opportunity_id);`);
}

function toAsset(row: Row): MediaAsset {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(String(row.tags ?? "[]"));
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return { ...(row as unknown as MediaAsset), tags };
}

export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().toLowerCase().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

export function saveMediaAsset(
  db: Db,
  input: Omit<MediaAsset, "id" | "created_at" | "tags"> & { tags?: unknown },
  now = Date.now(),
): MediaAsset {
  ensureMediaSchema(db);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_assets(id,business,project_id,opportunity_id,listing_id,kind,path,source,prompt,license,tags,width,height,
       cost_minor,currency,agent_id,task_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.business && isBusinessKey(input.business) ? input.business : null,
    input.project_id,
    input.opportunity_id,
    input.listing_id,
    input.kind,
    input.path,
    input.source.slice(0, 200),
    input.prompt.slice(0, 4000),
    input.license.slice(0, 500),
    JSON.stringify(cleanTags(input.tags)),
    input.width,
    input.height,
    input.cost_minor,
    input.currency,
    input.agent_id,
    input.task_id,
    now,
  );
  return getMediaAsset(db, id)!;
}

export function getMediaAsset(db: Db, id: string): MediaAsset | null {
  ensureMediaSchema(db);
  const row = db.prepare("SELECT * FROM media_assets WHERE id=?").get(id) as Row | undefined;
  return row ? toAsset(row) : null;
}

/** Newest first; `query` matches tags, prompt, path and source words. */
export function searchMedia(
  db: Db,
  filter: { query?: unknown; business?: unknown; project_id?: unknown; opportunity_id?: unknown; limit?: number } = {},
): MediaAsset[] {
  ensureMediaSchema(db);
  const where: string[] = [];
  const params: string[] = [];
  if (isBusinessKey(filter.business)) {
    where.push("business=?");
    params.push(filter.business);
  }
  for (const key of ["project_id", "opportunity_id"] as const) {
    if (typeof filter[key] === "string" && filter[key]) {
      where.push(`${key}=?`);
      params.push(filter[key] as string);
    }
  }
  const words =
    typeof filter.query === "string"
      ? filter.query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length > 1)
          .slice(0, 8)
      : [];
  for (const word of words) {
    where.push("(lower(tags) LIKE ? OR lower(prompt) LIKE ? OR lower(path) LIKE ? OR lower(source) LIKE ?)");
    params.push(...Array(4).fill(`%${word}%`));
  }
  const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 30)));
  return (
    db
      .prepare(
        `SELECT * FROM media_assets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ${limit}`,
      )
      .all(...params) as Row[]
  ).map(toAsset);
}

/** What the studio's image provider has cost this calendar month (UTC), in minor units. */
export function studioSpendThisMonth(db: Db, now = Date.now()): number {
  ensureMediaSchema(db);
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return Number(
    (
      db
        .prepare("SELECT COALESCE(SUM(cost_minor),0) AS n FROM media_assets WHERE kind='generated' AND created_at>=?")
        .get(start) as { n: number }
    ).n,
  );
}
