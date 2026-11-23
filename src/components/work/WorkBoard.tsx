import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkBoard, type BoardCard, type BoardColumn, type BoardGroup, type WorkBoardData } from "../../api/work";
import { useI18n } from "../../i18n";

/**
 * The Work board (work restructure, phase 7; plan section 9): grouped by goal → initiative, plus Operations, in five
 * columns. "Needs you" holds only owner decisions. Cards open the task drawer; initiative headers open its page.
 */
export const COLUMN_LABELS: Record<BoardColumn, string> = {
  waiting: "Waiting",
  working: "Working",
  in_review: "In review",
  needs_you: "Needs you",
  done: "Done",
};
const COLUMN_TONE: Record<BoardColumn, string> = {
  waiting: "var(--ax-planned)",
  working: "var(--ax-working)",
  in_review: "var(--ax-review)",
  needs_you: "var(--ax-signal)",
  done: "var(--ax-done)",
};
const STATUS_LABELS: Record<string, string> = {
  approved: "Approved",
  in_progress: "Building",
  blocked: "Blocked",
  launched: "Launched",
  measuring: "Measuring",
  stopped: "Stopped",
  done: "Done",
};

function stageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  if (stage.startsWith("awaiting_")) return `Waiting for you: ${stage.slice("awaiting_".length).replaceAll("_", " ")}`;
  if (stage === "steps_done") return "All steps done";
  return `Step: ${stage.replaceAll("_", " ")}`;
}

function Card({ card, onOpen }: { card: BoardCard; onOpen: (id: string) => void }) {
  const step = card.playbook_step && !card.playbook_step.includes(":") ? card.playbook_step : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        className="ax-lift w-full rounded-lg px-3 py-2 text-left transition active:scale-[0.99]"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        <span
          className="block break-words text-[13px] font-medium leading-snug"
          style={{ color: "var(--th-text-heading)" }}
        >
          {card.title}
        </span>
        <span
          className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]"
          style={{ color: "var(--th-text-muted)" }}
        >
          <span>{card.agent_name ?? "Unassigned"}</span>
          {card.agent_provider ? <span className="font-mono">{card.agent_provider}</span> : null}
          {card.work_type ? <span>{card.work_type.replaceAll("_", " ")}</span> : null}
          {step ? <span>{step}</span> : null}
          {card.importance === "important" ? <span style={{ color: "var(--ax-signal)" }}>important</span> : null}
          {card.attempt > 1 ? <span>try {card.attempt}</span> : null}
          {card.review_state === "changes" ? <span>changes asked</span> : null}
        </span>
      </button>
    </li>
  );
}

function GroupRow({
  group,
  columns,
  onOpenTask,
  onOpenInitiative,
}: {
  group: BoardGroup;
  columns: BoardColumn[];
  onOpenTask: (id: string) => void;
  onOpenInitiative?: (id: string) => void;
}) {
  const blocked = group.status === "blocked";
  return (
    <section aria-label={group.title} className="py-4" style={{ borderTop: "1px solid var(--th-border)" }}>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {group.kind === "initiative" && onOpenInitiative ? (
          <button
            type="button"
            onClick={() => onOpenInitiative(group.id)}
            className="break-words text-left text-[15px] font-semibold underline-offset-4 hover:underline"
            style={{ color: "var(--th-text-heading)" }}
          >
            {group.title}
          </button>
        ) : (
          <h3 className="break-words text-[15px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {group.title}
          </h3>
        )}
        {group.status ? (
          <span className="ax-chip text-[11px]" style={blocked ? { color: "var(--ax-danger)" } : undefined}>
            {STATUS_LABELS[group.status] ?? group.status}
          </span>
        ) : null}
        {stageLabel(group.playbook_stage) ? (
          <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            {stageLabel(group.playbook_stage)}
          </span>
        ) : null}
        {blocked && group.blocked_reason ? (
          <span className="basis-full break-words text-[12px]" style={{ color: "var(--ax-danger)" }}>
            {group.blocked_reason}
          </span>
        ) : null}
      </header>
      {group.cards.length === 0 ? (
        <p className="text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
          Nothing queued yet; the next step starts on its own.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          {columns.map((column) => {
            const cards = group.cards.filter((card) => card.column === column);
            return (
              <div key={column} className={cards.length ? "" : "hidden md:block"}>
                <p
                  className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide md:hidden"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: COLUMN_TONE[column] }} />
                  {COLUMN_LABELS[column]}
                </p>
                {cards.length ? (
                  <ul className="space-y-2">
                    {cards.map((card) => (
                      <Card key={card.id} card={card} onOpen={onOpenTask} />
                    ))}
                  </ul>
                ) : (
                  <div
                    className="h-full min-h-8 rounded-lg"
                    style={{ border: "1px dashed var(--th-border)", opacity: 0.6 }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function WorkBoard({
  refreshKey,
  onOpenTask,
  onOpenInitiative,
}: {
  /** Changes when tasks change (live sync), so the board reloads. */
  refreshKey: unknown;
  onOpenTask: (id: string) => void;
  onOpenInitiative: (id: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<WorkBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getWorkBoard());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), data ? 400 : 0);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, load]);

  if (error && !data)
    return (
      <p
        role="alert"
        className="rounded-lg px-3 py-2 text-[13px]"
        style={{ color: "var(--ax-danger)", border: "1px solid var(--th-border)" }}
      >
        {t({ en: `The board couldn't load: ${error}` })}
      </p>
    );
  if (!data)
    return (
      <div aria-busy="true" className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg" style={{ background: "var(--th-bg-surface)" }} />
        ))}
      </div>
    );
  const empty = !data.goals.some((goal) => goal.groups.length) && !data.operations.cards.length;
  return (
    <div className="min-w-0">
      <dl className="mb-2 grid grid-cols-5 gap-2" aria-label={t({ en: "Board summary" })}>
        {data.columns.map((column) => (
          <div key={column} className="min-w-0">
            <dt
              className="flex items-center gap-1.5 truncate text-[11px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--th-text-muted)" }}
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: COLUMN_TONE[column] }}
              />
              <span className="truncate">{COLUMN_LABELS[column]}</span>
            </dt>
            <dd
              className="font-mono text-[18px] font-semibold"
              style={{
                color: column === "needs_you" && data.counts[column] ? "var(--ax-signal)" : "var(--th-text-heading)",
              }}
            >
              {data.counts[column]}
            </dd>
          </div>
        ))}
      </dl>
      {empty ? (
        <p
          className="mt-6 rounded-lg px-4 py-6 text-[13px]"
          style={{ border: "1px dashed var(--th-border)", color: "var(--th-text-muted)" }}
        >
          {t({
            en: "No work yet. Set a goal in Autonomy and the agents start with research; one-off asks show up under Operations.",
          })}
        </p>
      ) : null}
      {data.goals.map((goal) =>
        goal.groups.length ? (
          <div key={goal.id} className="mt-6">
            <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--th-text-heading)" }}>
              {goal.title}
              <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--th-text-muted)" }}>
                {goal.business}
              </span>
            </h2>
            {goal.groups.map((group) => (
              <GroupRow
                key={`${group.kind}:${group.id}`}
                group={group}
                columns={data.columns}
                onOpenTask={onOpenTask}
                onOpenInitiative={onOpenInitiative}
              />
            ))}
          </div>
        ) : null,
      )}
      {data.operations.cards.length ? (
        <div className="mt-6">
          <h2 className="text-[17px] font-semibold tracking-tight" style={{ color: "var(--th-text-heading)" }}>
            {t({ en: "Operations" })}
          </h2>
          <GroupRow
            group={{ ...data.operations, title: t({ en: "One-off and upkeep work" }) }}
            columns={data.columns}
            onOpenTask={onOpenTask}
          />
        </div>
      ) : null}
    </div>
  );
}
