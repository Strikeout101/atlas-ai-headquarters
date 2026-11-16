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
  type AutonomyOverview,
  type AutonomyResource,
  type AutonomyConfig,
} from "../../api/autonomy";
import { getProjects } from "../../api/organization-projects";
import { isApiRequestError } from "../../api/core";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import type { Department, Project } from "../../types";
import { useI18n } from "../../i18n";

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
const statuses = ["idea", "researching", "approved", "building", "launched", "stopped"] as const;
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
            ko: "설정 > 보안에서 비밀번호로 로그인하세요.",
            en: "Sign in with your password in Settings > Security to make changes.",
            ja: "変更するには設定 > セキュリティでパスワードでサインインしてください。",
            zh: "请在设置 > 安全中使用密码登录以进行更改。",
          });
        if (cause.code === "invalid_goal_period")
          return t({
            ko: "종료일은 시작일 이후여야 합니다.",
            en: "The goal must end after its start date.",
            ja: "終了日は開始日より後にしてください。",
            zh: "目标结束时间必须晚于开始时间。",
          });
        if (cause.code === "project_requires_absolute_path")
          return t({
            ko: "절대 경로가 저장된 프로젝트를 선택하세요.",
            en: "Choose a project with a saved absolute workspace path.",
            ja: "絶対パスが保存されたプロジェクトを選択してください。",
            zh: "请选择已保存绝对工作区路径的项目。",
          });
        if (cause.code === "goal_has_linked_opportunities")
          return t({
            ko: "연결된 기회가 있어 이 목표의 사업이나 프로젝트를 변경할 수 없습니다.",
            en: "This goal has linked opportunities. Keep its business and project or update those links first.",
            ja: "関連する機会があります。事業とプロジェクトを維持するか、先に関連付けを更新してください。",
            zh: "此目标有关联机会。请保留业务和项目或先更新关联。",
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
      setNotice(t({ ko: "저장했습니다.", en: "Saved.", ja: "保存しました。", zh: "已保存。" }));
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
      row.target = Number(row.target);
      row.period_start = new Date(String(row.period_start)).getTime();
      row.period_end = new Date(String(row.period_end)).getTime();
    }
    if (resource === "opportunities") {
      for (const key of [...scoreFields, "budget"]) row[key] = Number(row[key]);
      row.goal_id = row.goal_id || null;
    }
    if (resource === "schedules") {
      row.interval_minutes = Number(row.interval_minutes);
      row.next_run_at = new Date(String(row.next_run_at)).getTime();
      row.enabled = form.get("enabled") === "on";
      row.department_id = row.department_id || null;
    }
    await mutate(() => saveAutonomy(resource, row, editing?.id as string | undefined));
  }
  const label = (tab: AutonomyResource) =>
    ({
      goals: t({ ko: "목표", en: "Goals", ja: "目標", zh: "目标" }),
      opportunities: t({ ko: "기회", en: "Opportunities", ja: "機会", zh: "机会" }),
      schedules: t({ ko: "일정", en: "Schedules", ja: "スケジュール", zh: "计划" }),
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
          <h1 className="text-lg font-semibold">
            {t({ ko: "자율 운영", en: "Autonomy", ja: "自律運用", zh: "自主运行" })}
          </h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "목표를 정하고 기회를 검토하며 반복 조사를 계획하세요. 고객 대상 발송과 지출에는 기존 승인 규칙이 적용됩니다.",
              en: "Set goals, review opportunities and schedule research. Customer-facing work and spending keep their approval rules.",
              ja: "目標を設定し、機会を検討し、定期調査を計画します。顧客対応や支出には承認ルールが適用されます。",
              zh: "设定目标、审查机会并安排研究。面向客户的工作和支出继续遵守审批规则。",
            })}
          </p>
        </div>
        <button type="button" className="ax-btn-secondary" onClick={() => void refresh()} disabled={busy}>
          {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "刷新" })}
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
                ko: "새로고침하여 다시 시도하세요.",
                en: "Refresh to try again.",
                ja: "更新して再試行してください。",
                zh: "刷新以重试。",
              })
            : t({ ko: "불러오는 중…", en: "Loading autonomy…", ja: "読み込み中…", zh: "加载中…" })}
        </p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Autonomy sections"
            className="flex flex-wrap gap-2 border-b pb-3"
            style={{ borderColor: "var(--th-border)" }}
          >
            {(["goals", "opportunities", "schedules"] as const).map((tab) => (
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
                      ko: "잠재 고객 조사",
                      en: "Lead research preset",
                      ja: "見込み客調査",
                      zh: "潜在客户研究预设",
                    })}
                  </button>
                )}
                <button type="button" className="ax-btn-primary" onClick={() => edit()}>
                  {t({ ko: "추가", en: "Add", ja: "追加", zh: "添加" })} {label(resource).toLowerCase()}
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
                      ko: "먼저 업무에서 절대 경로가 있는 프로젝트를 만드세요.",
                      en: "Create a project with an absolute path in Work before adding autonomous work.",
                      ja: "まず業務で絶対パスを持つプロジェクトを作成してください。",
                      zh: "请先在工作中创建具有绝对路径的项目。",
                    })}
                  </p>
                )}
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <Field label={t({ ko: "사업", en: "Business", ja: "事業", zh: "业务" })}>
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
                  <Field label={t({ ko: "프로젝트", en: "Project", ja: "プロジェクト", zh: "项目" })}>
                    <select
                      name="project_id"
                      required
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                      className={inputClass}
                      style={inputStyle}
                    >
                      <option value="">
                        {t({ ko: "프로젝트 선택", en: "Choose a project", ja: "プロジェクトを選択", zh: "选择项目" })}
                      </option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name} — {project.project_path}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {resource === "goals" && (
                    <>
                      <Field label={t({ ko: "지표", en: "Metric", ja: "指標", zh: "指标" })}>
                        <select
                          name="metric"
                          defaultValue={String(editing?.metric ?? "completed_tasks")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          {["completed_tasks", "contacts", "drafts"].map((metric) => (
                            <option key={metric} value={metric}>
                              {pretty(metric)}
                            </option>
                          ))}
                          {Boolean(editing?.metric) &&
                            !["completed_tasks", "contacts", "drafts"].includes(String(editing?.metric)) && (
                              <option value={String(editing?.metric)}>{pretty(String(editing?.metric))}</option>
                            )}
                        </select>
                      </Field>
                      {textField(
                        "target",
                        t({ ko: "목표 수", en: "Target", ja: "目標値", zh: "目标值" }),
                        1,
                        "number",
                        { min: 0, step: "any" },
                      )}
                      {textField(
                        "period_start",
                        t({ ko: "기간 시작", en: "Period starts", ja: "期間開始", zh: "开始时间" }),
                        localDate(Date.now()),
                        "datetime-local",
                        { defaultValue: localDate(editing?.period_start ?? Date.now()) },
                      )}
                      {textField(
                        "period_end",
                        t({ ko: "기간 종료", en: "Period ends", ja: "期間終了", zh: "结束时间" }),
                        localDate(Date.now() + 30 * 86400000),
                        "datetime-local",
                        { defaultValue: localDate(editing?.period_end ?? Date.now() + 30 * 86400000) },
                      )}
                    </>
                  )}
                  {resource !== "goals" && (
                    <>
                      {textField(
                        "title",
                        t({ ko: "제목", en: "Title", ja: "件名", zh: "标题" }),
                        preset ? "Research local leads" : "",
                        "text",
                        { maxLength: 200 },
                      )}
                      <Field label={t({ ko: "설명", en: "Description", ja: "説明", zh: "描述" })}>
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
                  {resource === "opportunities" && (
                    <>
                      <Field label={t({ ko: "연결된 목표", en: "Linked goal", ja: "関連目標", zh: "关联目标" })}>
                        <select
                          name="goal_id"
                          defaultValue={String(editing?.goal_id ?? "")}
                          className={inputClass}
                          style={inputStyle}
                        >
                          <option value="">{t({ ko: "없음", en: "None", ja: "なし", zh: "无" })}</option>
                          {data.goals
                            .filter((goal) => goal.business === business && goal.project_id === projectId)
                            .map((goal) => (
                              <option key={goal.id} value={goal.id}>
                                {BUSINESS_NAMES[goal.business]} · {pretty(goal.metric)} · {goal.target}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label={t({ ko: "상태", en: "Status", ja: "状態", zh: "状态" })}>
                        <select
                          name="status"
                          defaultValue={String(editing?.status ?? "idea")}
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
                      {textField(
                        "budget",
                        t({ ko: "예산 예상", en: "Budget estimate", ja: "予算見積もり", zh: "预算估计" }),
                        0,
                        "number",
                        { min: 0, step: "any" },
                      )}
                    </>
                  )}
                  {resource === "schedules" && (
                    <>
                      <Field label={t({ ko: "조사 유형", en: "Research type", ja: "調査種別", zh: "研究类型" })}>
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
                      <Field label={t({ ko: "부서", en: "Department", ja: "部門", zh: "部门" })}>
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
                      {textField(
                        "interval_minutes",
                        t({ ko: "간격 (분)", en: "Interval (minutes)", ja: "間隔（分）", zh: "间隔（分钟）" }),
                        1440,
                        "number",
                        { min: 1, max: 525600, step: 1 },
                      )}
                      {textField(
                        "next_run_at",
                        t({ ko: "다음 실행", en: "Next run", ja: "次回実行", zh: "下次运行" }),
                        localDate(Date.now() + 86400000),
                        "datetime-local",
                        { defaultValue: localDate(editing?.next_run_at ?? Date.now() + 86400000) },
                      )}
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="enabled" defaultChecked={Boolean(editing?.enabled)} />
                        {t({ ko: "일정 활성화", en: "Enable schedule", ja: "スケジュールを有効化", zh: "启用计划" })}
                      </label>
                    </>
                  )}
                </div>
                {resource === "opportunities" && (
                  <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {t({
                      ko: "점수는 0–100입니다. 예산은 예상치이며 지출 승인이 아닙니다.",
                      en: "Scores run from 0–100. A budget is a planning estimate; spending still requires your approval.",
                      ja: "スコアは0–100です。予算は見積もりで、支出にはオーナーの承認が必要です。",
                      zh: "评分范围为0–100。预算只是估计，支出仍需您批准。",
                    })}
                  </p>
                )}
                <div className="flex gap-2">
                  <button type="submit" className="ax-btn-primary" disabled={busy || !projects.length}>
                    {t({ ko: "저장", en: "Save", ja: "保存", zh: "保存" })}
                  </button>
                  <button type="button" className="ax-btn-secondary" onClick={() => setFormOpen(false)} disabled={busy}>
                    {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "取消" })}
                  </button>
                </div>
              </form>
            )}
            {!data[resource].length ? (
              <p className="py-8 text-sm" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "아직 등록된 항목이 없습니다.",
                  en: "Nothing here yet. Add an item to guide autonomous work.",
                  ja: "まだ項目がありません。自律作業を導く項目を追加してください。",
                  zh: "暂无内容。添加项目以指导自主工作。",
                })}
              </p>
            ) : (
              <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                {data[resource].map((row) => (
                  <li key={row.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">
                        {"title" in row
                          ? row.title
                          : `${pretty(row.metric)} · ${row.progress === null ? t({ ko: "아직 측정되지 않음", en: "Not measured yet", ja: "未測定", zh: "尚未测量" }) : `${row.progress} / ${row.target}`}`}
                      </p>
                      <p className="mt-1 break-words text-xs" style={{ color: "var(--th-text-muted)" }}>
                        {BUSINESS_NAMES[row.business]} ·{" "}
                        {projects.find((project) => project.id === row.project_id)?.name ?? row.project_id}
                        {"status" in row && row.status ? ` · ${row.status}` : ""}
                        {"enabled" in row
                          ? ` · ${row.enabled ? "Enabled" : "Paused"} · ${row.consecutive_failures} failures · ${new Date(row.next_run_at).toLocaleString(locale)}`
                          : ""}
                      </p>
                      {"metric" in row && (
                        <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                          {new Date(row.period_start).toLocaleDateString(locale)} –{" "}
                          {new Date(row.period_end).toLocaleDateString(locale)}
                          {row.progress_scope === "business"
                            ? ` · ${t({ ko: "사업 전체 기록", en: "Business-wide records", ja: "事業全体の記録", zh: "整个业务的记录" })}`
                            : ""}
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
                          {row.enabled
                            ? t({ ko: "일시 중지", en: "Pause", ja: "一時停止", zh: "暂停" })
                            : t({ ko: "활성화", en: "Enable", ja: "有効化", zh: "启用" })}
                        </button>
                      )}
                      <button type="button" className="ax-btn-secondary" onClick={() => edit(row)}>
                        {t({ ko: "편집", en: "Edit", ja: "編集", zh: "编辑" })}
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
            <summary className="cursor-pointer text-sm font-semibold">
              {t({ ko: "운영 제한", en: "Operating limits", ja: "運用制限", zh: "运行限制" })}
            </summary>
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
                      defaultValue={data.config[key]}
                      className={inputClass}
                      style={inputStyle}
                    />
                  </Field>
                ))}
              </div>
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  ko: "한도는 새 자율 작업만 제한합니다. 비상 제어는 모든 페이지에서 사용할 수 있습니다.",
                  en: "Limits apply to new autonomous starts. Emergency controls remain available on every page.",
                  ja: "制限は新規の自律作業開始に適用されます。緊急停止は全ページで利用できます。",
                  zh: "限制适用于新自主启动。每个页面都可使用紧急控制。",
                })}
              </p>
              <button type="submit" className="ax-btn-secondary" disabled={busy}>
                {t({ ko: "제한 저장", en: "Save limits", ja: "制限を保存", zh: "保存限制" })}
              </button>
            </form>
          </details>
          <details className="border-t pt-5" style={{ borderColor: "var(--th-border)" }}>
            <summary className="cursor-pointer text-sm font-semibold">
              {t({ ko: "활동 기록", en: "Activity log", ja: "活動履歴", zh: "活动记录" })}
            </summary>
            {!data.ledger.length ? (
              <p className="py-4 text-sm">
                {t({
                  ko: "아직 자율 활동이 없습니다.",
                  en: "No autonomous activity yet.",
                  ja: "自律活動はまだありません。",
                  zh: "暂无自主活动。",
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
