import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Express } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { requireOwnerSession } from "../../../security/auth.ts";
import { appendAutonomyLedger, autonomyConfig, autonomyOverview, ensureAutonomySchema } from "../../autonomy-store.ts";
import { isBusinessKey } from "../../businesses.ts";
import { currencyMinorDigits } from "../../finance-store.ts";

type Body = Record<string, unknown>;
const SCORE_FIELDS = ["demand_score", "revenue_score", "cost_score", "difficulty_score", "time_to_launch_score"];
const RESOURCES = {
  goals: {
    table: "business_goals",
    singular: "goal",
    fields: ["business", "project_id", "metric", "target", "currency", "period_start", "period_end"],
  },
  opportunities: {
    table: "opportunities",
    singular: "opportunity",
    fields: ["business", "project_id", "goal_id", "title", "description", ...SCORE_FIELDS, "budget", "status"],
  },
  schedules: {
    table: "schedules",
    singular: "schedule",
    fields: [
      "business",
      "project_id",
      "department_id",
      "title",
      "description",
      "kind",
      "interval_minutes",
      "next_run_at",
      "enabled",
    ],
  },
} as const;
type Resource = keyof typeof RESOURCES;

function fail(message: string): never {
  throw new Error(message);
}
function boundedText(value: unknown, field: string, max: number, optional = false): string {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) return fail(`invalid_${field}`);
  return value.trim();
}
function numeric(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    return fail(`invalid_${field}`);
  return value;
}
function validate(db: DatabaseSync, resource: Resource, row: Body): void {
  if (!isBusinessKey(row.business)) fail("invalid_business");
  const projectId = boundedText(row.project_id, "project_id", 128);
  row.project_id = projectId;
  const project = db.prepare("SELECT project_path FROM projects WHERE id=?").get(projectId) as
    | { project_path: string }
    | undefined;
  if (!project || !project.project_path?.trim() || !path.isAbsolute(project.project_path.trim()))
    fail("project_requires_absolute_path");
  if (resource === "goals") {
    const metric = boundedText(row.metric, "metric", 80);
    row.metric = metric;
    row.currency = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "USD";
    currencyMinorDigits(String(row.currency));
    if (!/^[a-z][a-z0-9_]*$/i.test(metric)) fail("invalid_metric");
    numeric(row.target, "target", 0, 1e12);
    numeric(row.period_start, "period_start", 0, Number.MAX_SAFE_INTEGER, true);
    numeric(row.period_end, "period_end", 0, Number.MAX_SAFE_INTEGER, true);
    if (Number(row.period_end) <= Number(row.period_start)) fail("invalid_goal_period");
    if (
      row.id &&
      db
        .prepare("SELECT 1 FROM opportunities WHERE goal_id=? AND (business!=? OR project_id!=?) LIMIT 1")
        .get(String(row.id), String(row.business), projectId)
    )
      fail("goal_has_linked_opportunities");
    return;
  }
  row.title = boundedText(row.title, "title", 200);
  row.description = boundedText(row.description, "description", 12000, true);
  if (resource === "opportunities") {
    for (const field of SCORE_FIELDS) numeric(row[field], field, 0, 100);
    numeric(row.budget, "budget", 0, 1e12);
    if (!["idea", "researching", "approved", "building", "launched", "stopped"].includes(String(row.status)))
      fail("invalid_status");
    if (row.goal_id !== null) {
      const goal = db
        .prepare("SELECT business,project_id FROM business_goals WHERE id=?")
        .get(boundedText(row.goal_id, "goal_id", 128)) as Body | undefined;
      if (!goal || goal.business !== row.business || goal.project_id !== projectId)
        fail("goal_business_or_project_mismatch");
    }
    return;
  }
  if (!["research", "lead_research"].includes(String(row.kind))) fail("invalid_schedule_kind");
  numeric(row.interval_minutes, "interval_minutes", 1, 525600, true);
  numeric(row.next_run_at, "next_run_at", 0, Number.MAX_SAFE_INTEGER, true);
  if (row.enabled === true) row.enabled = 1;
  if (row.enabled === false) row.enabled = 0;
  if (![0, 1].includes(Number(row.enabled)) || ![0, 1].includes(row.enabled as number)) fail("invalid_enabled");
  if (
    row.department_id !== null &&
    !db.prepare("SELECT 1 FROM departments WHERE id=?").get(boundedText(row.department_id, "department_id", 128))
  )
    fail("department_not_found");
}

function defaults(resource: Resource, now: number): Body {
  if (resource === "goals") return { currency: "USD" };
  if (resource === "opportunities")
    return {
      goal_id: null,
      description: "",
      demand_score: 0,
      revenue_score: 0,
      cost_score: 0,
      difficulty_score: 0,
      time_to_launch_score: 0,
      budget: 0,
      status: "idea",
    };
  return {
    department_id: null,
    description: "",
    kind: "research",
    interval_minutes: 1440,
    next_run_at: now + 86400000,
    enabled: 0,
  };
}

export function registerAutonomyRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureAutonomySchema(db);
  app.get("/api/autonomy", (_req, res) => res.json({ ok: true, ...autonomyOverview(db) }));
  app.get("/api/autonomy/digest", (req, res) => {
    const raw = req.query.after;
    const after = raw === undefined ? 0 : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isSafeInteger(after) || after < 0) return res.status(400).json({ error: "invalid_after" });
    const through = Date.now();
    const events = db
      .prepare("SELECT * FROM autonomy_ledger WHERE created_at>? AND created_at<=? ORDER BY id DESC LIMIT 200")
      .all(after, through);
    const grouped = db
      .prepare("SELECT event,COUNT(*) AS n FROM autonomy_ledger WHERE created_at>? AND created_at<=? GROUP BY event")
      .all(after, through) as { event: string; n: number }[];
    const counts = Object.fromEntries(grouped.map((row) => [row.event, row.n]));
    res.json({ ok: true, events, counts, total: grouped.reduce((sum, row) => sum + row.n, 0), through });
  });
  for (const resource of Object.keys(RESOURCES) as Resource[]) {
    const { table, singular, fields } = RESOURCES[resource];
    for (const isUpdate of [false, true]) {
      const method = isUpdate ? "patch" : "post";
      app[method](`/api/autonomy/${resource}${isUpdate ? "/:id" : ""}`, (req, res) => {
        if (!requireOwnerSession(req, res)) return;
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
          return res.status(400).json({ error: "invalid_payload" });
        const body = req.body as Body;
        if (Object.keys(body).some((key) => !(fields as readonly string[]).includes(key)))
          return res.status(400).json({ error: "unknown_field" });
        if (isUpdate && !Object.keys(body).length) return res.status(400).json({ error: "no_fields" });
        const id = isUpdate ? String((req.params as Record<string, string>).id) : randomUUID();
        const existing = isUpdate ? db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) : undefined;
        if (isUpdate && !existing) return res.status(404).json({ error: "not_found" });
        const now = Date.now();
        const row: Body = { ...defaults(resource, now), ...existing, ...body, id };
        if (
          !isUpdate &&
          resource === "schedules" &&
          body.next_run_at === undefined &&
          typeof row.interval_minutes === "number"
        )
          row.next_run_at = now + row.interval_minutes * 60000;
        try {
          validate(db, resource, row);
          db.exec("SAVEPOINT autonomy_owner_mutation");
          try {
            const values = fields.map((field) => (row[field] ?? null) as SQLInputValue);
            if (isUpdate)
              db.prepare(
                `UPDATE ${table} SET ${fields.map((field) => `${field}=?`).join(",")},updated_at=? WHERE id=?`,
              ).run(...values, now, id);
            else
              db.prepare(
                `INSERT INTO ${table}(id,${fields.join(",")},created_at,updated_at) VALUES (${Array(fields.length + 3)
                  .fill("?")
                  .join(",")})`,
              ).run(id, ...values, now, now);
            if (resource === "schedules" && isUpdate && Number(existing?.enabled) === 0 && row.enabled === 1) {
              db.prepare("UPDATE schedules SET consecutive_failures=0 WHERE id=?").run(id);
              appendAutonomyLedger(
                db,
                {
                  event: "schedule_resumed",
                  business: row.business as "tech" | "rental" | "ventures",
                  sourceId: id,
                  message: "Owner resumed the schedule and reset its consecutive failure count for an explicit retry.",
                },
                now,
              );
            }
            appendAutonomyLedger(
              db,
              {
                event: `${singular}_${isUpdate ? "updated" : "created"}`,
                business: row.business as "tech" | "rental" | "ventures",
                sourceId: id,
                message: `Owner ${isUpdate ? "updated" : "created"} ${singular}${row.title ? `: ${row.title}` : `: ${row.metric}`}.${resource === "opportunities" ? " Budget is a planning estimate, not spending authorization." : ""}`,
              },
              now,
            );
            db.exec("RELEASE autonomy_owner_mutation");
          } catch (error) {
            db.exec("ROLLBACK TO autonomy_owner_mutation; RELEASE autonomy_owner_mutation");
            throw error;
          }
          const item = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
          broadcast("autonomy_changed", { resource, id });
          res.status(isUpdate ? 200 : 201).json({ ok: true, item, [singular]: item });
        } catch (error) {
          res.status(400).json({ error: error instanceof Error ? error.message : "autonomy_mutation_failed" });
        }
      });
    }
  }
  app.patch("/api/autonomy/config", (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      return res.status(400).json({ error: "invalid_payload" });
    const fields = ["daily_start_cap", "usage_threshold", "failure_limit", "planning_interval_minutes"];
    if (Object.keys(body).some((key) => !fields.includes(key))) return res.status(400).json({ error: "unknown_field" });
    if (!Object.keys(body).length) return res.status(400).json({ error: "no_fields" });
    try {
      const next = { ...autonomyConfig(db), ...body };
      numeric(next.daily_start_cap, "daily_start_cap", 0, 100, true);
      numeric(next.usage_threshold, "usage_threshold", 0, 1);
      numeric(next.failure_limit, "failure_limit", 1, 20, true);
      numeric(next.planning_interval_minutes, "planning_interval_minutes", 1, 10080, true);
      db.exec("SAVEPOINT autonomy_config_mutation");
      try {
        db.prepare(`UPDATE autonomy_config SET ${fields.map((field) => `${field}=?`).join(",")} WHERE id=1`).run(
          ...fields.map((field) => next[field]),
        );
        appendAutonomyLedger(db, {
          event: "config_updated",
          message: "Owner updated autonomous start limits and planning cadence.",
        });
        db.exec("RELEASE autonomy_config_mutation");
      } catch (error) {
        db.exec("ROLLBACK TO autonomy_config_mutation; RELEASE autonomy_config_mutation");
        throw error;
      }
      broadcast("autonomy_changed", { resource: "config" });
      res.json({ ok: true, config: autonomyConfig(db) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "invalid_config" });
    }
  });
}
