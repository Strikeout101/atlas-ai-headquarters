import { bootstrapSession, post, request } from "./core";

/** The owner's emergency controls. `autonomy_paused` stops self-started agent work; `stopped` stops all of it. */
export type ControlMode = "running" | "autonomy_paused" | "stopped";

export interface ControlState {
  mode: ControlMode;
  changed_at: number;
  reason: string | null;
}

export interface ControlChangeResult {
  ok: boolean;
  state: ControlState;
  paused_tasks: number;
  aborted_calls: number;
}

export async function getControlState(): Promise<ControlState> {
  const res = await request<{ ok: boolean; state: ControlState }>("/api/control");
  return res.state;
}

export async function setControlMode(mode: ControlMode): Promise<ControlChangeResult> {
  await bootstrapSession({ promptOnUnauthorized: false });
  return post<ControlChangeResult>("/api/control", { mode });
}
