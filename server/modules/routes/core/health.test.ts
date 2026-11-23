import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerHealthRoutes } from "./health.ts";

// The supervisor checks /api/health after every Update and rolls back if it fails; keep it answering.
describe("health routes", () => {
  it.each(["/health", "/healthz", "/api/health"])("%s answers with the app and version", async (path) => {
    const app = express();
    registerHealthRoutes(app, "C:/data/atlas.sqlite");
    const res = await request(app).get(path).expect(200);
    expect(res.body).toMatchObject({ ok: true, app: "ATLAS", dbPath: "C:/data/atlas.sqlite" });
    expect(typeof res.body.version).toBe("string");
  });
});
