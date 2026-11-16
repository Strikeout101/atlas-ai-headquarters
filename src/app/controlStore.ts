import { useEffect, useSyncExternalStore } from "react";
import { getControlState, type ControlMode, type ControlState } from "../api/control";

/**
 * One shared copy of the emergency-control state, so the header buttons and the banner always agree.
 * It is filled from the server on load and kept current by the `control_state` live event.
 */
export interface ControlSnapshot extends ControlState {
  /** A change is being sent to the server. */
  busy: boolean;
  /** The last change failed; shown in the banner until the next attempt. */
  failed: boolean;
}

let current: ControlSnapshot = { mode: "running", changed_at: 0, reason: null, busy: false, failed: false };
let loaded = false;
const listeners = new Set<() => void>();

function isMode(value: unknown): value is ControlMode {
  return value === "running" || value === "autonomy_paused" || value === "stopped";
}

export function applyControlState(next: unknown): void {
  const candidate = next as Partial<ControlState> | null;
  if (!candidate || !isMode(candidate.mode)) return;
  current = {
    ...current,
    mode: candidate.mode,
    changed_at: Number(candidate.changed_at ?? 0) || 0,
    reason: typeof candidate.reason === "string" && candidate.reason ? candidate.reason : null,
  };
  loaded = true;
  listeners.forEach((listener) => listener());
}

export async function refreshControlState(): Promise<void> {
  try {
    applyControlState(await getControlState());
  } catch {
    /* Keep the last known state; the live event or the next refresh corrects it. */
  }
}

export function setControlActivity(patch: Partial<Pick<ControlSnapshot, "busy" | "failed">>): void {
  current = { ...current, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useControlState(): ControlSnapshot {
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
  useEffect(() => {
    if (!loaded) void refreshControlState();
  }, []);
  return state;
}

/** Tests only. */
export function resetControlStoreForTests(): void {
  current = { mode: "running", changed_at: 0, reason: null, busy: false, failed: false };
  loaded = false;
  listeners.clear();
}
