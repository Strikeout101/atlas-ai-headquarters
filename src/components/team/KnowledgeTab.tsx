import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isApiRequestError } from "../../api/core";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import {
  knowledgeApi,
  type AgentMemory,
  type LessonCoverage,
  type MemoryFilter,
  type MemoryList,
} from "../../api/knowledge";
import { useI18n } from "../../i18n";
import MarkdownView from "./MarkdownView";

type Section = "memory" | "systems" | "checklist";

const ERROR_TEXT: Record<string, string> = {
  owner_session_required: "Sign in with your password in Settings > Security to change memories.",
  memory_looks_like_secret: "That looks like a password or key. Memories must never hold secrets.",
  memory_duplicate: "A memory with that title already exists in the same scope.",
};
function describe(cause: unknown): string {
  const code = isApiRequestError(cause) ? cause.code : cause instanceof Error ? cause.message : "";
  return ERROR_TEXT[code ?? ""] ?? (cause instanceof Error ? cause.message : "That did not go through. Try again.");
}

const buttonClass =
  "rounded-lg border border-slate-500/30 px-3 py-1.5 text-sm transition hover:bg-slate-500/10 active:scale-[0.98] disabled:cursor-wait disabled:opacity-50";
const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};

function scopeLabel(memory: AgentMemory): string {
  if (memory.scope === "business" && memory.business) return BUSINESS_NAMES[memory.business];
  if (memory.scope === "project") return "This project";
  return "Everyone";
}

function MemoryCard({
  memory,
  busy,
  onReview,
  onArchive,
  onRestore,
  onSave,
  locale,
}: {
  memory: AgentMemory;
  busy: boolean;
  onReview: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onSave: (title: string, body: string) => void;
  locale: string;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const archived = memory.status === "archived";
  return (
    <li
      className="rounded-xl border border-slate-500/25 p-4"
      aria-label={memory.title}
      style={archived ? { opacity: 0.7 } : undefined}
    >
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSave(title, body);
            setEditing(false);
          }}
        >
          <label className="block text-xs">
            Title
            <input
              value={title}
              maxLength={120}
              className={`${inputClass} mt-1`}
              style={inputStyle}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            Text
            <textarea
              value={body}
              rows={4}
              maxLength={1000}
              className={`${inputClass} mt-1`}
              style={inputStyle}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className={buttonClass} disabled={busy}>
              Save and mark reviewed
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="min-w-0 break-words text-sm font-semibold">{memory.title}</h3>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={
                archived
                  ? { background: "var(--th-bg-surface)", color: "var(--th-text-muted)" }
                  : memory.reviewed_at
                    ? { background: "var(--th-bg-surface)", color: "var(--th-text-secondary)" }
                    : { background: "var(--ax-signal-soft)", color: "var(--ax-signal)" }
              }
            >
              {archived ? "Archived" : memory.reviewed_at ? "Reviewed" : "Needs review"}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{memory.body}</p>
          <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {memory.kind === "lesson" ? "Lesson" : "Fact"} · for {scopeLabel(memory)} ·{" "}
            {memory.source_agent_name ? `from ${memory.source_agent_name}` : "added by you"}
            {memory.source_task_title ? ` on "${memory.source_task_title}"` : ""} ·{" "}
            {new Date(memory.created_at).toLocaleDateString(locale)} · used {memory.use_count}{" "}
            {memory.use_count === 1 ? "time" : "times"}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {archived ? (
              <button type="button" className={buttonClass} disabled={busy} onClick={onRestore}>
                Restore
              </button>
            ) : (
              <>
                <button type="button" className={buttonClass} disabled={busy} onClick={onArchive}>
                  Archive
                </button>
                <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </button>
                {!memory.reviewed_at && (
                  <button type="button" className={buttonClass} disabled={busy} onClick={onReview}>
                    Looks right
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

/** Whether finished tasks are leaving lessons, so a quiet memory list is not mistaken for "nothing learned". */
function LessonCoverageLine() {
  const [coverage, setCoverage] = useState<LessonCoverage | null>(null);
  useEffect(() => {
    knowledgeApi
      .lessonChecks()
      .then(setCoverage)
      .catch(() => setCoverage(null));
  }, []);
  if (!coverage) return null;
  const { agent_added, captured, none_declared, missing } = coverage.counts;
  if (agent_added + captured + none_declared + missing === 0) return null;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }} aria-label="Lessons after tasks">
      <p>
        Finished tasks, last {coverage.days} days: {agent_added} saved lessons themselves · {captured} had lessons taken
        from their final message · {none_declared} said there was nothing to learn · {missing} left nothing
      </p>
      {coverage.recentMissing.length > 0 && (
        <p className="mt-1 break-words">
          Recent tasks with no lessons: {coverage.recentMissing.map((item) => item.title).join(", ")}
        </p>
      )}
    </div>
  );
}

function MemoryPanel() {
  const { locale } = useI18n();
  const [filter, setFilter] = useState<MemoryFilter>({ status: "active" });
  const [data, setData] = useState<MemoryList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ title: string; body: string; business: BusinessKind | "" }>({
    title: "",
    body: "",
    business: "",
  });

  const load = useCallback(async () => {
    try {
      setData(await knowledgeApi.memories(filter));
    } catch (cause) {
      setError(describe(cause));
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      await load();
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="max-w-[70ch] text-sm" style={{ color: "var(--th-text-secondary)" }}>
        Facts and lessons agents saved for later tasks. They are used right away; check new ones and archive anything
        wrong. Memories are reference notes only: approval rules still apply whatever they say.
      </p>
      {data && (
        <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {data.counts.active} in use · {data.counts.unreviewed} need review · {data.counts.archived} archived
        </p>
      )}
      <LessonCoverageLine />
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="text-xs">
          Show
          <select
            value={`${filter.status ?? ""}:${filter.reviewed ?? ""}`}
            className={`${inputClass} mt-1 w-auto`}
            style={inputStyle}
            onChange={(e) => {
              const [status, reviewed] = e.target.value.split(":");
              setFilter({
                ...filter,
                status: status as MemoryFilter["status"],
                reviewed: reviewed as MemoryFilter["reviewed"],
              });
            }}
          >
            <option value="active:">In use</option>
            <option value="active:no">Needs review</option>
            <option value="archived:">Archived</option>
            <option value=":">All</option>
          </select>
        </label>
        <label className="text-xs">
          Business
          <select
            value={filter.business ?? ""}
            className={`${inputClass} mt-1 w-auto`}
            style={inputStyle}
            onChange={(e) => setFilter({ ...filter, business: e.target.value as MemoryFilter["business"] })}
          >
            <option value="">Any</option>
            {BUSINESS_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {BUSINESS_NAMES[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[12rem] flex-1 text-xs">
          Search
          <input
            type="search"
            value={filter.q ?? ""}
            className={`${inputClass} mt-1`}
            style={inputStyle}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          />
        </label>
        <button type="button" className={buttonClass} onClick={() => setAdding(!adding)}>
          Add a memory
        </button>
      </form>

      {adding && (
        <form
          className="mt-4 space-y-2 rounded-xl border border-slate-500/25 p-4"
          aria-label="New memory"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await knowledgeApi.create({
                kind: "fact",
                scope: draft.business ? "business" : "global",
                business: draft.business || null,
                title: draft.title,
                body: draft.body,
              });
              setDraft({ title: "", body: "", business: "" });
              setAdding(false);
            });
          }}
        >
          <label className="block text-xs">
            Title
            <input
              required
              value={draft.title}
              maxLength={120}
              className={`${inputClass} mt-1`}
              style={inputStyle}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            What agents should know
            <textarea
              required
              rows={3}
              value={draft.body}
              maxLength={1000}
              className={`${inputClass} mt-1`}
              style={inputStyle}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            For
            <select
              value={draft.business}
              className={`${inputClass} mt-1 w-auto`}
              style={inputStyle}
              onChange={(e) => setDraft({ ...draft, business: e.target.value as BusinessKind | "" })}
            >
              <option value="">Every business</option>
              {BUSINESS_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {BUSINESS_NAMES[kind]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end">
            <button type="submit" className={buttonClass} disabled={busy}>
              Save memory
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "var(--ax-danger)" }}>
          {error}
        </p>
      )}
      {data && data.items.length === 0 && (
        <p className="mt-6 text-sm" style={{ color: "var(--th-text-secondary)" }}>
          No memories here yet. Agents add them while they work, and you can add your own.
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {data.items.map((memory) => (
            <MemoryCard
              key={`${memory.id}-${memory.updated_at}`}
              memory={memory}
              busy={busy}
              locale={locale}
              onReview={() => void run(() => knowledgeApi.review(memory.id))}
              onArchive={() => void run(() => knowledgeApi.setStatus(memory.id, "archived"))}
              onRestore={() => void run(() => knowledgeApi.setStatus(memory.id, "active"))}
              onSave={(title, body) => void run(() => knowledgeApi.update(memory.id, { title, body }))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentPanel({ topic }: { topic: "systems" | "checklist" }) {
  const [doc, setDoc] = useState<{ available: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    knowledgeApi
      .document(topic)
      .then((result) => !cancelled && setDoc(result))
      .catch((cause) => !cancelled && setError(describe(cause)));
    return () => {
      cancelled = true;
    };
  }, [topic]);
  if (error)
    return (
      <p role="alert" className="text-sm" style={{ color: "var(--ax-danger)" }}>
        {error}
      </p>
    );
  if (!doc) return <p className="text-sm">Loading…</p>;
  if (!doc.available)
    return (
      <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
        {topic === "systems"
          ? "No systems registry yet. Copy knowledge.example to knowledge/ in the ATLAS folder and fill in systems.md."
          : "CHECKLIST.md was not found in the ATLAS folder."}
      </p>
    );
  return (
    <div className="max-w-5xl">
      <p className="mb-3 text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {topic === "systems"
          ? "Read-only. Lives in knowledge/systems.md on the ATLAS PC (kept out of git). Agents get its Summary in every task."
          : "Read-only. Lives in CHECKLIST.md in the ATLAS folder: everything pending, with items only you can do marked YOU."}
      </p>
      <MarkdownView text={doc.text} />
    </div>
  );
}

/** What agents know: memories to review, the systems registry and the master checklist. */
export default function KnowledgeTab() {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("memory");
  const sections: Array<{ key: Section; label: string }> = [
    { key: "memory", label: t({ en: "Memory" }) },
    { key: "systems", label: t({ en: "Systems" }) },
    { key: "checklist", label: t({ en: "Checklist" }) },
  ];
  return (
    <section className="mx-auto w-full max-w-7xl pb-8" aria-label={t({ en: "Knowledge" })}>
      <h1 className="text-lg font-semibold" style={{ color: "var(--th-text-heading)" }}>
        {t({ en: "Knowledge" })}
      </h1>
      <div role="tablist" aria-label="Knowledge sections" className="mt-3 mb-4 flex flex-wrap gap-1">
        {sections.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            onClick={() => setSection(key)}
            className="rounded-lg px-3 py-1.5 text-sm transition"
            style={
              section === key
                ? { background: "var(--th-bg-surface)", color: "var(--th-text-heading)", fontWeight: 600 }
                : { color: "var(--th-text-secondary)" }
            }
          >
            {label}
          </button>
        ))}
      </div>
      {section === "memory" && <MemoryPanel />}
      {section === "systems" && <DocumentPanel topic="systems" />}
      {section === "checklist" && <DocumentPanel topic="checklist" />}
    </section>
  );
}
