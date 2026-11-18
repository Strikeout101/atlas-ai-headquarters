import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeCollabLanguagePolicy } from "./language-policy.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

describe("language-policy detectTargetDepartments", () => {
  it("detects related departments by their custom names", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO departments (id, name) VALUES (?, ?), (?, ?)").run(
        "planning",
        "Pre-production",
        "dev",
        "Scene Engine",
      );

      const { detectTargetDepartments } = initializeCollabLanguagePolicy({ db });
      const found = detectTargetDepartments("Pre-production and Scene Engine should prepare the storyboard together");

      expect(found).toContain("planning");
      expect(found).toContain("dev");
    } finally {
      db.close();
    }
  });

  it("detects a department name without its team suffix", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO departments (id, name) VALUES (?, ?)").run("planning", "Pre-production Team");

      const { detectTargetDepartments } = initializeCollabLanguagePolicy({ db });
      const found = detectTargetDepartments("Look at the pre-production issue first");

      expect(found).toContain("planning");
    } finally {
      db.close();
    }
  });
});
