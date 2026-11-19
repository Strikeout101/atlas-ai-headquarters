import { useState } from "react";
import { Cpu, Lightbulb, Mail, TerminalSquare } from "lucide-react";
import type { PendingApproval } from "../../api";
import { useI18n } from "../../i18n";
import { timeAgo } from "../dashboard/model";
import { formatMoney } from "../revenue/money";

interface ApprovalRowProps {
  item: PendingApproval;
  onDecide: (item: PendingApproval, approve: boolean) => Promise<void>;
  onOpenHomelab: () => void;
}

const buttonClass =
  "inline-flex h-8 shrink-0 items-center rounded-md px-3 text-[12px] font-medium transition hover:opacity-90 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60";
const quietStyle = {
  border: "1px solid var(--th-border)",
  background: "var(--th-bg-surface)",
  color: "var(--th-text-primary)",
};

/** One email, SSH command, model upgrade or agent task suggestion waiting on the owner, decided in place. */
export default function ApprovalRow({ item, onDecide, onOpenHomelab }: ApprovalRowProps) {
  const { t, locale: localeTag } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    if (approve && item.kind === "ssh_command") {
      const where = item.target_name ?? item.target_host ?? item.target_id;
      const ok = window.confirm(
        t({
          en: `Approve this exact SSH command on ${where}?\n\n${item.command}`,
        }),
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDecide(item, approve);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const isSsh = item.kind === "ssh_command";
  const isEmail = item.kind === "business_email";
  const isProposal = item.kind === "task_proposal";
  const Icon = isEmail ? Mail : isSsh ? TerminalSquare : isProposal ? Lightbulb : Cpu;
  const kindLabel = isSsh
    ? t({ en: "SSH command" })
    : isEmail
      ? "Email to send"
      : isProposal
        ? t({ en: "Suggested task" })
        : item.kind === "record_change"
          ? t({ en: "Record change" })
          : item.kind === "code_push"
            ? t({ en: "Code push" })
            : item.kind === "listing_publish"
              ? t({ en: "Listing to publish" })
              : item.kind === "spend_request"
                ? t({ en: "Spending request" })
                : item.kind === "org_request"
                  ? t({ en: "Organization request" })
                  : t({ en: "Model upgrade" });
  const where = isSsh
    ? (item.target_name ?? item.target_host ?? item.target_id)
    : isProposal
      ? item.project_name
      : null;
  const heading =
    isProposal || item.kind === "listing_publish" || item.kind === "code_push"
      ? item.title
      : item.kind === "record_change"
        ? item.summary
        : item.task_title;

  return (
    <li className="flex items-start gap-3 px-5 py-3.5" style={{ borderBottom: "1px solid var(--th-border)" }}>
      <Icon
        size={15}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
        style={{ color: "var(--ax-signal)" }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          <span className="font-medium" style={{ color: "var(--th-text-secondary)" }}>
            {kindLabel}
          </span>
          {where && <span>{where}</span>}
          <span>· {item.agent_name ?? item.agent_id}</span>
          <span>· {timeAgo(item.created_at, localeTag)}</span>
          {item.client_tier && item.client_tier !== "normal" && (
            <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] font-medium text-amber-500">
              {item.client_tier === "vip" ? "VIP client" : "Important client"}
            </span>
          )}
          {item.untrusted_content && (
            <span
              className="rounded-full border border-red-500/50 px-1.5 text-[11px] font-medium text-red-500"
              title="The task behind this request read a web page or message that tried to give it instructions. Check it carefully."
            >
              Read suspicious content
            </span>
          )}
          {item.changes_client_tier && (
            <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] font-medium text-amber-500">
              Changes client importance
            </span>
          )}
          {item.deal_amount_minor ? (
            <span>
              · deal{" "}
              {item.deal_currency && item.deal_currency !== "MIXED"
                ? formatMoney(item.deal_amount_minor, item.deal_currency, localeTag)
                : "in several currencies"}
            </span>
          ) : null}
        </div>
        {heading && (
          <p
            className={`mt-1 text-[13px] ${isProposal ? "font-medium" : "truncate"}`}
            style={{ color: "var(--th-text-primary)" }}
          >
            {heading}
          </p>
        )}
        {isSsh ? (
          item.command !== null ? (
            <pre
              className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 font-mono text-[12px]"
              style={{
                background: "var(--th-bg-surface)",
                color: "var(--th-text-heading)",
                border: "1px solid var(--th-border)",
              }}
            >
              {item.command}
            </pre>
          ) : (
            <p className="mt-1 text-[12px]" style={{ color: "var(--ax-danger)" }}>
              {t({
                en: "The command can't be shown here. Review it in Homelab.",
              })}
            </p>
          )
        ) : item.kind === "task_proposal" ? (
          <div className="mt-1 space-y-1 text-[12.5px] leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {item.description && <p className="break-words">{item.description}</p>}
            {item.reason && (
              <p className="break-words" style={{ color: "var(--th-text-muted)" }}>
                {t({ en: "Why: " })}
                {item.reason}
              </p>
            )}
            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "Approving adds a planned task assigned to this agent. You start it when you want.",
              })}
            </p>
          </div>
        ) : item.kind === "business_email" ? (
          <div className="mt-2 space-y-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <p className="break-all">From: {item.sender}</p>
            <p className="break-all">To: {item.recipient}</p>
            <p className="break-words">Subject: {item.subject || "(no subject)"}</p>
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-sm"
              style={{ borderColor: "var(--th-border)" }}
            >
              {item.body}
            </pre>
            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              Approving sends this exact message once. No attachments or other recipients.
            </p>
          </div>
        ) : item.kind === "record_change" ? (
          <div className="mt-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {Object.entries(item.payload).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="break-words capitalize" style={{ color: "var(--th-text-muted)" }}>
                    {key.replaceAll("_", " ")}
                  </dt>
                  <dd className="break-words">
                    {item.current && key in item.current && item.current[key] !== value && (
                      <span className="line-through opacity-60">{String(item.current[key] ?? "empty")} </span>
                    )}
                    {typeof value === "object" ? JSON.stringify(value) : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
            {item.action === "delete" && (
              <p className="mt-1 text-xs" style={{ color: "var(--ax-danger)" }}>
                {t({
                  en: "Approving deletes this record.",
                })}
              </p>
            )}
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "This business requires approval before agents change its records. Approving applies exactly this.",
              })}
            </p>
          </div>
        ) : item.kind === "code_push" ? (
          <div className="mt-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <p className="break-words">
              {item.project_name ?? item.project_id} → <span className="font-mono">{item.github_repo}</span> (
              {item.branch})
            </p>
            <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: `Pushes with ${item.account_label ?? "the project's GitHub account"}${item.account_login ? ` (${item.account_login})` : ""} and opens a pull request to main. Nothing is merged.`,
              })}
            </p>
          </div>
        ) : item.kind === "listing_publish" ? (
          <div className="mt-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <p className="font-medium">
              {item.platform === "etsy" ? "Etsy" : "itch.io"} ·{" "}
              {formatMoney(item.price_minor, item.currency, localeTag)}
            </p>
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{item.description}</p>
            {item.tags.length > 0 && (
              <p className="mt-1 break-words text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {item.tags.join(", ")}
              </p>
            )}
            <p className="mt-1 break-words text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {[...item.files, ...item.mockups].join(" · ")}
            </p>
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {item.fee_minor > 0
                ? t({
                    en: `Publishing costs a ${formatMoney(item.fee_minor, item.fee_currency, localeTag)} platform fee${item.fee_over_budget ? ", which is outside this month's listing fee budget" : ""}. Approving does not publish it; you publish it from Ventures.`,
                  })
                : t({
                    en: "No platform fee. Approving does not publish it; you publish it from Ventures.",
                  })}
            </p>
          </div>
        ) : item.kind === "spend_request" ? (
          <div className="mt-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <p className="font-medium">
              {formatMoney(item.amount_minor, item.currency, localeTag)}
              {item.category ? (
                <span className="ml-2 text-xs font-normal" style={{ color: "var(--th-text-muted)" }}>
                  {item.category.replaceAll("_", " ")}
                  {item.within_spend_budget ? " · within budget" : ""}
                </span>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{item.purpose}</p>
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "Approval records permission only. It does not move money.",
              })}
            </p>
          </div>
        ) : item.kind === "org_request" ? (
          <div className="mt-2 text-sm" style={{ color: "var(--th-text-primary)" }}>
            <p>{item.org_kind.replaceAll("_", " ")}</p>
            <p className="mt-1 break-words">{item.reason}</p>
            <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
              {Object.entries(item.payload)
                .filter(([key]) => key !== "reason")
                .map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="break-words capitalize" style={{ color: "var(--th-text-muted)" }}>
                      {key.replaceAll("_", " ").replace(/ id$/, " ")}
                    </dt>
                    <dd className="break-words">
                      {typeof value === "object" ? JSON.stringify(value) : String(value).replaceAll("_", " ")}
                    </dd>
                  </div>
                ))}
            </dl>
          </div>
        ) : (
          <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            <span className="font-mono" style={{ color: "var(--th-text-heading)" }}>
              {item.requested_provider ? `${item.requested_provider} / ` : ""}
              {item.requested_model ?? "?"}
              {item.requested_reasoning_level ? ` · ${item.requested_reasoning_level}` : ""}
            </span>
            {item.reason ? ` — ${item.reason}` : ""}
          </p>
        )}
        {item.vp_review && (
          <div
            className="mt-3 border-l-2 pl-3 text-xs"
            style={{ borderColor: "var(--ax-signal)", color: "var(--th-text-secondary)" }}
          >
            <p className="font-medium">
              {t({ en: "VP review" })}: {item.vp_review.status}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words">{item.vp_review.reason}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1.5 text-[12px]" style={{ color: "var(--ax-danger)" }}>
            {error}
          </p>
        )}
        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          {isSsh && item.command === null ? (
            <button type="button" onClick={onOpenHomelab} className={buttonClass} style={quietStyle}>
              {t({ en: "Open Homelab" })}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(false)}
                className={buttonClass}
                style={quietStyle}
              >
                {isProposal ? t({ en: "Dismiss" }) : t({ en: "Deny" })}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(true)}
                className={`${buttonClass} ax-btn-primary`}
              >
                {isEmail
                  ? "Approve and send"
                  : isSsh
                    ? t({ en: "Approve once" })
                    : isProposal
                      ? t({ en: "Add to tasks" })
                      : t({ en: "Approve" })}
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
