import { useEffect, useRef, useState } from "react";
import { getBehindTheScenes, type AgentScene } from "../../api/work";
import { useI18n } from "../../i18n";

/**
 * Behind the scenes (phase 7): one card per agent with what they're doing right now, their queue, recent hand-offs,
 * the reviews they're doing, the model in use and any model problem the VPs fixed. Updates live with the agents.
 */
const STATUS_TONE: Record<string, string> = {
  working: "var(--ax-working)",
  idle: "var(--ax-idle)",
  break: "var(--ax-break)",
  offline: "var(--ax-offline)",
};
const ROLE_LABEL: Record<string, string> = {
  vp: "VP",
  team_leader: "Lead",
  senior: "Senior",
  junior: "Junior",
  intern: "Intern",
};

function AgentCard({ agent, onOpenTask }: { agent: AgentScene; onOpenTask: (id: string) => void }) {
  const { t } = useI18n();
  const task = (id: string, title: string) => (
    <button
      type="button"
      onClick={() => onOpenTask(id)}
      className="break-words text-left underline-offset-2 hover:underline"
    >
      {title}
    </button>
  );
  return (
    <article
      aria-label={agent.name}
      className="flex min-w-0 flex-col gap-3 rounded-xl p-4"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      <header className="flex items-start gap-3">
        <span
          className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: STATUS_TONE[agent.status] ?? "var(--ax-idle)" }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {agent.name}
          </h3>
          <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            {ROLE_LABEL[agent.role] ?? agent.role}
            {agent.department_name ? ` · ${agent.department_name}` : ""} · {agent.status}
          </p>
        </div>
        <span
          className="shrink-0 font-mono text-[11.5px]"
          style={{ color: agent.provider ? "var(--th-text-secondary)" : "var(--ax-signal)" }}
        >
          {agent.provider ? `${agent.provider}${agent.model ? ` / ${agent.model}` : ""}` : t({ en: "no model yet" })}
        </span>
      </header>
      <div className="text-[13px]" style={{ color: "var(--th-text-primary)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
          {t({ en: "Now" })}
        </p>
        {agent.current ? (
          task(agent.current.id, agent.current.title)
        ) : agent.reviewing.length ? null : (
          <span style={{ color: "var(--th-text-muted)" }}>{t({ en: "Free" })}</span>
        )}
        {agent.reviewing.map((review) => (
          <p key={review.task_id} className="mt-1">
            {t({ en: "Reviewing " })}
            {task(review.task_id, review.title)}
            {review.round > 1 ? ` (round ${review.round})` : ""}
          </p>
        ))}
      </div>
      {agent.queue.length ? (
        <div className="text-[12.5px]">
          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
            {t({ en: `Up next (${agent.queue.length})` })}
          </p>
          <ol className="mt-1 space-y-0.5" style={{ color: "var(--th-text-secondary)" }}>
            {agent.queue.slice(0, 4).map((item) => (
              <li key={item.id} className="flex gap-1.5">
                {item.importance === "important" ? (
                  <span style={{ color: "var(--ax-signal)" }}>!</span>
                ) : (
                  <span aria-hidden>·</span>
                )}
                {task(item.id, item.title)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {agent.recent_handoffs.length ? (
        <details className="text-[12.5px]">
          <summary
            className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--th-text-muted)" }}
          >
            {t({ en: "Recent hand-offs" })}
          </summary>
          <ul className="mt-1 space-y-2" style={{ color: "var(--th-text-secondary)" }}>
            {agent.recent_handoffs.map((item) => (
              <li key={item.task_id}>
                {task(item.task_id, item.title)}
                <p className="mt-0.5 line-clamp-3 break-words" style={{ color: "var(--th-text-muted)" }}>
                  {item.handoff?.summary}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {agent.model_fixes.length ? (
        <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {agent.model_fixes[0].message}
        </p>
      ) : null}
    </article>
  );
}

export default function BehindTheScenes({
  refreshKey,
  onOpenTask,
}: {
  refreshKey: unknown;
  onOpenTask: (id: string) => void;
}) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentScene[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        getBehindTheScenes()
          .then((data) => {
            setAgents(data.agents);
            setError(null);
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      },
      agents ? 400 : 0,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);
  const working = agents?.filter((agent) => agent.current || agent.reviewing.length).length ?? 0;
  return (
    <section aria-label={t({ en: "Behind the scenes" })} className="min-w-0">
      <p className="mb-4 max-w-[65ch] text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
        {agents
          ? t({ en: `${working} of ${agents.length} agents busy right now. Click any task to open it.` })
          : t({ en: "What every agent is doing right now." })}
      </p>
      {error && !agents ? (
        <p role="alert" className="text-[13px]" style={{ color: "var(--ax-danger)" }}>
          {error}
        </p>
      ) : !agents ? (
        <div aria-busy="true" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl" style={{ background: "var(--th-bg-surface)" }} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </section>
  );
}
