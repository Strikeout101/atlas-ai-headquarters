import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";
import { applyDefaultSeeds, DEFAULT_AGENTS, LEGACY_KOREAN_SEED_PERSONALITIES } from "./seeds.ts";

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

describe("default agent names", () => {
  function legacyInstall() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = freshDb();
    const dept = db.prepare(
      "INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, sort_order) VALUES (?, ?, '', '', '', '', '#000', ?)",
    );
    ["planning", "dev", "design", "qa", "devsecops", "operations"].forEach((id, i) => dept.run(id, id, i + 1));
    // An install seeded before the rename: old names, no pinned sprites.
    const insert = db.prepare(
      "INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, personality, workflow_pack_key) VALUES (?, ?, ?, ?, ?, 'codex', 'x', 'development')",
    );
    insert.run("a1", "Aria", "아리아", "dev", "team_leader");
    insert.run("a2", "DORO", "도로롱", "qa", "junior");
    insert.run("a3", "Sage", "세이지", "planning", "team_leader");
    insert.run("a4", "Bolt", "볼트", "qa", "senior"); // moved to QA by the owner: not a default any more
    insert.run("a5", "My Lead", "", "operations", "team_leader"); // renamed by the owner
    return db;
  }

  it("does not bring back default agents the owner deleted when the server restarts", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = freshDb();
    applyDefaultSeeds(db);
    db.prepare("DELETE FROM agents WHERE name IN ('Claire', 'Felix', 'Priya')").run();
    applyDefaultSeeds(db);
    const names = (db.prepare("SELECT name FROM agents").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain("Claire");
    expect(names).not.toContain("Felix");
    expect(names).not.toContain("Priya");
  });

  it("leaves an existing install alone even before the one-time top-up was recorded", () => {
    const db = legacyInstall();
    db.prepare("DELETE FROM settings WHERE key = 'laterDefaultAgentsAdded'").run();
    db.prepare(
      "INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, personality, workflow_pack_key) VALUES ('v', 'Victor', '', 'qa', 'team_leader', 'codex', 'x', 'development')",
    ).run();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
    applyDefaultSeeds(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(before);
  });

  it("seeds a new install with names and matched, pinned headshots", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = freshDb();
    applyDefaultSeeds(db);
    const rows = db.prepare("SELECT name, sprite_number FROM agents ORDER BY sprite_number").all() as Array<{
      name: string;
      sprite_number: number;
    }>;
    expect(rows.map((r) => r.name)).toEqual(
      DEFAULT_AGENTS.map((a) => a)
        .sort((x, y) => x.sprite - y.sprite)
        .map((a) => a.name),
    );
    expect(new Set(rows.map((r) => r.sprite_number)).size).toBe(DEFAULT_AGENTS.length);
  });

  it("renames untouched default agents, keeps DORO's face, and leaves owner changes alone", () => {
    const db = legacyInstall();
    applyDefaultSeeds(db);
    const byId = (id: string) =>
      db.prepare("SELECT name, name_ko, sprite_number FROM agents WHERE id = ?").get(id) as {
        name: string;
        name_ko: string;
        sprite_number: number | null;
      };
    expect(byId("a1")).toEqual({ name: "Marcus", name_ko: "마커스", sprite_number: null });
    expect(byId("a2")).toEqual({ name: "Leo", name_ko: "레오", sprite_number: 13 });
    expect(byId("a3").name).toBe("Adrian");
    expect(byId("a4").name).toBe("Bolt");
    expect(byId("a5").name).toBe("My Lead");
    // Running again changes nothing.
    applyDefaultSeeds(db);
    expect(byId("a1").name).toBe("Marcus");
  });
});
