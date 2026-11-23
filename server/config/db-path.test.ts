import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, PREVIOUS_DB_PATH, resolveDbPath } from "./runtime.ts";

const saved = process.env.DB_PATH;
afterEach(() => {
  if (saved === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = saved;
});

describe("choosing the database file (rename to ATLAS)", () => {
  it("prefers DB_PATH, then atlas.sqlite, then the pre-rename claw-empire.sqlite, and never renames", () => {
    delete process.env.DB_PATH;
    expect(DEFAULT_DB_PATH.endsWith("atlas.sqlite")).toBe(true);
    expect(PREVIOUS_DB_PATH.endsWith("claw-empire.sqlite")).toBe(true);
    expect(resolveDbPath((file) => file === DEFAULT_DB_PATH || file === PREVIOUS_DB_PATH)).toBe(DEFAULT_DB_PATH);
    // Before the owner runs the rename script, the old file keeps working (and a rollback still finds it).
    expect(resolveDbPath((file) => file === PREVIOUS_DB_PATH)).toBe(PREVIOUS_DB_PATH);
    expect(resolveDbPath(() => false)).toBe(DEFAULT_DB_PATH);
    process.env.DB_PATH = "C:/data/custom.sqlite";
    expect(resolveDbPath(() => true)).toBe("C:/data/custom.sqlite");
  });
});
