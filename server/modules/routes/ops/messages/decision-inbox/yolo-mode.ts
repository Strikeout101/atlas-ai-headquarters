import type { DatabaseSync } from "node:sqlite";
import { isAutonomyAllowed } from "../../../../control-state.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

export type DecisionApplyResult = {
  status: number;
  payload: Record<string, unknown>;
};

export type YoloDecisionReplyPayload = {
  option_number: number;
  selected_option_numbers?: number[];
};

const RETRYABLE_DECISION_ERRORS = new Set<string>([
  "decision_options_not_ready",
  "option_not_found",
  "project_task_options_pending",
  "project_not_ready_for_review_meeting",
  "meeting_not_pending",
  "task_not_in_review",
]);
const RETRYABLE_ERROR_MAX_ATTEMPTS_PER_DECISION = 6;

function normalizeBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(text)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(text)) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "number") return parsed !== 0;
  } catch {
    // ignore JSON parse errors
  }
  return null;
}

export function readYoloModeEnabled(db: Pick<DatabaseSync, "prepare">): boolean {
  // Auto-answering decisions is the agents acting for the owner, so it stops with autonomy.
  if (!isAutonomyAllowed()) return false;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'yoloMode' LIMIT 1").get() as
    | { value?: unknown }
    | undefined;
  return normalizeBooleanLike(row?.value) === true;
}

export function buildYoloDecisionReplyPayload(item: DecisionInboxRouteItem): YoloDecisionReplyPayload | null {
  if (!Array.isArray(item.options) || item.options.length <= 0) return null;

  if (item.kind === "task_timeout_resume") {
    const resume = item.options.find((option) => option.action === "resume_timeout_task") ?? item.options[0];
    return resume ? { option_number: resume.number } : null;
  }

  // A review the VPs passed to the owner is never auto-decided.
  return null;
}

export function runYoloDecisionAutopilot(input: {
  getDecisionInboxItems: () => DecisionInboxRouteItem[];
  applyDecisionReply: (decisionId: string, body: Record<string, unknown>) => DecisionApplyResult;
  maxSteps?: number;
  shouldSkipItem?: (item: DecisionInboxRouteItem) => boolean;
}): number {
  const maxSteps = Math.max(1, Math.min(Math.trunc(input.maxSteps ?? 24), 120));
  const failedDecisionIds = new Set<string>();
  const retryableAttemptCountByDecisionId = new Map<string, number>();
  let appliedCount = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const items = input
      .getDecisionInboxItems()
      .slice()
      .sort((a, b) => a.created_at - b.created_at)
      .filter((item) => !failedDecisionIds.has(item.id))
      .filter((item) => !(input.shouldSkipItem?.(item) ?? false));

    let chosen: { id: string; payload: YoloDecisionReplyPayload } | null = null;
    for (const item of items) {
      const payload = buildYoloDecisionReplyPayload(item);
      if (!payload) continue;
      chosen = { id: item.id, payload };
      break;
    }

    if (!chosen) break;

    const result = input.applyDecisionReply(chosen.id, chosen.payload);
    if (result.status >= 400) {
      const errorCode = String((result.payload as { error?: unknown } | null | undefined)?.error ?? "").trim();
      if (errorCode && RETRYABLE_DECISION_ERRORS.has(errorCode)) {
        const attempt = (retryableAttemptCountByDecisionId.get(chosen.id) ?? 0) + 1;
        if (attempt >= RETRYABLE_ERROR_MAX_ATTEMPTS_PER_DECISION) {
          failedDecisionIds.add(chosen.id);
          retryableAttemptCountByDecisionId.delete(chosen.id);
        } else {
          retryableAttemptCountByDecisionId.set(chosen.id, attempt);
        }
        continue;
      }
      retryableAttemptCountByDecisionId.delete(chosen.id);
      failedDecisionIds.add(chosen.id);
      continue;
    }

    retryableAttemptCountByDecisionId.delete(chosen.id);
    appliedCount += 1;
  }

  return appliedCount;
}
