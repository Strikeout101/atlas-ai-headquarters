import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";
import { applyDefaultSeeds, LEGACY_KOREAN_SEED_PERSONALITIES } from "./seeds.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function freshDb() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  return db;
}

const HANGUL = /[가-힯]/;

describe("default seeds language", () => {
  it("seeds English personalities and an English language setting on a new install", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = freshDb();
    applyDefaultSeeds(db);
    const personalities = db.prepare("SELECT personality FROM agents").all() as Array<{ personality: string }>;
    expect(personalities.length).toBeGreaterThan(0);
    for (const { personality } of personalities) expect(personality).not.toMatch(HANGUL);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'language'").get()).toEqual({ value: "en" });
  });

  it("translates untouched Korean seed personalities on existing installs and leaves edited ones alone", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = freshDb();
    applyDefaultSeeds(db);
    const [aria, bolt] = db.prepare("SELECT id FROM agents ORDER BY name LIMIT 2").all() as Array<{ id: string }>;
    const [korean, english] = LEGACY_KOREAN_SEED_PERSONALITIES[0];
    db.prepare("UPDATE agents SET personality = ? WHERE id = ?").run(korean, aria.id);
    db.prepare("UPDATE agents SET personality = ? WHERE id = ?").run("내가 직접 쓴 성격", bolt.id);
    applyDefaultSeeds(db);
    expect(db.prepare("SELECT personality FROM agents WHERE id = ?").get(aria.id)).toEqual({ personality: english });
    expect(db.prepare("SELECT personality FROM agents WHERE id = ?").get(bolt.id)).toEqual({
      personality: "내가 직접 쓴 성격",
    });
  });
});
