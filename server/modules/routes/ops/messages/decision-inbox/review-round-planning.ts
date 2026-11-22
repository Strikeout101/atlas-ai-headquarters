import { TEAM_VOICE } from "../../../../agent-knowledge.ts";
import type { ReviewRoundPlanningDeps, ReviewRoundPlanningHelpers } from "./types.ts";

export function createReviewRoundPlanningHelpers(deps: ReviewRoundPlanningDeps): ReviewRoundPlanningHelpers {
  const {
    db,
    nowMs,
    l,
    pickL,
    findTeamLeader,
    runAgentOneShot,
    chooseSafeReply,
    getAgentDisplayName,
    getReviewRoundDecisionState,
    formatPlannerSummaryForDisplay,
    recordProjectReviewDecisionEvent,
    getProjectReviewDecisionState,
  } = deps;
  const reviewRoundDecisionConsolidationInFlight = new Set<string>();

  function buildReviewRoundPlanningFallbackSummary(
    lang: string,
    taskTitle: string,
    reviewRound: number,
    optionNotes: string[],
    projectName?: string | null,
  ): string {
    const clip = (text: string, max = 240) => {
      const normalized = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) return "";
      return normalized.length > max ? `${normalized.slice(0, max - 3).trimEnd()}...` : normalized;
    };
    const lines = optionNotes
      .slice(0, 6)
      .map((note, idx) => `${idx + 1}. ${clip(note)}`)
      .filter(Boolean);
    const optionBlock = lines.length > 0 ? lines.join("\n") : pickL(l(["- No round opinions to consolidate."]), lang);
    return pickL(
      l([
        `Planning lead pre-consolidated round ${reviewRound} opinions.\nTask: '${taskTitle}'\n${projectName ? `Project: '${projectName}'\n` : ""}Pick the highest-priority remediation options first, and add an extra note only when needed.\n\nCandidate options:\n${optionBlock}`,
      ]),
      lang,
    );
  }

  function queueReviewRoundPlanningConsolidation(input: {
    projectId: string | null;
    projectName: string | null;
    projectPath: string | null;
    taskId: string;
    taskTitle: string;
    meetingId: string;
    reviewRound: number;
    optionNotes: string[];
    snapshotHash: string;
    lang: string;
  }): void {
    const inFlightKey = `${input.meetingId}:${input.snapshotHash}`;
    if (reviewRoundDecisionConsolidationInFlight.has(inFlightKey)) return;
    reviewRoundDecisionConsolidationInFlight.add(inFlightKey);

    void (async () => {
      try {
        const currentState = getReviewRoundDecisionState(input.meetingId);
        if (!currentState || currentState.snapshot_hash !== input.snapshotHash) return;
        if (currentState.status !== "collecting") return;

        const planningLeader = findTeamLeader("planning");
        const clip = (text: string, max = 240) => {
          const normalized = String(text ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (!normalized) return "-";
          return normalized.length > max ? `${normalized.slice(0, max - 3).trimEnd()}...` : normalized;
        };
        const fallbackSummary = buildReviewRoundPlanningFallbackSummary(
          input.lang,
          input.taskTitle,
          input.reviewRound,
          input.optionNotes,
          input.projectName,
        );

        let plannerSummary = fallbackSummary;
        if (planningLeader) {
          const sourceBlock =
            input.optionNotes.length > 0
              ? input.optionNotes.map((note, idx) => `${idx + 1}) ${clip(note, 1200)}`).join("\n")
              : pickL(l(["- No round opinions"]), input.lang);
          const prompt = [
            `You are the planning lead (${planningLeader.name}).`,
            `Task: '${input.taskTitle}'`,
            `Review round: ${input.reviewRound}`,
            input.projectName ? `Project: '${input.projectName}'` : "Project: (none)",
            `Language: ${input.lang}`,
            "Every option is written out in full below. Do not open or read anything else; answer straight away.",
            "Goal:",
            "- In a line or two each, say what each team wants.",
            "- Recommend which option numbers the owner should pick (several are fine), or say SKIP, and why in one sentence.",
            TEAM_VOICE,
            "",
            "Round option sources:",
            sourceBlock,
          ].join("\n");
          try {
            const run = await runAgentOneShot(planningLeader, prompt, {
              projectPath: input.projectPath || process.cwd(),
              timeoutMs: 90_000,
              noTools: true,
            });
            const preferred = String(chooseSafeReply(run, input.lang, "summary", planningLeader) || "").trim();
            const raw = String(run?.text || "").trim();
            const merged = preferred || raw;
            if (merged) {
              const clipped = merged.length > 1800 ? `${merged.slice(0, 1797).trimEnd()}...` : merged;
              plannerSummary = formatPlannerSummaryForDisplay(clipped);
            }
          } catch {
            plannerSummary = fallbackSummary;
          }
        }
        plannerSummary = formatPlannerSummaryForDisplay(plannerSummary);

        const updateResult = db
          .prepare(
            `
          UPDATE review_round_decision_states
          SET status = 'ready',
              planner_summary = ?,
              planner_agent_id = ?,
              planner_agent_name = ?,
              updated_at = ?
          WHERE meeting_id = ?
            AND snapshot_hash = ?
            AND status = 'collecting'
        `,
          )
          .run(
            plannerSummary,
            planningLeader?.id ?? null,
            planningLeader ? getAgentDisplayName(planningLeader, input.lang) : null,
            nowMs(),
            input.meetingId,
            input.snapshotHash,
          ) as { changes?: number } | undefined;

        if ((updateResult?.changes ?? 0) > 0 && input.projectId) {
          recordProjectReviewDecisionEvent({
            project_id: input.projectId,
            snapshot_hash: getProjectReviewDecisionState(input.projectId)?.snapshot_hash ?? null,
            event_type: "planning_summary",
            summary: pickL(l([`Round ${input.reviewRound} planning consolidation\n${plannerSummary}`]), input.lang),
            task_id: input.taskId,
            meeting_id: input.meetingId,
          });
        }
      } catch {
        const failMsg = pickL(
          l(["Review-round planning consolidation is temporarily delayed. Auto retry in progress."]),
          input.lang,
        );
        const ts = nowMs();
        db.prepare(
          `
          UPDATE review_round_decision_states
          SET status = 'failed',
              planner_summary = ?,
              updated_at = ?
          WHERE meeting_id = ?
            AND snapshot_hash = ?
        `,
        ).run(failMsg, ts, input.meetingId, input.snapshotHash);
      } finally {
        reviewRoundDecisionConsolidationInFlight.delete(inFlightKey);
      }
    })();
  }

  return {
    queueReviewRoundPlanningConsolidation,
  };
}
