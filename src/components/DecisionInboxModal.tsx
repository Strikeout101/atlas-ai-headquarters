import { Signpost, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { UiLanguage } from "../i18n";
import { pickLang } from "../i18n";
import type { Agent } from "../types";
import AgentAvatar, { buildSpriteMap } from "./AgentAvatar";
import MessageContent from "./MessageContent";
import type { DecisionInboxItem } from "./chat/decision-inbox";
import { formatDecisionInboxTime as formatTime, type DecisionInboxModalProps } from "./chat/decision-inbox-modal.meta";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

export default function DecisionInboxModal({
  open,
  loading,
  items,
  agents,
  busyKey,
  uiLanguage,
  onClose,
  onRefresh,
  onReplyOption,
  onOpenChat,
}: DecisionInboxModalProps) {
  useEscapeToClose(onClose);
  const t = (text: { en: string }) => pickLang(uiLanguage, text);
  const spriteMap = useMemo(() => buildSpriteMap(agents), [agents]);
  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);
  const [followupTarget, setFollowupTarget] = useState<{
    itemId: string;
    optionNumber: number;
  } | null>(null);
  const [followupDraft, setFollowupDraft] = useState("");

  useEffect(() => {
    if (!open) {
      setFollowupTarget(null);
      setFollowupDraft("");
      return;
    }
    if (!followupTarget) return;
    const stillExists = items.some((entry) => entry.id === followupTarget.itemId);
    if (!stillExists) {
      setFollowupTarget(null);
      setFollowupDraft("");
    }
  }, [open, followupTarget, items]);

  const followupItem = useMemo(
    () => (followupTarget ? (items.find((entry) => entry.id === followupTarget.itemId) ?? null) : null),
    [followupTarget, items],
  );
  const followupBusyKey = followupTarget ? `${followupTarget.itemId}:${followupTarget.optionNumber}` : null;
  const isFollowupSubmitting = followupBusyKey ? busyKey === followupBusyKey : false;
  const canSubmitFollowup = !!(followupItem && followupDraft.trim() && !isFollowupSubmitting);

  function handleOptionClick(item: DecisionInboxItem, optionNumber: number, action?: string) {
    if (action === "add_followup_request") {
      setFollowupTarget({ itemId: item.id, optionNumber });
      setFollowupDraft("");
      return;
    }
    onReplyOption(item, optionNumber);
  }

  function handleSubmitFollowup() {
    if (!followupItem || !followupTarget) return;
    const note = followupDraft.trim();
    if (!note) return;
    onReplyOption(followupItem, followupTarget.optionNumber, { note });
    setFollowupTarget(null);
    setFollowupDraft("");
  }

  function handleCancelFollowup() {
    setFollowupTarget(null);
    setFollowupDraft("");
  }

  const getKindLabel = (kind: DecisionInboxItem["kind"]) => {
    if (kind === "task_timeout_resume") {
      return t({ en: "Timeout Resume" });
    }
    if (kind === "review_owner") {
      return t({ en: "Stuck review" });
    }
    return t({ en: "Agent Request" });
  };
  const getKindAvatarFallback = (kind: DecisionInboxItem["kind"]) => {
    if (kind === "task_timeout_resume") return "⏱️";
    if (kind === "review_owner") return "🧾";
    return "🤖";
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4 w-full max-w-3xl rounded-[14px] border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700/50 px-6 py-4">
          <div className="flex items-center gap-3">
            <Signpost size={20} strokeWidth={1.75} style={{ color: "var(--ax-signal)" }} />
            <h2 className="text-[17px] font-semibold text-white">{t({ en: "Pending Decisions" })}</h2>
            <span
              className="rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
              style={{ background: "var(--ax-signal-soft)", color: "var(--ax-signal)" }}
            >
              {items.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              {t({ en: "Refresh" })}
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {loading ? (
            <div className="py-12 text-center text-sm text-slate-500">
              {t({
                en: "Loading pending decisions...",
              })}
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              {t({
                en: "No pending decisions right now.",
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <div key={item.id} className="rounded-xl border border-slate-700/60 bg-slate-800/50 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    {(() => {
                      const agent = item.agentId ? agentById.get(item.agentId) : undefined;
                      return (
                        <div className="flex min-w-0 items-start gap-2">
                          {agent ? (
                            <AgentAvatar
                              agent={agent}
                              spriteMap={spriteMap}
                              size={32}
                              className="mt-0.5 border border-slate-600 bg-slate-900"
                            />
                          ) : (
                            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-600 bg-slate-900 text-base">
                              {item.agentAvatar || getKindAvatarFallback(item.kind)}
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-white">{item.agentName}</p>
                            <p className="text-[11px] text-indigo-300/90">{getKindLabel(item.kind)}</p>
                            <p className="text-[11px] text-slate-400">{formatTime(item.createdAt, uiLanguage)}</p>
                          </div>
                        </div>
                      );
                    })()}
                    {item.agentId ? (
                      <button
                        onClick={() => onOpenChat(item.agentId!)}
                        className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 transition hover:border-slate-400 hover:bg-slate-700 hover:text-white"
                      >
                        {t({ en: "Open Chat" })}
                      </button>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-slate-700/70 bg-slate-900/60 px-2.5 py-2 text-xs text-slate-200">
                    <MessageContent content={item.requestContent} />
                  </div>

                  <div className="mt-2 space-y-1.5">
                    {item.options.length > 0 ? (
                      item.options.map((option) => {
                        const key = `${item.id}:${option.number}`;
                        const isBusy = busyKey === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => handleOptionClick(item, option.number, option.action)}
                            disabled={isBusy}
                            className="decision-inbox-option w-full whitespace-normal break-words rounded-md px-2.5 py-1.5 text-left text-xs leading-relaxed transition disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isBusy ? t({ en: "Sending..." }) : `${option.number}. ${option.label}`}
                          </button>
                        );
                      })
                    ) : (
                      <p className="rounded-md border border-slate-700/70 bg-slate-900/50 px-2.5 py-2 text-xs text-slate-400">
                        {t({
                          en: "Options are being prepared...",
                        })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {followupItem ? (
          <div className="border-t border-slate-700/60 bg-slate-900/90 px-4 py-3">
            <p className="mb-2 text-xs font-semibold text-slate-200">
              {t({
                en: "Additional Follow-up Request",
              })}
            </p>
            <textarea
              value={followupDraft}
              onChange={(event) => setFollowupDraft(event.target.value)}
              placeholder={t({
                en: "Enter your request details.",
              })}
              rows={3}
              className="w-full resize-y rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelFollowup}
                disabled={isFollowupSubmitting}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t({ en: "Cancel" })}
              </button>
              <button
                type="button"
                onClick={handleSubmitFollowup}
                disabled={!canSubmitFollowup}
                className="decision-followup-submit rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isFollowupSubmitting ? t({ en: "Sending..." }) : t({ en: "Submit Request" })}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
