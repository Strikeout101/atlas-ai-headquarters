import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { DecisionInboxRouteItem } from "./decision-inbox/types.ts";
import {
  createDecisionInboxMessengerBridge,
  type DecisionReplyBridgeInput,
  type DecisionReplyBridgeResult,
} from "./decision-inbox/messenger-bridge.ts";
import { handleTimeoutResumeDecisionReply } from "./decision-inbox/timeout-reply.ts";
import { buildReviewOwnerDecisionItems, buildTimeoutResumeDecisionItems } from "./decision-inbox/timeout-items.ts";
import { readYoloModeEnabled, runYoloDecisionAutopilot } from "./decision-inbox/yolo-mode.ts";
import { resolveReviewByOwner } from "../../../task-review.ts";
import { buildWorkDecisionItems } from "./decision-inbox/work-items.ts";
import { decideStrategy } from "../../../goal-strategy.ts";
import { approveInitiative, parkInitiative, resolveEscalation } from "../../../work-engine.ts";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../../security/auth.ts";

export type { DecisionReplyBridgeInput, DecisionReplyBridgeResult };

export type DecisionInboxRouteBridge = {
  tryHandleInboxDecisionReply: (input: DecisionReplyBridgeInput) => Promise<DecisionReplyBridgeResult>;
};

const REVIEW_ACTIONS: Record<string, string> = {
  review_accept: "accept",
  review_retry: "retry",
  review_drop: "drop",
};

export function registerDecisionInboxRoutes(ctx: RuntimeContext): DecisionInboxRouteBridge {
  const __ctx: RuntimeContext = ctx;
  const {
    app,
    db,
    nowMs,
    activeProcesses,
    appendTaskLog,
    getDeptName,
    getPreferredLanguage,
    l,
    pickL,
    normalizeTextField,
    startTaskExecutionForAgent,
  } = __ctx;

  function getDecisionInboxItems(): DecisionInboxRouteItem[] {
    const text = { db, nowMs, getPreferredLanguage, pickL, l };
    const items = [
      ...buildWorkDecisionItems(db),
      ...buildReviewOwnerDecisionItems(text),
      ...buildTimeoutResumeDecisionItems(text),
    ];
    items.sort((a, b) => b.created_at - a.created_at);
    return items;
  }

  function applyDecisionReply(
    decisionId: string,
    body: Record<string, unknown>,
  ): {
    status: number;
    payload: Record<string, unknown>;
  } {
    const optionNumber = Number(body.option_number ?? body.optionNumber ?? body.option);
    if (!Number.isFinite(optionNumber)) {
      return { status: 400, payload: { error: "option_number_required" } };
    }

    const currentItem = getDecisionInboxItems().find((item) => item.id === decisionId);
    if (!currentItem) {
      return { status: 404, payload: { error: "decision_not_found" } };
    }
    const selectedOption = currentItem.options.find((option) => option.number === optionNumber);
    if (!selectedOption) {
      if (currentItem.options.length <= 0) {
        return { status: 409, payload: { error: "decision_options_not_ready", kind: currentItem.kind } };
      }
      return { status: 400, payload: { error: "option_not_found", option_number: optionNumber } };
    }

    if (currentItem.kind === "review_owner" && currentItem.task_id) {
      const action = REVIEW_ACTIONS[selectedOption.action];
      if (!action) return { status: 400, payload: { error: "unknown_review_action" } };
      const taskId = currentItem.task_id;
      const notes = typeof body.note === "string" ? body.note : undefined;
      // Runs in the background: "one more go" starts the agent again.
      void resolveReviewByOwner(__ctx.reviewDeps, taskId, { action, notes }).catch((error) =>
        appendTaskLog(taskId, "error", `Owner's review decision failed: ${String(error)}`),
      );
      return { status: 200, payload: { ok: true, task_id: taskId, action } };
    }

    if (["strategy", "initiative_approval", "initiative_blocked"].includes(currentItem.kind)) {
      const entityId = decisionId.slice(decisionId.indexOf(":") + 1);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      try {
        if (selectedOption.action === "strategy_approve" || selectedOption.action === "strategy_redo") {
          decideStrategy(db, entityId, {
            decision: selectedOption.action === "strategy_approve" ? "approve" : "redo",
            note,
          });
        } else if (selectedOption.action === "initiative_approve") {
          const approved = approveInitiative(db, entityId);
          return {
            status: 200,
            payload: {
              ok: true,
              resolved: true,
              kind: currentItem.kind,
              action: selectedOption.action,
              queued: approved.status === "proposed",
            },
          };
        } else if (selectedOption.action === "initiative_defer") {
          parkInitiative(db, entityId);
        } else if (selectedOption.action.startsWith("initiative_")) {
          resolveEscalation(
            db,
            entityId,
            { action: selectedOption.action.slice("initiative_".length) as "retry" | "skip" | "stop", notes: note },
            "owner",
          );
        } else return { status: 400, payload: { error: "unknown_decision_action" } };
        return {
          status: 200,
          payload: { ok: true, resolved: true, kind: currentItem.kind, action: selectedOption.action },
        };
      } catch (error) {
        return { status: 400, payload: { error: error instanceof Error ? error.message : "decision_failed" } };
      }
    }

    let status = 200;
    let payload: Record<string, unknown> = { ok: true };
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: Record<string, unknown>) {
        payload = value;
        return this;
      },
    } as any;

    if (
      handleTimeoutResumeDecisionReply({
        res,
        currentItem,
        selectedOption,
        deps: {
          db,
          activeProcesses,
          getDeptName,
          appendTaskLog,
          startTaskExecutionForAgent,
        },
      })
    ) {
      return { status, payload };
    }

    return { status: 400, payload: { error: "unknown_decision_id" } };
  }

  const { tryHandleInboxDecisionReply, flushDecisionInboxMessengerNotices, startBackgroundNoticeSync } =
    createDecisionInboxMessengerBridge({
      db,
      nowMs,
      getPreferredLanguage,
      normalizeTextField,
      getDecisionInboxItems,
      applyDecisionReply,
    });

  startBackgroundNoticeSync();

  let yoloAutopilotInFlight = false;

  const runYoloAutopilot = () => {
    if (yoloAutopilotInFlight) return;
    if (!readYoloModeEnabled(db)) return;
    yoloAutopilotInFlight = true;
    try {
      runYoloDecisionAutopilot({
        getDecisionInboxItems,
        applyDecisionReply,
      });
    } catch (err) {
      console.warn(`[decision-yolo] autopilot failed: ${String(err)}`);
    } finally {
      yoloAutopilotInFlight = false;
    }
  };
  const yoloTimer = setInterval(runYoloAutopilot, 2500);
  (yoloTimer as NodeJS.Timeout).unref?.();
  setTimeout(runYoloAutopilot, 1200);

  // ---------------------------------------------------------------------------
  // Messages / Chat
  // ---------------------------------------------------------------------------
  app.get("/api/decision-inbox", (req, res) => {
    runYoloAutopilot();
    const forceRaw = String((req.query as Record<string, unknown>)?.force ?? "")
      .trim()
      .toLowerCase();
    const forceResend = forceRaw === "1" || forceRaw === "true" || forceRaw === "yes";
    const items = getDecisionInboxItems();
    void flushDecisionInboxMessengerNotices({ force: forceResend }).catch((err) => {
      console.warn(`[decision-messenger] on-demand notice flush failed: ${String(err)}`);
    });
    res.json({ items });
  });

  app.post("/api/decision-inbox/:id/reply", (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    const decisionId = String(req.params.id || "");
    const result = applyDecisionReply(decisionId, (req.body ?? {}) as Record<string, unknown>);
    runYoloAutopilot();
    return res.status(result.status).json(result.payload);
  });

  return {
    tryHandleInboxDecisionReply,
  };
}
