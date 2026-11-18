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
          ko: `${where}에서 이 명령을 승인할까요?\n\n${item.command}`,
          en: `Approve this exact SSH command on ${where}?\n\n${item.command}`,
          ja: `${where} でこのコマンドを承認しますか？\n\n${item.command}`,
          zh: `批准在 ${where} 上运行此命令吗？\n\n${item.command}`,
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
    ? t({ ko: "SSH 명령", en: "SSH command", ja: "SSH コマンド", zh: "SSH 命令" })
    : isEmail
      ? "Email to send"
      : isProposal
        ? t({ ko: "제안된 업무", en: "Suggested task", ja: "提案されたタスク", zh: "建议的任务" })
        : item.kind === "record_change"
          ? t({ ko: "기록 변경", en: "Record change", ja: "記録の変更", zh: "记录更改" })
          : item.kind === "code_push"
            ? t({ ko: "코드 푸시", en: "Code push", ja: "コードのプッシュ", zh: "代码推送" })
            : item.kind === "listing_publish"
              ? t({ ko: "게시할 상품", en: "Listing to publish", ja: "公開する出品", zh: "待发布的商品" })
              : item.kind === "spend_request"
                ? t({ ko: "지출 요청", en: "Spending request", ja: "支出リクエスト", zh: "支出请求" })
                : item.kind === "org_request"
                  ? t({ ko: "조직 요청", en: "Organization request", ja: "組織リクエスト", zh: "组织请求" })
                  : t({ ko: "모델 업그레이드", en: "Model upgrade", ja: "モデルアップグレード", zh: "模型升级" });
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
                ko: "명령을 표시할 수 없습니다. 홈랩에서 확인하세요.",
                en: "The command can't be shown here. Review it in Homelab.",
                ja: "コマンドを表示できません。ホームラボで確認してください。",
                zh: "无法在此显示命令。请在家庭实验室中查看。",
              })}
            </p>
          )
        ) : item.kind === "task_proposal" ? (
          <div className="mt-1 space-y-1 text-[12.5px] leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {item.description && <p className="break-words">{item.description}</p>}
            {item.reason && (
              <p className="break-words" style={{ color: "var(--th-text-muted)" }}>
                {t({ ko: "이유: ", en: "Why: ", ja: "理由: ", zh: "原因：" })}
                {item.reason}
              </p>
            )}
            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "승인하면 이 에이전트에게 배정된 작업이 생성됩니다. 실행은 직접 시작합니다.",
                en: "Approving adds a planned task assigned to this agent. You start it when you want.",
                ja: "承認するとこのエージェントに割り当てられたタスクが作成されます。実行はいつでも開始できます。",
                zh: "批准后会创建一个分配给该代理的计划任务，由你决定何时开始。",
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
                  ko: "승인하면 이 기록이 삭제됩니다.",
                  en: "Approving deletes this record.",
                  ja: "承認するとこの記録は削除されます。",
                  zh: "批准后将删除此记录。",
                })}
              </p>
            )}
            <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "이 사업은 에이전트의 기록 변경에 승인이 필요합니다. 승인하면 그대로 적용됩니다.",
                en: "This business requires approval before agents change its records. Approving applies exactly this.",
                ja: "この事業ではエージェントによる記録変更に承認が必要です。承認するとこの内容が適用されます。",
                zh: "该业务要求代理更改记录前须经批准。批准后将按此内容执行。",
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
                ko: `${item.account_label ?? "GitHub 계정"}으로 푸시하고 main으로의 PR을 엽니다. 병합은 하지 않습니다.`,
                en: `Pushes with ${item.account_label ?? "the project's GitHub account"}${item.account_login ? ` (${item.account_login})` : ""} and opens a pull request to main. Nothing is merged.`,
                ja: `${item.account_label ?? "GitHub アカウント"}でプッシュし、main へのプルリクエストを開きます。マージはしません。`,
                zh: `使用 ${item.account_label ?? "GitHub 账户"} 推送并打开到 main 的拉取请求，不会合并。`,
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
                    ko: `게시하면 플랫폼 수수료 ${formatMoney(item.fee_minor, item.fee_currency, localeTag)}가 발생합니다${item.fee_over_budget ? " (이번 달 수수료 예산 초과)" : ""}. 승인해도 자동으로 게시되지 않습니다.`,
                    en: `Publishing costs a ${formatMoney(item.fee_minor, item.fee_currency, localeTag)} platform fee${item.fee_over_budget ? ", which is outside this month's listing fee budget" : ""}. Approving does not publish it; you publish it from Ventures.`,
                    ja: `公開にはプラットフォーム手数料 ${formatMoney(item.fee_minor, item.fee_currency, localeTag)} がかかります${item.fee_over_budget ? "（今月の手数料予算を超過）" : ""}。承認しても自動では公開されません。`,
                    zh: `发布需支付平台费用 ${formatMoney(item.fee_minor, item.fee_currency, localeTag)}${item.fee_over_budget ? "（超出本月费用预算）" : ""}。批准后不会自动发布。`,
                  })
                : t({
                    ko: "수수료가 없습니다. 승인해도 자동으로 게시되지 않습니다.",
                    en: "No platform fee. Approving does not publish it; you publish it from Ventures.",
                    ja: "手数料はありません。承認しても自動では公開されません。",
                    zh: "无平台费用。批准后不会自动发布。",
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
                ko: "승인은 권한만 기록하며 돈을 이동하지 않습니다.",
                en: "Approval records permission only. It does not move money.",
                ja: "承認は許可の記録のみです。送金は行いません。",
                zh: "批准仅记录许可，不会转移资金。",
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
              {t({ ko: "VP 검토", en: "VP review", ja: "VPレビュー", zh: "VP审核" })}: {item.vp_review.status}
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
              {t({ ko: "홈랩 열기", en: "Open Homelab", ja: "ホームラボを開く", zh: "打开家庭实验室" })}
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
                {isProposal
                  ? t({ ko: "넘기기", en: "Dismiss", ja: "見送る", zh: "忽略" })
                  : t({ ko: "거부", en: "Deny", ja: "拒否", zh: "拒绝" })}
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
                    ? t({ ko: "한 번 승인", en: "Approve once", ja: "一度だけ承認", zh: "批准一次" })
                    : isProposal
                      ? t({ ko: "업무에 추가", en: "Add to tasks", ja: "タスクに追加", zh: "添加到任务" })
                      : t({ ko: "승인", en: "Approve", ja: "承認", zh: "批准" })}
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
