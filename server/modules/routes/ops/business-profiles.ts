import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";

const FIELDS = {
  name: 160,
  website: 500,
  email: 320,
  service_area: 1000,
  hours: 1000,
  brand_voice: 4000,
  social_profiles: 2000,
  services: 8000,
  workflow_notes: 8000,
} as const;

export function ensureBusinessProfilesSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_profiles (
    business TEXT PRIMARY KEY CHECK (business IN ('tech','rental')),
    name TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    service_area TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', brand_voice TEXT NOT NULL DEFAULT '',
    social_profiles TEXT NOT NULL DEFAULT '', services TEXT NOT NULL DEFAULT '', workflow_notes TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO business_profiles (business) VALUES ('tech'), ('rental');`);
}

export function registerBusinessProfileRoutes(app: Express, db: DatabaseSync): void {
  ensureBusinessProfilesSchema(db);
  app.get("/api/business/profiles", (_req, res) => {
    res.json({ ok: true, items: db.prepare("SELECT * FROM business_profiles ORDER BY business").all() });
  });
  app.patch("/api/business/profiles/:business", (req, res) => {
    const business = req.params.business;
    if (business !== "tech" && business !== "rental") return res.status(400).json({ error: "invalid_business" });
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "invalid_body" });
    }
    const entries = Object.entries(req.body);
    if (!entries.length) return res.status(400).json({ error: "no_fields_to_update" });
    for (const [key, value] of entries) {
      if (!Object.hasOwn(FIELDS, key)) return res.status(400).json({ error: "unknown_profile_field" });
      if (typeof value !== "string" || value.length > FIELDS[key as keyof typeof FIELDS]) {
        return res.status(400).json({ error: `invalid_${key}` });
      }
      if (key === "website" && value.trim()) {
        try {
          const url = new URL(value.trim());
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch {
          return res.status(400).json({ error: "invalid_website" });
        }
      }
    }
    db.prepare(
      `UPDATE business_profiles SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ? WHERE business = ?`,
    ).run(...entries.map(([, value]) => (value as string).trim()), Date.now(), business);
    return res.json({ ok: true, item: db.prepare("SELECT * FROM business_profiles WHERE business = ?").get(business) });
  });
}
