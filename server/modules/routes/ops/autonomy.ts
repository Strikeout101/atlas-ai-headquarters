import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Express } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { INITIATIVE_STATUSES } from "../../bootstrap/schema/work-model-migration.ts";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import { appendAutonomyLedger, autonomyConfig, autonomyOverview, ensureAutonomySchema } from "../../autonomy-store.ts";
import { isBusinessKey } from "../../businesses.ts";
import { currencyMinorDigits } from "../../finance-store.ts";
import { experimentRules, restartInitiative, saveExperimentRules } from "../../experiments.ts";
import { ensurePlaybookSchema, getPlaybook, listPlaybooks, resetPlaybook, savePlaybook } from "../../playbooks.ts";
import { nextCronRun, validTimeZone } from "../../schedule-time.ts";
import { addMilestone, deleteMilestone, listMilestones, setMilestoneDone } from "../../goal-milestones.ts";
import { streamOverview } from "../../streams.ts";
import { decideStrategy, ensureGoalStrategySchema, latestStrategies } from "../../goal-strategy.ts";
import { approveInitiative, resolveEscalation, type EscalationAction } from "../../work-engine.ts";

type Body = Record<string, unknown>;
const SCORE_FIELDS = ["demand_score", "revenue_score", "cost_score", "difficulty_score", "time_to_launch_score"];
const RESOURCES = {
  goals: {
    table: "business_goals",
    singular: "goal",
    fields: ["business", "project_id", "metric", "target", "currency", "period_start", "period_end"],
  },
  initiatives: {
    table: "initiatives",
    singular: "initiative",
    fields: [
      "business",
      "project_id",
      "goal_id",
      "title",
      "description",
      ...SCORE_FIELDS,
      "budget",
      "status",
      "task_limit",
      "time_limit_days",
    ],
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
      "playbook",
      "cron",
      "timezone",
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
        .prepare("SELECT 1 FROM initiatives WHERE goal_id=? AND (business!=? OR project_id!=?) LIMIT 1")
        .get(String(row.id), String(row.business), projectId)
    )
      fail("goal_has_linked_initiatives");
    return;
  }
  row.title = boundedText(row.title, "title", 200);
  row.description = boundedText(row.description, "description", 12000, true);
  if (resource === "initiatives") {
    for (const field of SCORE_FIELDS) numeric(row[field], field, 0, 100);
    numeric(row.budget, "budget", 0, 1e12);
    numeric(row.task_limit, "task_limit", 1, 200, true);
    numeric(row.time_limit_days, "time_limit_days", 1, 365, true);
    if (!(INITIATIVE_STATUSES as readonly string[]).includes(String(row.status))) fail("invalid_status");
    if (row.goal_id === null || row.goal_id === undefined) fail("initiative_needs_goal");
    {
      const goal = db
        .prepare("SELECT business,project_id FROM business_goals WHERE id=?")
        .get(boundedText(row.goal_id, "goal_id", 128)) as Body | undefined;
      if (!goal || goal.business !== row.business || goal.project_id !== projectId)
        fail("goal_business_or_project_mismatch");
    }
    return;
  }
  if (!["research", "lead_research"].includes(String(row.kind))) fail("invalid_schedule_kind");
  // Time-of-day rule: validated exactly (no guessing); its next run replaces the interval's.
  if (typeof row.cron === "string" && row.cron.trim()) {
    row.cron = row.cron.trim().replace(/s+/g, " ");
    row.timezone = typeof row.timezone === "string" && row.timezone.trim() ? row.timezone.trim() : "America/New_York";
    if (!validTimeZone(row.timezone)) fail("invalid_schedule_timezone");
    row.next_run_at = nextCronRun(String(row.cron), String(row.timezone), Date.now());
  } else {
    row.cron = null;
    row.timezone = null;
  }
  if (row.playbook !== null && row.playbook !== undefined && row.playbook !== "") {
    if (typeof row.playbook !== "string" || !getPlaybook(db, row.playbook)) fail("playbook_not_found");
  } else row.playbook = null;
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
  if (resource === "initiatives")
    return {
      goal_id: null,
      description: "",
      demand_score: 0,
      revenue_score: 0,
      cost_score: 0,
      difficulty_score: 0,
      time_to_launch_score: 0,
      budget: 0,
      status: "proposed",
      task_limit: 10,
      time_limit_days: 30,
    };
  return {
    department_id: null,
    description: "",
    kind: "research",
    interval_minutes: 1440,
    next_run_at: now + 86400000,
    enabled: 0,
    playbook: null,
    cron: null,
    timezone: null,
  };
}

export function registerAutonomyRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureAutonomySchema(db);
  ensurePlaybookSchema(db);
  ensureGoalStrategySchema(db);
  app.get("/api/autonomy", (_req, res) =>
    res.json({
      ok: true,
      ...autonomyOverview(db),
      experiment_rules: experimentRules(db),
      playbooks: listPlaybooks(db),
      milestones: listMilestones(db),
      strategies: latestStrategies(db),
    }),
  );
  const ownerJson =
    (handler: (req: import("express").Request) => unknown) =>
    (req: import("express").Request, res: import("express").Response) => {
      if (!requireOwnerSession(req, res)) return;
      if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
        return res.status(403).json({ error: "csrf_token_required" });
      try {
        const result = handler(req);
        broadcast("autonomy_changed", { resource: "experiments" });
        res.json({ ok: true, ...(result as object) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "autonomy_request_failed";
        res.status(message.endsWith("_not_found") ? 404 : 400).json({ error: message });
      }
    };
  const bodyOf = (req: import("express").Request): Body =>
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Body) : {};
  // Experiments: the owner's stop rules, and bringing a stopped initiative back.
  app.patch(
    "/api/autonomy/experiment-rules",
    ownerJson((req) => ({ rules: saveExperimentRules(db, bodyOf(req)) })),
  );
  app.post(
    "/api/autonomy/initiatives/:id/restart",
    ownerJson((req) => ({ item: restartInitiative(db, String(req.params.id)) })),
  );
  // The owner's calls in the goal flow (plan section 12b): the strategy, which ideas to build, and stuck steps.
  app.post(
    "/api/autonomy/strategies/:id/decision",
    ownerJson((req) => ({ item: decideStrategy(db, String(req.params.id), bodyOf(req)) })),
  );
  app.post(
    "/api/autonomy/initiatives/:id/approve",
    ownerJson((req) => ({ item: approveInitiative(db, String(req.params.id)) })),
  );
  app.post(
    "/api/autonomy/initiatives/:id/unblock",
    ownerJson((req) => {
      const body = bodyOf(req);
      return {
        item: resolveEscalation(
          db,
          String(req.params.id),
          {
            action: String(body.action) as EscalationAction,
            notes: typeof body.notes === "string" ? body.notes : undefined,
            agent_id: typeof body.agent_id === "string" ? body.agent_id : null,
          },
          "owner",
        ),
      };
    }),
  );
  // One income stream (business) on one page.
  app.get("/api/streams", (req, res) => {
    try {
      res.json({ ok: true, ...streamOverview(db, req.query.business) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "stream_read_failed" });
    }
  });
  // Goal milestones: progress ones complete from verified data, manual ones only when the owner confirms.
  app.post(
    "/api/autonomy/goals/:id/milestones",
    ownerJson((req) => ({ item: addMilestone(db, String(req.params.id), bodyOf(req)) })),
  );
  app.post(
    "/api/autonomy/milestones/:id/done",
    ownerJson((req) => ({ item: setMilestoneDone(db, String(req.params.id), bodyOf(req).done) })),
  );
  app.post(
    "/api/autonomy/milestones/:id/delete",
    ownerJson((req) => {
      deleteMilestone(db, String(req.params.id));
      return { id: req.params.id };
    }),
  );
  // Playbooks: view, edit, reset to the default, and add the research schedule (created switched off).
  app.put(
    "/api/autonomy/playbooks/:key",
    ownerJson((req) => ({ playbook: savePlaybook(db, String(req.params.key), bodyOf(req)) })),
  );
  app.post(
    "/api/autonomy/playbooks/:key/reset",
    ownerJson((req) => ({ playbook: resetPlaybook(db, String(req.params.key)) })),
  );
  app.post(
    "/api/autonomy/playbooks/:key/research-schedule",
    ownerJson((req) => {
      const playbook = getPlaybook(db, String(req.params.key));
      if (!playbook) throw new Error("playbook_not_found");
      const body = bodyOf(req);
      const now = Date.now();
      const interval =
        typeof body.interval_minutes === "number" && Number.isSafeInteger(body.interval_minutes)
          ? body.interval_minutes
          : 10080;
      const row: Body = {
        business: playbook.business,
        project_id: body.project_id,
        department_id: playbook.research.department_id,
        title: playbook.research.title,
        description: playbook.research.instructions,
        kind: "research",
        interval_minutes: interval,
        next_run_at: now + interval * 60000,
        enabled: 0,
        playbook: playbook.key,
      };
      validate(db, "schedules", row);
      const id = randomUUID();
      const fields = RESOURCES.schedules.fields;
      db.prepare(
        `INSERT INTO schedules(id,${fields.join(",")},created_at,updated_at) VALUES (${Array(fields.length + 3)
          .fill("?")
          .join(",")})`,
      ).run(id, ...fields.map((field) => (row[field] ?? null) as SQLInputValue), now, now);
      appendAutonomyLedger(db, {
        event: "schedule_created",
        business: playbook.business,
        sourceId: id,
        message: `Owner added the "${playbook.title}" research schedule (off until switched on).`,
      });
      return { item: db.prepare("SELECT * FROM schedules WHERE id=?").get(id) };
    }),
  );
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
        // Approving an idea runs the VPs' plan check (playbook, caps); the status changes only through it.
        const approving =
          resource === "initiatives" && row.status === "approved" && (existing?.status ?? "proposed") === "proposed";
        if (approving) row.status = "proposed";
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
                message: `Owner ${isUpdate ? "updated" : "created"} ${singular}${row.title ? `: ${row.title}` : `: ${row.metric}`}.${resource === "initiatives" ? " Budget is a planning estimate, not spending authorization." : ""}`,
              },
              now,
            );
            if (approving) approveInitiative(db, id, "owner", now);
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
    const fields = [
      "daily_start_cap",
      "local_provider_daily_run_cap",
      "usage_threshold",
      "failure_limit",
      "planning_interval_minutes",
    ];
    if (Object.keys(body).some((key) => !fields.includes(key))) return res.status(400).json({ error: "unknown_field" });
    if (!Object.keys(body).length) return res.status(400).json({ error: "no_fields" });
    try {
      const next = { ...autonomyConfig(db), ...body };
      numeric(next.daily_start_cap, "daily_start_cap", 0, 100, true);
      numeric(next.local_provider_daily_run_cap, "local_provider_daily_run_cap", 0, 1000, true);
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
