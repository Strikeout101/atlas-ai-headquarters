import { CirclePause, OctagonX, Play } from "lucide-react";
import { setControlMode, type ControlMode } from "../../api/control";
import { applyControlState, refreshControlState, setControlActivity, useControlState } from "../../app/controlStore";
import { useI18n } from "../../i18n";

type Translate = (ko: string, en: string, ja?: string, zh?: string) => string;

function useTr(): Translate {
  const { t } = useI18n();
  return (ko, en, ja = en, zh = en) => t({ ko, en, ja, zh });
}

function confirmText(tr: Translate, target: ControlMode, from: ControlMode): string {
  if (target === "stopped") {
    return tr(
      "모든 작업을 지금 멈출까요? 실행 중인 모든 에이전트가 일시정지되고, 다시 시작할 때까지 아무것도 실행되지 않습니다. 작업 내용은 보존됩니다.",
      "Stop everything now? Every running agent is paused and nothing can start until you resume. Work in progress is kept.",
      "すべてを今すぐ停止しますか？実行中のエージェントはすべて一時停止され、再開するまで何も開始されません。作業内容は保持されます。",
      "现在停止一切吗？所有运行中的代理将被暂停，在你恢复之前不会启动任何任务。进行中的工作会保留。",
    );
  }
  if (target === "autonomy_paused" && from === "running") {
    return tr(
      "자율 작업을 일시정지할까요? 에이전트가 스스로 시작한 작업은 멈추고, 직접 시작한 작업은 계속됩니다.",
      "Pause autonomy? Work the agents started on their own stops. Work you started keeps going.",
      "自律動作を一時停止しますか？エージェントが自ら始めた作業は止まり、あなたが始めた作業は続きます。",
      "暂停自主运行吗？代理自行开始的工作会停止，你启动的工作会继续。",
    );
  }
  if (target === "autonomy_paused") {
    return tr(
      "직접 시작한 작업만 다시 허용할까요? 자율 작업은 계속 일시정지됩니다. 멈춘 작업은 자동으로 다시 시작되지 않습니다.",
      "Allow only work you start? Autonomy stays paused. Paused tasks do not restart by themselves.",
      "あなたが始める作業だけを許可しますか？自律動作は停止したままです。停止したタスクは自動では再開されません。",
      "只允许你启动的工作吗？自主运行保持暂停。已暂停的任务不会自动重新开始。",
    );
  }
  return tr(
    "다시 시작할까요? 멈춘 작업은 자동으로 다시 시작되지 않으며, 작업 목록에서 직접 재개해야 합니다.",
    "Resume? Paused tasks do not restart by themselves; resume them from Work when you are ready.",
    "再開しますか？停止したタスクは自動では再開されません。準備ができたらWorkから再開してください。",
    "恢复吗？已暂停的任务不会自动重新开始；准备好后请在 Work 中恢复。",
  );
}

function useControlActions() {
  const state = useControlState();
  const tr = useTr();
  const change = async (target: ControlMode) => {
    if (state.busy) return;
    if (!window.confirm(confirmText(tr, target, state.mode))) return;
    setControlActivity({ busy: true, failed: false });
    try {
      const result = await setControlMode(target);
      applyControlState(result.state);
    } catch {
      setControlActivity({ failed: true });
      void refreshControlState();
    } finally {
      setControlActivity({ busy: false });
    }
  };

  const error = state.failed
    ? tr(
        "변경하지 못했습니다. 서버 연결을 확인하세요.",
        "That did not go through. Check the connection to the server.",
        "変更できませんでした。サーバーへの接続を確認してください。",
        "未能完成。请检查与服务器的连接。",
      )
    : null;

  return { mode: state.mode, busy: state.busy, error, change, tr };
}

const buttonBase =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60";

/** The two emergency buttons. Rendered in the header, so they are reachable from every page and on phones. */
export function EmergencyButtons() {
  const { mode, busy, change, tr } = useControlActions();
  const pauseLabel =
    mode === "autonomy_paused"
      ? tr("자율 재개", "Resume autonomy", "自律を再開", "恢复自主")
      : tr("자율 일시정지", "Pause autonomy", "自律を一時停止", "暂停自主");
  const stopLabel =
    mode === "stopped"
      ? tr("다시 시작", "Resume", "再開", "恢复")
      : tr("모두 정지", "Stop everything", "すべて停止", "全部停止");

  return (
    <div className="flex items-center gap-1" role="group" aria-label={tr("비상 제어", "Emergency controls")}>
      {mode !== "stopped" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void change(mode === "autonomy_paused" ? "running" : "autonomy_paused")}
          className={buttonBase}
          aria-label={pauseLabel}
          aria-pressed={mode === "autonomy_paused"}
          title={pauseLabel}
          style={
            mode === "autonomy_paused"
              ? { border: "1px solid var(--ax-signal)", background: "var(--ax-signal-soft)", color: "var(--ax-signal)" }
              : {
                  border: "1px solid var(--th-border)",
                  background: "var(--th-bg-surface)",
                  color: "var(--th-text-secondary)",
                }
          }
        >
          {mode === "autonomy_paused" ? (
            <Play size={15} strokeWidth={1.75} />
          ) : (
            <CirclePause size={15} strokeWidth={1.75} />
          )}
          <span className="hidden xl:inline">{pauseLabel}</span>
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void change(mode === "stopped" ? "running" : "stopped")}
        className={buttonBase}
        aria-label={stopLabel}
        aria-pressed={mode === "stopped"}
        title={stopLabel}
        style={
          mode === "stopped"
            ? { border: "1px solid var(--ax-danger)", background: "var(--ax-danger)", color: "#fff" }
            : { border: "1px solid var(--ax-danger)", background: "transparent", color: "var(--ax-danger)" }
        }
      >
        {mode === "stopped" ? <Play size={15} strokeWidth={1.75} /> : <OctagonX size={15} strokeWidth={1.75} />}
        <span className="hidden xl:inline">{stopLabel}</span>
      </button>
    </div>
  );
}

/** Shown under the header on every page while anything is held back, so the state is never a surprise. */
export function EmergencyBanner() {
  const { mode, busy, error, change, tr } = useControlActions();
  if (mode === "running" && !error) return null;
  const stopped = mode === "stopped";
  const tone = stopped ? "var(--ax-danger)" : "var(--ax-signal)";
  const actionClass =
    "rounded-md px-2.5 py-1 text-xs font-medium transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60";

  return (
    <div
      role="status"
      aria-live="polite"
      className="px-3 py-2.5 sm:px-4 lg:px-6"
      style={{
        borderBottom: `1px solid ${tone}`,
        background: stopped ? "color-mix(in srgb, var(--ax-danger) 14%, transparent)" : "var(--ax-signal-soft)",
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs" style={{ color: "var(--th-text-primary)" }}>
          {mode !== "running" && (
            <>
              <div className="font-semibold" style={{ color: tone }}>
                {stopped
                  ? tr("모두 정지됨", "Everything is stopped", "すべて停止中", "已全部停止")
                  : tr("자율 일시정지됨", "Autonomy is paused", "自律は一時停止中", "自主运行已暂停")}
              </div>
              <div className="mt-0.5" style={{ color: "var(--th-text-secondary)" }}>
                {stopped
                  ? tr(
                      "다시 시작할 때까지 어떤 에이전트도 실행되지 않습니다. 진행 중이던 작업은 일시정지 상태로 보존됩니다.",
                      "No agent runs until you resume. Work that was in progress is paused and kept.",
                      "再開するまでエージェントは動きません。進行中だった作業は一時停止のまま保持されます。",
                      "在你恢复之前不会运行任何代理。进行中的工作已暂停并保留。",
                    )
                  : tr(
                      "에이전트가 스스로 작업을 시작하지 않습니다. 직접 시작한 작업은 정상적으로 실행됩니다.",
                      "Agents start nothing on their own. Work you start runs as normal.",
                      "エージェントは自分から作業を始めません。あなたが始めた作業は通常どおり動きます。",
                      "代理不会自行开始任何工作。你启动的工作照常运行。",
                    )}
              </div>
            </>
          )}
          {error && (
            <div className="mt-0.5 font-medium" style={{ color: "var(--ax-danger)" }}>
              {error}
            </div>
          )}
        </div>
        {mode !== "running" && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {stopped && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void change("autonomy_paused")}
                className={actionClass}
                style={{ border: "1px solid var(--th-border)", color: "var(--th-text-primary)" }}
              >
                {tr("내 작업만 재개", "Resume my work only", "自分の作業だけ再開", "仅恢复我的工作")}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void change("running")}
              className={actionClass}
              style={{
                border: `1px solid ${tone}`,
                background: tone,
                color: stopped ? "#fff" : "var(--ax-signal-ink)",
              }}
            >
              {stopped
                ? tr("모두 재개", "Resume everything", "すべて再開", "全部恢复")
                : tr("자율 재개", "Resume autonomy", "自律を再開", "恢复自主")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
