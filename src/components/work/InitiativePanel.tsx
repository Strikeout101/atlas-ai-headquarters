import { useEffect, useRef, useState } from "react";
import { getInitiativeDetail, type InitiativeDetail, type InitiativeStep } from "../../api/work";
import { useI18n } from "../../i18n";

/**
 * An initiative's page (phase 7): its playbook steps as a timeline, each with its task, hand-off and reviews.
 * Opened from the Work board (`?initiative=<id>`); a step's task opens the task drawer.
 */
const STATE_LABEL: Record<InitiativeStep["state"], string> = {
  done: "Done",
  current: "In progress",
  upcoming: "Next",
  skipped: "Skipped",
  waiting_owner: "Waiting for you",
};
const STATE_TONE: Record<InitiativeStep["state"], string> = {
  done: "var(--ax-done)",
  current: "var(--ax-working)",
  upcoming: "var(--th-border-strong)",
  skipped: "var(--th-text-muted)",
  waiting_owner: "var(--ax-signal)",
};

export default function InitiativePanel({
  initiativeId,
  refreshKey,
  onClose,
  onOpenTask,
}: {
  initiativeId: string;
  refreshKey: unknown;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<InitiativeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let live = true;
    getInitiativeDetail(initiativeId)
      .then((next) => live && (setDetail(next), setError(null)))
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [initiativeId, refreshKey]);
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = detail?.initiative.title ?? t({ en: "Initiative" });
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[44] cursor-default bg-black/40"
        aria-label={t({ en: "Close" })}
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-y-0 right-0 z-[45] flex w-full max-w-[640px] flex-col outline-none"
        style={{
          background: "var(--th-bg-primary)",
          borderLeft: "1px solid var(--th-border)",
          boxShadow: "var(--ax-shadow-lift)",
        }}
      >
        <header
          className="flex items-start gap-3 px-5 pb-3 pt-4"
          style={{ borderBottom: "1px solid var(--th-border)" }}
        >
          <div className="min-w-0 flex-1">
            {detail?.goal ? (
              <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {detail.goal.title} · {detail.initiative.playbook ?? t({ en: "no playbook" })}
              </p>
            ) : null}
            <h2
              className="break-words text-[18px] font-semibold tracking-tight"
              style={{ color: "var(--th-text-heading)" }}
            >
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[13px]"
            style={{ color: "var(--th-text-secondary)", border: "1px solid var(--th-border)" }}
          >
            {t({ en: "Close" })}
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="text-[13px]" style={{ color: "var(--ax-danger)" }}>
              {error}
            </p>
          ) : !detail ? (
            <div aria-busy="true" className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg" style={{ background: "var(--th-bg-surface)" }} />
              ))}
            </div>
          ) : (
            <>
              {detail.initiative.status === "blocked" && detail.initiative.blocked_reason ? (
                <p
                  className="mb-4 rounded-lg px-3 py-2 text-[13px]"
                  style={{ border: "1px solid var(--ax-danger)", color: "var(--ax-danger)" }}
                >
                  {detail.initiative.escalation === "owner"
                    ? t({ en: "Stuck and waiting for your call in the Decision Inbox: " })
                    : t({ en: "Stuck; the VPs are on it: " })}
                  {detail.initiative.blocked_reason}
                </p>
              ) : null}
              <details className="mb-4">
                <summary
                  className="cursor-pointer text-[13px] font-medium"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  {t({ en: "Brief" })} ·{" "}
                  {t({
                    en: `budget $${detail.initiative.budget}, up to ${detail.initiative.task_cap_daily} tasks a day`,
                  })}
                </summary>
                <p
                  className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {detail.initiative.description || t({ en: "No brief." })}
                </p>
              </details>
              <ol aria-label={t({ en: "Steps" })} className="relative space-y-4">
                {detail.steps.map((step, index) => (
                  <li key={step.key} className="relative pl-6">
                    <span
                      className="absolute left-0 top-1.5 inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: STATE_TONE[step.state] }}
                    />
                    {index < detail.steps.length - 1 ? (
                      <span
                        className="absolute left-[4.5px] top-5 bottom-[-14px] w-px"
                        style={{ background: "var(--th-border)" }}
                      />
                    ) : null}
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <h3 className="break-words text-[14px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
                        {step.title}
                      </h3>
                      <span className="text-[12px]" style={{ color: STATE_TONE[step.state] }}>
                        {STATE_LABEL[step.state]}
                      </span>
                    </div>
                    {step.task ? (
                      <button
                        type="button"
                        onClick={() => onOpenTask(step.task!.id)}
                        className="mt-1 text-left text-[12.5px] underline underline-offset-2"
                        style={{ color: "var(--th-text-secondary)" }}
                      >
                        {step.task.agent_name ?? t({ en: "Unassigned" })}
                        {step.task.agent_provider ? ` (${step.task.agent_provider})` : ""} · {t({ en: "open task" })}
                      </button>
                    ) : step.kind === "owner_approval" ? (
                      <p className="mt-1 text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
                        {t({ en: "Stops here for your approval." })}
                      </p>
                    ) : null}
                    {step.handoff ? (
                      <div
                        className="mt-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed"
                        style={{ background: "var(--th-bg-surface)" }}
                      >
                        <p className="whitespace-pre-wrap break-words" style={{ color: "var(--th-text-primary)" }}>
                          {step.handoff.summary}
                        </p>
                        {step.handoff.files.length ? (
                          <ul className="mt-1 list-disc pl-4" style={{ color: "var(--th-text-muted)" }}>
                            {step.handoff.files.slice(0, 8).map((file) => (
                              <li key={file.path} className="break-all font-mono text-[11.5px]">
                                {file.path}
                                {file.note ? ` (${file.note})` : ""}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {step.handoff.generated ? (
                          <p className="mt-1 text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                            {t({ en: "Written by ATLAS; the agent skipped its hand-off." })}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    {step.reviews.length ? (
                      <ul className="mt-2 space-y-1 text-[12px]" aria-label={t({ en: "Reviews" })}>
                        {step.reviews.map((review, i) => (
                          <li key={i} style={{ color: "var(--th-text-secondary)" }}>
                            {review.status === "approved"
                              ? t({ en: `Review ${review.round}: approved` })
                              : review.status === "changes"
                                ? t({ en: `Review ${review.round}: changes asked` })
                                : t({ en: `Review: ${review.status}` })}
                            {review.reviewer_provider
                              ? ` (${review.reviewer_provider}${review.same_model ? ", same model" : ""})`
                              : ""}
                            {review.summary ? ` · ${review.summary}` : ""}
                            {review.items.length ? (
                              <ul className="list-disc pl-4">
                                {review.items.map((item) => (
                                  <li key={item} className="break-words">
                                    {item}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
              {detail.other_tasks.length ? (
                <section className="mt-6" aria-label={t({ en: "Other work" })}>
                  <h3 className="mb-2 text-[13px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
                    {t({ en: "Other work for this initiative" })}
                  </h3>
                  <ul className="space-y-1">
                    {detail.other_tasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => onOpenTask(task.id)}
                          className="break-words text-left text-[12.5px] underline underline-offset-2"
                          style={{ color: "var(--th-text-secondary)" }}
                        >
                          {task.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
