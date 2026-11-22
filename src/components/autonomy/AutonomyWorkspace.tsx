import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  getAutonomy,
  saveAutonomy,
  saveAutonomyConfig,
  restartInitiative,
  saveExperimentRules,
  type AutonomyOverview,
  type AutonomyResource,
  type AutonomyConfig,
} from "../../api/autonomy";
import { getProjects } from "../../api/organization-projects";
import { isApiRequestError } from "../../api/core";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import type { Department, Project } from "../../types";
import { useI18n } from "../../i18n";
import { currencyDigits, parseMoney } from "../revenue/money";
import PlaybooksPanel from "./PlaybooksPanel";
import GoalMilestones from "./GoalMilestones";

const inputClass = "mt-1 min-h-[40px] w-full min-w-0 rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};
const scoreFields = [
  "demand_score",
  "revenue_score",
  "cost_score",
  "difficulty_score",
  "time_to_launch_score",
] as const;
const statuses = [
  "proposed",
  "approved",
  "in_progress",
  "blocked",
  "launched",
  "measuring",
  "stopped",
  "done",
] as const;
const pretty = (value: string) => value.replaceAll("_", " ");
const localDate = (value: unknown) => {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime())
    ? ""
    : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col text-xs font-medium">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}

export default function AutonomyWorkspace({ departments }: { departments: Department[] }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<AutonomyOverview | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [resource, setResource] = useState<AutonomyResource>("goals");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [preset, setPreset] = useState(false);
  const [business, setBusiness] = useState<BusinessKind>("ventures");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const message = useCallback(
    (cause: unknown) => {
      if (isApiRequestError(cause)) {
        if (cause.code === "owner_session_required")
          return t({
            en: "Sign in with your password in Settings > Security to make changes.",
          });
        if (cause.code === "invalid_goal_period")
          return t({
            en: "The goal must end after its start date.",
          });
        if (cause.code === "project_requires_absolute_path")
          return t({
            en: "Choose a project with a saved absolute workspace path.",
          });
        if (cause.code === "goal_has_linked_initiatives")
          return t({
            en: "This goal has linked initiatives. Keep its business and project or update those links first.",
          });
        if (cause.code) return pretty(cause.code);
      }
      return cause instanceof Error ? cause.message : String(cause);
    },
    [t],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [overview, first] = await Promise.all([getAutonomy(), getProjects({ page: 1, page_size: 100 })]);
        const allProjects = [...first.projects];
        for (let page = 2; page <= first.total_pages; page++)
          allProjects.push(...(await getProjects({ page, page_size: 100 })).projects);
        if (!signal?.aborted) {
          setData(overview);
          setProjects(allProjects);
          setError(null);
        }
      } catch (cause) {
        if (!signal?.aborted) setError(message(cause));
      }
    },
    [message],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setFormOpen(false);
      setEditing(null);
      setNotice(t({ en: "Saved." }));
      await refresh();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const row: Record<string, unknown> = Object.fromEntries(form.entries());
    if (resource === "goals") {
      if (["verified_revenue", "revenue", "verified_profit", "profit"].includes(String(row.metric))) {
        try {
          row.target =
            parseMoney(String(row.target), String(row.currency)) / 10 ** currencyDigits(String(row.currency));
        } catch (cause) {
          setError(message(cause));
          return;
        }
      } else row.target = Number(row.target);
      row.period_start = new Date(String(row.period_start)).getTime();
      row.period_end = new Date(String(row.period_end)).getTime();
    }
    if (resource === "initiatives") {
      for (const key of [...scoreFields, "budget", "task_limit", "time_limit_days"]) row[key] = Number(row[key]);
      row.goal_id = row.goal_id || null;
    }
    if (resource === "schedules") {
      row.interval_minutes = Number(row.interval_minutes);
      row.next_run_at = new Date(String(row.next_run_at)).getTime();
      // Time of day: an advanced cron rule wins; otherwise days + time build one; otherwise the interval is used.
      const advanced = String(row.cron_advanced ?? "").trim();
      const days = String(row.tod_days ?? "");
      const time = String(row.tod_time ?? "");
      if (advanced) row.cron = advanced;
      else if (days && /^\d{2}:\d{2}$/.test(time)) {
        const [hour, minute] = time.split(":").map(Number);
        row.cron = `${minute} ${hour} * * ${days}`;
      } else row.cron = "";
      row.timezone = String(row.timezone ?? "").trim() || "America/New_York";
      delete row.cron_advanced;
      delete row.tod_days;
      delete row.tod_time;
      row.enabled = form.get("enabled") === "on";
      row.department_id = row.department_id || null;
    }
    await mutate(() => saveAutonomy(resource, row, editing?.id as string | undefined));
  }
  const label = (tab: AutonomyResource) =>
    ({
      goals: t({ en: "Goals" }),
      initiatives: t({ en: "Initiatives" }),
      schedules: t({ en: "Schedules" }),
    })[tab];
  const edit = (row: object | null = null, leadPreset = false) => {
    const values = row as Record<string, unknown> | null;
    setEditing(values ? { ...values } : null);
    setBusiness((values?.business as BusinessKind) ?? (leadPreset ? "tech" : "ventures"));
    setProjectId(String(values?.project_id ?? ""));
    setPreset(leadPreset);
    setFormOpen(true);
    setNotice(null);
  };
  const textField = (
    name: string,
    title: string,
    defaultValue: unknown = "",
    type = "text",
    extra: Record<string, unknown> = {},
  ) => (
    <Field label={title}>
      <input
        name={name}
        type={type}
        required
        defaultValue={String(editing?.[name] ?? defaultValue)}
        className={inputClass}
        style={inputStyle}
        {...extra}
      />
    </Field>
  );
  return (
    <section className="autonomy-workspace mx-auto w-full max-w-7xl space-y-6 pb-8" aria-label="Autonomy">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t({ en: "Autonomy" })}</h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Set goals, review initiatives and schedule research. Customer-facing work and spending keep their approval rules.",
            })}
          </p>
        </div>
        <button type="button" className="ax-btn-secondary" onClick={() => void refresh()} disabled={busy}>
          {t({ en: "Refresh" })}
        </button>
      </header>
      {error && (
        <p role="alert" className="break-words text-sm" style={{ color: "var(--th-danger-border)" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">
          {error
            ? t({
                en: "Refresh to try again.",
              })
            : t({ en: "Loading autonomy…" })}
        </p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Autonomy sections"
            className="flex flex-wrap gap-2 border-b pb-3"
            style={{ borderColor: "var(--th-border)" }}
          >
            {(["goals", "initiatives", "schedules"] as const).map((tab) => (
              <button
                key={tab}
                id={`autonomy-tab-${tab}`}
                role="tab"
                aria-selected={resource === tab}
                aria-controls="autonomy-panel"
                className={resource === tab ? "ax-btn-primary" : "ax-btn-secondary"}
                onClick={() => {
                  setResource(tab);
                  setFormOpen(false);
                  setEditing(null);
                }}
              >
                {label(tab)} <span className="ml-1 text-xs">{data[tab].length}</span>
              </button>
            ))}
          </div>
          <div role="tabpanel" id="autonomy-panel" aria-labelledby={`autonomy-tab-${resource}`} className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{label(resource)}</h2>
              <div className="flex flex-wrap gap-2">
                {resource === "schedules" && (
                  <button type="button" className="ax-btn-secondary" onClick={() => edit(null, true)}>
                    {t({
                      en: "Lead research preset",
                    })}
                  </button>
                )}
                <button type="button" className="ax-btn-primary" onClick={() => edit()}>
                  {t({ en: "Add" })} {label(resource).toLowerCase()}
                </button>
              </div>
            </div>
            {formOpen && (
              <form
                key={`${resource}:${editing?.id ?? "new"}:${preset}`}
                onSubmit={submit}
                className="space-y-4 rounded-xl border p-4 sm:p-5"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                aria-label={`${editing ? "Edit" : "Add"} ${resource}`}
              >
                {!projects.length && (
                  <p className="text-sm">
                    {t({
                      en: "Create a project with an absolute path in Work before adding autonomous work.",
                    })}
                  </p>
                )}
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <Field label={t({ en: "Business" })}>
                    <select
                      name="business"
                      required
                      value={business}
                      onChange={(event) => setBusiness(event.target.value as BusinessKind)}
                      className={inputClass}
                      style={inputStyle}
                    >
                      {BUSINESS_KINDS.filter((business) => !preset || business !== "ventures").map((business) => (
                        <option key={business} value={business}>
                          {BUSINESS_NAMES[business]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t({ en: "Project" })}>
                    <select
                      name="project_id"
                      required
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                      className={inputClass}
                      style={inputStyle}
                    >
                      <option value="">{t({ en: "Choose a project" })}</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name} — {project.project_path}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {resource === "goals" && (
                    <>
                      <Field label={t({ en: "Metric" })}>
                        <select
                          name="metric"
                          defaultValue={String(editing?.metric ?? "completed_tasks")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          {["completed_tasks", "contacts", "drafts", "verified_revenue"].map((metric) => (
                            <option key={metric} value={metric}>
                              {pretty(metric)}
                            </option>
                          ))}
                          {Boolean(editing?.metric) &&
                            !["completed_tasks", "contacts", "drafts", "verified_revenue"].includes(
                              String(editing?.metric),
                            ) && <option value={String(editing?.metric)}>{pretty(String(editing?.metric))}</option>}
                        </select>
                      </Field>
                      <Field
                        label={t({
                          en: "Currency (financial goals)",
                        })}
                      >
                        <select
                          name="currency"
                          defaultValue={String(editing?.currency ?? "USD")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          {[
                            ...new Set([
                              "USD",
                              "CAD",
                              "EUR",
                              "GBP",
                              "AUD",
                              "JPY",
                              "KWD",
                              String(editing?.currency ?? "USD"),
                            ]),
                          ].map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {textField("target", t({ en: "Target" }), 1, "number", { min: 0, step: "any" })}
                      {textField("period_start", t({ en: "Period starts" }), localDate(Date.now()), "datetime-local", {
                        defaultValue: localDate(editing?.period_start ?? Date.now()),
                      })}
                      {textField(
                        "period_end",
                        t({ en: "Period ends" }),
                        localDate(Date.now() + 30 * 86400000),
                        "datetime-local",
                        { defaultValue: localDate(editing?.period_end ?? Date.now() + 30 * 86400000) },
                      )}
                    </>
                  )}
                  {resource !== "goals" && (
                    <>
                      {textField("title", t({ en: "Title" }), preset ? "Research local leads" : "", "text", {
                        maxLength: 200,
                      })}
                      <Field label={t({ en: "Description" })}>
                        <textarea
                          name="description"
                          required
                          rows={3}
                          defaultValue={String(
                            editing?.description ??
                              (preset
                                ? "Research suitable local prospects. Save qualified contacts and prepare email drafts for owner review. Do not send messages or publish content. Preparation only; use existing accounts and the business approval gateways."
                                : ""),
                          )}
                          className={inputClass}
                          style={inputStyle}
                        />
                      </Field>
                    </>
                  )}
                  {resource === "initiatives" && (
                    <>
                      {/* Every initiative belongs to a goal (work restructure), so there is no "None". */}
                      <Field label={t({ en: "Goal" })}>
                        <select
                          name="goal_id"
                          required
                          defaultValue={String(editing?.goal_id ?? "")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          {data.goals
                            .filter((goal) => goal.business === business && goal.project_id === projectId)
                            .map((goal) => (
                              <option key={goal.id} value={goal.id}>
                                {goal.title ? `${goal.title} · ` : ""}
                                {BUSINESS_NAMES[goal.business]} · {pretty(goal.metric)} · {goal.target}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label={t({ en: "Status" })}>
                        <select
                          name="status"
                          defaultValue={String(editing?.status ?? "proposed")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          {statuses.map((status) => (
                            <option key={status} value={status}>
                              {pretty(status)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {scoreFields.map((key) => (
                        <div key={key}>{textField(key, pretty(key), 0, "number", { min: 0, max: 100, step: 1 })}</div>
                      ))}
                      {textField("budget", t({ en: "Budget (USD)" }), 0, "number", { min: 0, step: "any" })}
                      {textField("task_limit", t({ en: "Task limit without a sale" }), 10, "number", {
                        min: 1,
                        max: 200,
                        step: 1,
                      })}
                      {textField("time_limit_days", t({ en: "Days live without a sale" }), 30, "number", {
                        min: 1,
                        max: 365,
                        step: 1,
                      })}
                    </>
                  )}
                  {resource === "schedules" && (
                    <>
                      <Field label={t({ en: "Research type" })}>
                        <select
                          name="kind"
                          defaultValue={String(editing?.kind ?? (preset ? "lead_research" : "research"))}
                          className={inputClass}
                          style={inputStyle}
                        >
                          <option value="research">Research</option>
                          <option value="lead_research">Lead research: contacts and drafts</option>
                        </select>
                      </Field>
                      <Field label={t({ en: "Department" })}>
                        <select
                          name="department_id"
                          defaultValue={String(editing?.department_id ?? "")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          <option value="">Planning</option>
                          {departments.map((department) => (
                            <option key={department.id} value={department.id}>
                              {department.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {textField("interval_minutes", t({ en: "Interval (minutes)" }), 1440, "number", {
                        min: 1,
                        max: 525600,
                        step: 1,
                      })}
                      {textField(
                        "next_run_at",
                        t({ en: "Next run" }),
                        localDate(Date.now() + 86400000),
                        "datetime-local",
                        { defaultValue: localDate(editing?.next_run_at ?? Date.now() + 86400000) },
                      )}
                      {(() => {
                        const cron = typeof editing?.cron === "string" ? editing.cron : "";
                        const simple = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|[0-6])$/);
                        return (
                          <fieldset
                            className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-3"
                            style={{ borderColor: "var(--th-border)" }}
                          >
                            <legend className="px-1 text-xs font-semibold">
                              {t({ en: "Time of day (optional; replaces the interval)" })}
                            </legend>
                            <Field label={t({ en: "Days" })}>
                              <select
                                name="tod_days"
                                defaultValue={simple ? simple[3] : ""}
                                className={inputClass}
                                style={inputStyle}
                              >
                                <option value="">Use the interval</option>
                                <option value="*">Every day</option>
                                <option value="1-5">Weekdays</option>
                                <option value="0,6">Weekends</option>
                                <option value="1">Mondays</option>
                                <option value="2">Tuesdays</option>
                                <option value="3">Wednesdays</option>
                                <option value="4">Thursdays</option>
                                <option value="5">Fridays</option>
                                <option value="6">Saturdays</option>
                                <option value="0">Sundays</option>
                              </select>
                            </Field>
                            <Field label={t({ en: "Time" })}>
                              <input
                                name="tod_time"
                                type="time"
                                defaultValue={
                                  simple ? `${simple[2].padStart(2, "0")}:${simple[1].padStart(2, "0")}` : "09:00"
                                }
                                className={inputClass}
                                style={inputStyle}
                              />
                            </Field>
                            <Field label={t({ en: "Time zone" })}>
                              <input
                                name="timezone"
                                defaultValue={
                                  typeof editing?.timezone === "string" && editing.timezone
                                    ? editing.timezone
                                    : "America/New_York"
                                }
                                className={inputClass}
                                style={inputStyle}
                              />
                            </Field>
                            <div className="sm:col-span-3">
                              <Field
                                label={t({ en: "Or a cron rule (minute hour day month weekday), e.g. 0 9 1 * *" })}
                              >
                                <input
                                  name="cron_advanced"
                                  defaultValue={cron && !simple ? cron : ""}
                                  className={inputClass}
                                  style={inputStyle}
                                />
                              </Field>
                            </div>
                          </fieldset>
                        );
                      })()}
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="enabled" defaultChecked={Boolean(editing?.enabled)} />
                        {t({ en: "Enable schedule" })}
                      </label>
                    </>
                  )}
                </div>
                {resource === "initiatives" && (
                  <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {t({
                      en: "Scores run from 0–100. An initiative that uses its budget, its task limit or its days live without a sale is stopped by the stop rules (below). Spending still needs approval.",
                    })}
                  </p>
                )}
                <div className="flex gap-2">
                  <button type="submit" className="ax-btn-primary" disabled={busy || !projects.length}>
                    {t({ en: "Save" })}
                  </button>
                  <button type="button" className="ax-btn-secondary" onClick={() => setFormOpen(false)} disabled={busy}>
                    {t({ en: "Cancel" })}
                  </button>
                </div>
              </form>
            )}
            {!data[resource].length ? (
              <p className="py-8 text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  en: "Nothing here yet. Add an item to guide autonomous work.",
                })}
              </p>
            ) : (
              <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                {data[resource].map((row) => (
                  <li key={row.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">
                        {"metric" in row
                          ? `${row.title ? `${row.title} · ` : ""}${pretty(row.metric)} · ${row.progress === null ? t({ en: "Not measured yet" }) : `${row.progress} / ${row.target}`}`
                          : row.title}
                      </p>
                      <p className="mt-1 break-words text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {BUSINESS_NAMES[row.business]}
                        {"metric" in row &&
                        ["verified_revenue", "revenue", "profit", "verified_profit"].includes(row.metric)
                          ? ` · ${row.currency ?? "USD"}`
                          : ""}{" "}
                        · {projects.find((project) => project.id === row.project_id)?.name ?? row.project_id}
                        {"status" in row && row.status ? ` · ${row.status}` : ""}
                        {"enabled" in row
                          ? ` · ${row.enabled ? "Enabled" : "Paused"} · ${row.cron ? `${row.cron} (${row.timezone ?? "America/New_York"})` : `every ${row.interval_minutes} min`} · ${row.consecutive_failures} failures · next ${new Date(row.next_run_at).toLocaleString(locale)}`
                          : ""}
                      </p>
                      {"metric" in row && (
                        <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                          {new Date(row.period_start).toLocaleDateString(locale)} –{" "}
                          {new Date(row.period_end).toLocaleDateString(locale)}
                          {row.progress_scope === "business" ? ` · ${t({ en: "Business-wide records" })}` : ""}
                        </p>
                      )}
                      {"metric" in row &&
                        (() => {
                          const strategy = (data.strategies ?? []).find((item) => item.goal_id === row.id);
                          return strategy ? (
                            <details className="mt-2 text-xs">
                              <summary className="cursor-pointer">
                                {t({ en: "Strategy" })} · {new Date(strategy.created_at).toLocaleDateString(locale)}
                              </summary>
                              <p
                                className="mt-1 whitespace-pre-wrap break-words"
                                style={{ color: "var(--th-text-muted)" }}
                              >
                                {strategy.summary}
                              </p>
                            </details>
                          ) : (
                            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                              {t({
                                en: "No strategy yet: agents research one for this goal while ATLAS is running.",
                              })}
                            </p>
                          );
                        })()}
                      {"metric" in row && (
                        <GoalMilestones
                          goalId={row.id}
                          milestones={(data.milestones ?? []).filter((m) => m.goal_id === row.id)}
                          busy={busy}
                          mutate={mutate}
                        />
                      )}
                      {"demand_score" in row && (row.playbook_stage || row.stop_reason) && (
                        <p className="mt-2 break-words text-xs">
                          {row.playbook_stage ? `Playbook step: ${pretty(row.playbook_stage)}` : ""}
                          {row.playbook_stage && row.stop_reason ? " · " : ""}
                          {row.stop_reason ? <span className="text-amber-600">Stopped: {row.stop_reason}</span> : null}
                        </p>
                      )}
                      {"demand_score" in row && (
                        <p className="mt-2 break-words text-xs" style={{ color: "var(--th-text-muted)" }}>
                          {scoreFields.map((key) => `${pretty(key)}: ${row[key]}`).join(" · ")}
                        </p>
                      )}
                      {"description" in row && (
                        <p
                          className="mt-2 whitespace-pre-wrap break-words text-sm"
                          style={{ color: "var(--th-text-secondary)" }}
                        >
                          {row.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {"enabled" in row && (
                        <button
                          type="button"
                          className="ax-btn-secondary"
                          disabled={busy}
                          onClick={() =>
                            void mutate(() => saveAutonomy("schedules", { enabled: !row.enabled }, row.id))
                          }
                        >
                          {row.enabled ? t({ en: "Pause" }) : t({ en: "Enable" })}
                        </button>
                      )}
                      {"demand_score" in row && row.status === "stopped" && (
                        <button
                          type="button"
                          className="ax-btn-secondary"
                          disabled={busy}
                          onClick={() => void mutate(() => restartInitiative(row.id))}
                        >
                          {t({ en: "Restart" })}
                        </button>
                      )}
                      <button type="button" className="ax-btn-secondary" onClick={() => edit(row)}>
                        {t({ en: "Edit" })}
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
            <summary className="cursor-pointer text-sm font-semibold">{t({ en: "Operating limits" })}</summary>
            <form
              className="mt-4 space-y-4"
              key={JSON.stringify(data.config)}
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                const config = Object.fromEntries(
                  [...values].map(([key, value]) => [key, Number(value)]),
                ) as unknown as AutonomyConfig;
                void mutate(() => saveAutonomyConfig(config));
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["daily_start_cap", "Daily autonomous starts", 0, 100, 1],
                    ["local_provider_daily_run_cap", "Daily local provider invocations (per host)", 0, 1000, 1],
                    ["usage_threshold", "Subscription usage ceiling (0–1)", 0, 1, 0.01],
                    ["failure_limit", "Pause schedule after failures", 1, 20, 1],
                    ["planning_interval_minutes", "Planning interval (minutes)", 1, 10080, 1],
                  ] as const
                ).map(([key, title, min, max, step]) => (
                  <Field key={key} label={title}>
                    <input
                      name={key}
                      type="number"
                      required
                      min={min}
                      max={max}
                      step={step}
                      defaultValue={data.config[key] ?? (key === "local_provider_daily_run_cap" ? 20 : undefined)}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </Field>
                ))}
              </div>
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  en: "Local invocations include retries, resumes and task meetings; one worker invocation may use several model turns. Autonomous paid API calls remain blocked until an enforceable provider budget is available. Emergency controls remain available on every page.",
                })}
              </p>
              <button type="submit" className="ax-btn-secondary" disabled={busy}>
                {t({ en: "Save limits" })}
              </button>
            </form>
          </details>
          {data.experiment_rules && (
            <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
              <summary className="cursor-pointer text-sm font-semibold">{t({ en: "Stop rules" })}</summary>
              <form
                aria-label="Stop rules"
                className="mt-4 space-y-4"
                key={JSON.stringify(data.experiment_rules)}
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void mutate(() =>
                    saveExperimentRules({
                      enabled: values.get("enabled") === "on",
                      stop_when_budget_spent_without_revenue: values.get("budget_rule") === "on",
                      no_sale_days_after_launch: Number(values.get("no_sale_days_after_launch")),
                      max_tasks_without_revenue: Number(values.get("max_tasks_without_revenue")),
                    }),
                  );
                }}
              >
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="enabled" defaultChecked={data.experiment_rules.enabled} />
                  {t({ en: "Stop initiatives automatically" })}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="budget_rule"
                    defaultChecked={data.experiment_rules.stop_when_budget_spent_without_revenue}
                  />
                  {t({ en: "Stop when the budget is used with no sale" })}
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t({ en: "Stop after this many days live with no sale" })}>
                    <input
                      name="no_sale_days_after_launch"
                      type="number"
                      min={1}
                      max={365}
                      required
                      defaultValue={data.experiment_rules.no_sale_days_after_launch}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </Field>
                  <Field label={t({ en: "Stop after this many tasks with no sale" })}>
                    <input
                      name="max_tasks_without_revenue"
                      type="number"
                      min={1}
                      max={200}
                      required
                      defaultValue={data.experiment_rules.max_tasks_without_revenue}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </Field>
                </div>
                <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {t({
                    en: "An initiative that has sold anything is never stopped by these rules. Each initiative's own limits apply too (the lower one wins). Stopped initiatives can be restarted with a fresh window.",
                  })}
                </p>
                <button type="submit" className="ax-btn-secondary" disabled={busy}>
                  {t({ en: "Save stop rules" })}
                </button>
              </form>
            </details>
          )}
          {data.playbooks && data.playbooks.length > 0 && (
            <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
              <summary className="cursor-pointer text-sm font-semibold">{t({ en: "Playbooks" })}</summary>
              <PlaybooksPanel
                playbooks={data.playbooks}
                departments={departments}
                projects={projects}
                busy={busy}
                mutate={mutate}
              />
            </details>
          )}
          <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
            <summary className="cursor-pointer text-sm font-semibold">{t({ en: "Activity log" })}</summary>
            {!data.ledger.length ? (
              <p className="py-4 text-sm">
                {t({
                  en: "No autonomous activity yet.",
                })}
              </p>
            ) : (
              <ol className="mt-3 divide-y">
                {data.ledger.map((event) => (
                  <li key={event.id} className="py-3 text-sm">
                    <p className="break-words">{event.message}</p>
                    <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                      {pretty(event.event)} · {new Date(event.created_at).toLocaleString(locale)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}
