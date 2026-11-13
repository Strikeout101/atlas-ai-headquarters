import { useEffect, useRef, useState } from "react";
import type { OfficeViewProps } from "./office-view/model";
import { ReferenceOfficeScene } from "./office-view/ReferenceOfficeScene";
import VirtualPadOverlay from "./office-view/VirtualPadOverlay";
import CliUsagePanel from "./office-view/CliUsagePanel";
import { useCliUsage } from "./office-view/useCliUsage";
import { localeName, useI18n } from "../i18n";

/** The approved fixed-composition map, with the same data and callbacks as OfficeView. */
export default function ReferenceOfficeView(props: OfficeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ReferenceOfficeScene | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showVirtualPad, setShowVirtualPad] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [departmentsOpen, setDepartmentsOpen] = useState(false);
  const [interactionLabel, setInteractionLabel] = useState<string | null>(null);
  const { language, t } = useI18n();
  const { cliStatus, cliUsage, refreshing, handleRefreshUsage } = useCliUsage(props.tasks);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const scene = new ReferenceOfficeScene(
      element,
      latestPropsRef.current,
      (error) => {
        if (error) setLoadError(error);
        else setReady(true);
      },
      (label) => {
        setInteractionLabel(label);
        if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setInteractionLabel(null), 2200);
      },
    );
    sceneRef.current = scene;
    void scene.init();
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      scene.destroy();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.updateData(props);
  });

  useEffect(() => {
    const update = () => {
      setShowVirtualPad(window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 1024);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const overflow = props.agents.slice(10);

  return (
    <div className="w-full">
      <div
        className="relative w-full overflow-hidden rounded-lg bg-[#57a8e9]"
        style={{ aspectRatio: "1672 / 941", minHeight: 360 }}
      >
        <div ref={containerRef} className="absolute inset-0" aria-label="AI Office interactive map" />
        {!ready && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/60 text-sm text-white">
            Loading office map…
          </div>
        )}
        {loadError && (
          <div
            role="alert"
            className="absolute inset-0 flex items-center justify-center bg-slate-950/90 p-6 text-center text-sm text-white"
          >
            Office map could not load: {loadError}
          </div>
        )}
        {ready && (
          <>
            {interactionLabel && (
              <div
                role="status"
                className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-slate-950/85 px-3 py-2 text-xs text-white"
              >
                {interactionLabel}
              </div>
            )}
            <div className="absolute left-3 top-3 max-w-52 rounded-md bg-slate-950/80 text-white">
              <button
                type="button"
                aria-expanded={departmentsOpen}
                className="w-full px-3 py-2 text-left text-xs hover:bg-white/10 active:scale-[0.98]"
                onClick={() => setDepartmentsOpen((open) => !open)}
              >
                Departments
              </button>
              {departmentsOpen && (
                <div className="max-h-48 overflow-y-auto border-t border-white/20 p-1">
                  {props.departments.map((department) => (
                    <button
                      key={department.id}
                      type="button"
                      className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-white/10"
                      onClick={() => props.onSelectDepartment(department)}
                    >
                      {localeName(language, department)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md bg-slate-950/75 p-1 text-white">
              <button
                type="button"
                aria-label="Zoom out"
                className="rounded px-2 py-1 text-sm hover:bg-white/15 active:scale-95"
                onClick={() => sceneRef.current?.setZoom(sceneRef.current.getZoom() / 1.25)}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                className="rounded px-2 py-1 text-xs hover:bg-white/15 active:scale-95"
                onClick={() => sceneRef.current?.setZoom(1)}
              >
                Fit
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                className="rounded px-2 py-1 text-sm hover:bg-white/15 active:scale-95"
                onClick={() => sceneRef.current?.setZoom(sceneRef.current.getZoom() * 1.25)}
              >
                +
              </button>
            </div>
            {overflow.length > 0 && (
              <div className="absolute right-3 top-3 max-w-52 rounded-md bg-slate-950/80 text-white">
                <button
                  type="button"
                  aria-expanded={rosterOpen}
                  className="w-full px-3 py-2 text-left text-xs hover:bg-white/10 active:scale-[0.98]"
                  onClick={() => setRosterOpen((open) => !open)}
                >
                  {overflow.length} more agents
                </button>
                {rosterOpen && (
                  <div className="max-h-48 overflow-y-auto border-t border-white/20 p-1">
                    {overflow.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-white/10"
                        onClick={() => props.onSelectAgent(agent)}
                      >
                        {agent.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <VirtualPadOverlay
              showVirtualPad={showVirtualPad}
              t={t}
              onInteract={() => sceneRef.current?.interact()}
              onSetMoveDirectionPressed={(direction, pressed) =>
                sceneRef.current?.setMoveDirectionPressed(direction, pressed)
              }
            />
          </>
        )}
      </div>
      <CliUsagePanel
        cliStatus={cliStatus}
        cliUsage={cliUsage}
        language={language}
        refreshing={refreshing}
        onRefreshUsage={handleRefreshUsage}
        t={t}
      />
    </div>
  );
}
