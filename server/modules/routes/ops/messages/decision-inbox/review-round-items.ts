import type { ReviewRoundDecisionItem, ReviewRoundDecisionItemDeps, ReviewRoundDecisionItems } from "./types.ts";

const DECISION_COLLECTING_STALE_MS = 20_000;

export function createReviewRoundDecisionItems(deps: ReviewRoundDecisionItemDeps): ReviewRoundDecisionItems {
  const {
    db,
    nowMs,
    getPreferredLanguage,
    pickL,
    l,
    buildReviewRoundSnapshotHash,
    getReviewRoundDecisionState,
    upsertReviewRoundDecisionState,
    resolvePlanningLeadMeta,
    formatPlannerSummaryForDisplay,
    queueReviewRoundPlanningConsolidation,
  } = deps;

  function getReviewDecisionFallbackLabel(lang: string): string {
    return pickL(l(["Continue Existing Work"]), lang);
  }

  function getReviewDecisionNotes(taskId: string, reviewRound: number, limit = 6): string[] {
    const boundedLimit = Math.max(1, Math.min(limit, 12));
    const rawRows = db
      .prepare(
        `
      SELECT raw_note
      FROM review_revision_history
      WHERE task_id = ?
        AND first_round <= ?
      ORDER BY
        CASE WHEN first_round = ? THEN 0 ELSE 1 END ASC,
        first_round DESC,
        id DESC
      LIMIT ?
    `,
      )
      .all(taskId, reviewRound, reviewRound, Math.max(boundedLimit * 3, boundedLimit)) as Array<{
      raw_note: string | null;
    }>;
    // The transcript of this round, to restore notes that were saved cut short ("…").
    const entries = db
      .prepare(
        `SELECT e.department_name, e.speaker_name, e.content FROM meeting_minute_entries e
         JOIN meeting_minutes m ON m.id = e.meeting_id
         WHERE m.task_id = ? AND m.meeting_type = 'review' AND m.round = ? ORDER BY e.seq`,
      )
      .all(taskId, reviewRound) as Array<{ department_name: string | null; speaker_name: string; content: string }>;
    const restore = (note: string) => {
      if (!note.endsWith("…")) return note;
      const head = note.slice(0, -1).trimEnd();
      for (const entry of entries) {
        const full = `${entry.department_name ?? ""} ${entry.speaker_name}: ${String(entry.content).replace(/\s+/g, " ").trim()}`;
        if (full.startsWith(head) && full.length > head.length) return full;
      }
      return note;
    };
    // Newest first: the first note seen for a speaker is their latest stance, so each speaker is offered once.
    const out: string[] = [];
    const seen = new Set<string>();
    const speakers = new Set<string>();
    for (const row of rawRows) {
      const normalized = String(row.raw_note ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const speaker = normalized.match(/^([^:]{1,80}):/)?.[1]?.toLowerCase();
      if (speaker) {
        if (speakers.has(speaker)) continue;
        speakers.add(speaker);
      }
      out.push(restore(normalized));
      if (out.length >= limit) break;
    }
    return out;
  }

  function buildReviewRoundDecisionItems(): ReviewRoundDecisionItem[] {
    const lang = getPreferredLanguage();
    const t = (en: string) => pickL(l([en]), lang);
    const rows = db
      .prepare(
        `
      SELECT
        t.id AS task_id,
        t.title AS task_title,
        t.project_id AS project_id,
        p.name AS project_name,
        t.project_path AS project_path,
        mm.id AS meeting_id,
        mm.round AS meeting_round,
        mm.started_at AS meeting_started_at,
        mm.completed_at AS meeting_completed_at
      FROM tasks t
      JOIN meeting_minutes mm ON mm.task_id = t.id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'review'
        AND t.source_task_id IS NULL
        AND mm.meeting_type = 'review'
        AND mm.round IN (1, 2)
        AND mm.status = 'revision_requested'
        AND mm.id = (
          SELECT mm2.id
          FROM meeting_minutes mm2
          WHERE mm2.task_id = t.id
            AND mm2.meeting_type = 'review'
          ORDER BY mm2.started_at DESC, mm2.created_at DESC
          LIMIT 1
        )
      ORDER BY COALESCE(mm.completed_at, mm.started_at) DESC
      LIMIT 120
    `,
      )
      .all() as Array<{
      task_id: string;
      task_title: string | null;
      project_id: string | null;
      project_name: string | null;
      project_path: string | null;
      meeting_id: string;
      meeting_round: number;
      meeting_started_at: number | null;
      meeting_completed_at: number | null;
    }>;

    const out: ReviewRoundDecisionItem[] = [];
    for (const row of rows) {
      const notesRaw = getReviewDecisionNotes(row.task_id, row.meeting_round, 6);
      const notes = notesRaw.length > 0 ? notesRaw : [getReviewDecisionFallbackLabel(lang)];

      const taskTitle = (row.task_title || row.task_id).trim();
      const projectName = row.project_name ? row.project_name.trim() : null;
      const nextRound = Math.max(2, row.meeting_round + 1);
      const options = notes.map((note, index) => {
        return {
          number: index + 1,
          action: "apply_review_pick",
          label: note,
        };
      });
      options.push({
        number: notes.length + 1,
        action: "skip_to_next_round",
        label: t("Skip to Next Round"),
      });

      const summary = t(
        `The team leads reviewed '${taskTitle}'${projectName ? ` (${projectName})` : ""} and want some changes (round ${row.meeting_round}).\nPick the ones you want made, as many as you like, add a note if you want, then press Run Selected.\nOr skip straight to round ${nextRound}.`,
      );

      const snapshotHash = buildReviewRoundSnapshotHash(row.meeting_id, row.meeting_round, notes);
      const existingState = getReviewRoundDecisionState(row.meeting_id);
      const now = nowMs();
      const stateNeedsReset = !existingState || existingState.snapshot_hash !== snapshotHash;
      if (stateNeedsReset) {
        upsertReviewRoundDecisionState(row.meeting_id, snapshotHash, "collecting", null, null, null);
      } else if (existingState.status === "failed" && now - (existingState.updated_at ?? 0) > 3000) {
        upsertReviewRoundDecisionState(row.meeting_id, snapshotHash, "collecting", null, null, null);
      }
      const decisionState = getReviewRoundDecisionState(row.meeting_id);
      const planningLeadMeta = resolvePlanningLeadMeta(lang, decisionState);
      const collectingElapsedMs =
        decisionState?.status === "collecting"
          ? now - (decisionState.updated_at ?? decisionState.created_at ?? now)
          : 0;
      const useCollectingFallback = Boolean(
        decisionState && decisionState.status === "collecting" && collectingElapsedMs >= DECISION_COLLECTING_STALE_MS,
      );
      if (!decisionState || (decisionState.status !== "ready" && !useCollectingFallback)) {
        queueReviewRoundPlanningConsolidation({
          projectId: row.project_id,
          projectName: row.project_name,
          projectPath: row.project_path,
          taskId: row.task_id,
          taskTitle,
          meetingId: row.meeting_id,
          reviewRound: row.meeting_round,
          optionNotes: notes,
          snapshotHash,
          lang,
        });
        const collectingSummary = t(
          `The team leads reviewed '${taskTitle}'${projectName ? ` (${projectName})` : ""} and want some changes (round ${row.meeting_round}).\nThe planning lead is reading their notes and will suggest which to pick in a moment.`,
        );
        out.push({
          id: `review-round-pick:${row.task_id}:${row.meeting_id}`,
          kind: "review_round_pick",
          created_at: row.meeting_completed_at ?? row.meeting_started_at ?? now,
          summary: collectingSummary,
          agent_id: planningLeadMeta.agent_id,
          agent_name: planningLeadMeta.agent_name,
          agent_name_ko: planningLeadMeta.agent_name_ko,
          agent_avatar: planningLeadMeta.agent_avatar,
          project_id: row.project_id,
          project_name: row.project_name,
          project_path: row.project_path,
          task_id: row.task_id,
          task_title: row.task_title,
          meeting_id: row.meeting_id,
          review_round: row.meeting_round,
          options: [],
        });
        continue;
      }

      const plannerHeader = useCollectingFallback
        ? t("The planning lead's suggestion is taking a while, so here are the notes as they are.")
        : t(`${planningLeadMeta.agent_name ?? "Planning lead"}'s take:`);
      const plannerSummary = useCollectingFallback
        ? ""
        : formatPlannerSummaryForDisplay(String(decisionState?.planner_summary ?? "").trim());
      // The options are the buttons below the message; listing them here too showed every option twice.
      const combinedSummary = plannerSummary
        ? `${summary}\n\n${plannerHeader}\n${plannerSummary}`
        : `${summary}\n\n${plannerHeader}`;

      out.push({
        id: `review-round-pick:${row.task_id}:${row.meeting_id}`,
        kind: "review_round_pick",
        created_at: row.meeting_completed_at ?? row.meeting_started_at ?? now,
        summary: combinedSummary,
        agent_id: planningLeadMeta.agent_id,
        agent_name: planningLeadMeta.agent_name,
        agent_name_ko: planningLeadMeta.agent_name_ko,
        agent_avatar: planningLeadMeta.agent_avatar,
        project_id: row.project_id,
        project_name: row.project_name,
        project_path: row.project_path,
        task_id: row.task_id,
        task_title: row.task_title,
        meeting_id: row.meeting_id,
        review_round: row.meeting_round,
        options,
      });
    }
    return out;
  }

  return {
    getReviewDecisionFallbackLabel,
    getReviewDecisionNotes,
    buildReviewRoundDecisionItems,
  };
}
