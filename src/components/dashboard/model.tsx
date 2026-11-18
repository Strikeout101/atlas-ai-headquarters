import { useEffect, useRef, useState } from "react";
import type { UiLanguage } from "../../i18n";
import type { AgentStatus, TaskStatus } from "../../types";

export type Locale = UiLanguage;
export type TFunction = (messages: Record<Locale, string>) => string;

export function useNow(localeTag: string) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const date = now.toLocaleDateString(localeTag, { weekday: "long", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString(localeTag, { hour: "2-digit", minute: "2-digit", hour12: false });

  return { date, time };
}

export function timeAgo(timestamp: number, localeTag: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const rtf = new Intl.RelativeTimeFormat(localeTag, { numeric: "auto", style: "short" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.floor(hours / 24), "day");
}

/** CSS color token for each task status. */
export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  inbox: "var(--ax-muted)",
  planned: "var(--ax-planned)",
  collaborating: "var(--ax-planned)",
  in_progress: "var(--ax-signal)",
  review: "var(--ax-review)",
  done: "var(--ax-done)",
  pending: "var(--ax-break)",
  cancelled: "var(--ax-danger)",
};

/** CSS color token for each agent status. */
export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  working: "var(--ax-working)",
  break: "var(--ax-break)",
  idle: "var(--ax-idle)",
  offline: "var(--ax-offline)",
};

export const AGENT_STATUS_ORDER: AgentStatus[] = ["working", "break", "idle", "offline"];

export function agentStatusLabel(status: AgentStatus, t: TFunction) {
  switch (status) {
    case "working":
      return t({ en: "Working" });
    case "break":
      return t({ en: "On break" });
    case "idle":
      return t({ en: "Idle" });
    case "offline":
      return t({ en: "Offline" });
  }
}

export function taskStatusLabel(status: string, t: TFunction) {
  switch (status) {
    case "inbox":
      return t({ en: "Inbox" });
    case "planned":
      return t({ en: "Planned" });
    case "collaborating":
      return t({ en: "Collaborating" });
    case "in_progress":
      return t({ en: "In progress" });
    case "review":
      return t({ en: "Review" });
    case "done":
      return t({ en: "Done" });
    case "pending":
      return t({ en: "On hold" });
    case "cancelled":
      return t({ en: "Cancelled" });
    default:
      return status;
  }
}

/** Animates a number from its previous value to the next; instant when reduced motion is preferred. */
export function CountUp({ value, format }: { value: number; format: Intl.NumberFormat }) {
  const [shown, setShown] = useState(0);
  const fromRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = value;
    if (from === value || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const duration = 650;
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{format.format(shown)}</>;
}
