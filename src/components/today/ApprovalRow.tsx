import { useState } from "react";
import { Cpu, TerminalSquare } from "lucide-react";
import type { PendingApproval } from "../../api";
import { useI18n } from "../../i18n";
import { timeAgo } from "../dashboard/model";

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

/** One SSH command or model upgrade waiting on the owner, decided in place. */
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
  const Icon = isSsh ? TerminalSquare : Cpu;
  const kindLabel = isSsh
    ? t({ ko: "SSH 명령", en: "SSH command", ja: "SSH コマンド", zh: "SSH 命令" })
    : t({ ko: "모델 업그레이드", en: "Model upgrade", ja: "モデルアップグレード", zh: "模型升级" });
  const where = isSsh ? (item.target_name ?? item.target_host ?? item.target_id) : null;

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
        </div>
        {item.task_title && (
          <p className="mt-1 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
            {item.task_title}
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
        ) : (
          <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            <span className="font-mono" style={{ color: "var(--th-text-heading)" }}>
              {item.requested_model ?? "?"}
              {item.requested_reasoning_level ? ` · ${item.requested_reasoning_level}` : ""}
            </span>
            {item.reason ? ` — ${item.reason}` : ""}
          </p>
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
                {t({ ko: "거부", en: "Deny", ja: "拒否", zh: "拒绝" })}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void decide(true)}
                className={`${buttonClass} ax-btn-primary`}
              >
                {isSsh
                  ? t({ ko: "한 번 승인", en: "Approve once", ja: "一度だけ承認", zh: "批准一次" })
                  : t({ ko: "승인", en: "Approve", ja: "承認", zh: "批准" })}
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}
