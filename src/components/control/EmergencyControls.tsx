import { CirclePause, OctagonX, Play } from "lucide-react";
import { setControlMode, type ControlMode } from "../../api/control";
import { applyControlState, refreshControlState, setControlActivity, useControlState } from "../../app/controlStore";
import { useI18n } from "../../i18n";

type Translate = (en: string) => string;

function useTr(): Translate {
  const { t } = useI18n();
  return (en) => t({ en });
}

function confirmText(tr: Translate, target: ControlMode, from: ControlMode): string {
  if (target === "stopped") {
    return tr(
      "Stop everything now? Every running agent is paused and nothing can start until you resume. Work in progress is kept.",
    );
  }
  if (target === "autonomy_paused" && from === "running") {
    return tr("Pause autonomy? Work the agents started on their own stops. Work you started keeps going.");
  }
  if (target === "autonomy_paused") {
    return tr("Allow only work you start? Autonomy stays paused. Paused tasks do not restart by themselves.");
  }
  return tr("Resume? Paused tasks do not restart by themselves; resume them from Work when you are ready.");
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

  const error = state.failed ? tr("That did not go through. Check the connection to the server.") : null;

  return { mode: state.mode, busy: state.busy, error, change, tr };
}

const buttonBase =
  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium transition active:scale-[0.98] disabled:cursor-wait disabled:opacity-60";

/** The two emergency buttons. Rendered in the header, so they are reachable from every page and on phones. */
export function EmergencyButtons() {
  const { mode, busy, change, tr } = useControlActions();
  const pauseLabel = mode === "autonomy_paused" ? tr("Resume autonomy") : tr("Pause autonomy");
  const stopLabel = mode === "stopped" ? tr("Resume") : tr("Stop everything");

  return (
    <div className="flex items-center gap-1" role="group" aria-label={tr("Emergency controls")}>
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
                {stopped ? tr("Everything is stopped") : tr("Autonomy is paused")}
              </div>
              <div className="mt-0.5" style={{ color: "var(--th-text-secondary)" }}>
                {stopped
                  ? tr("No agent runs until you resume. Work that was in progress is paused and kept.")
                  : tr("Agents start nothing on their own. Work you start runs as normal.")}
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
                {tr("Resume my work only")}
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
              {stopped ? tr("Resume everything") : tr("Resume autonomy")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
