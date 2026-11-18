import type { Lang } from "../../../../types/lang.ts";
import type { MeetingTranscriptEntry } from "./minutes.ts";

type OutcomeContext = any;

const REVIEW_DECISION_PENDING_LOG_PREFIX = "Decision inbox: review decision pending";

export async function processReviewConsensusOutcome(ctx: OutcomeContext): Promise<boolean> {
  const {
    taskId,
    taskTitle,
    round,
    roundMode,
    isRound1Remediation,
    isRound2Merge,
    isFinalDecisionRound,
    leaders,
    transcript,
    lang,
    meetingId,
    onApproved,
    abortIfInactive,
    meetingReviewDecisionByAgent,
    findLatestTranscriptContentByAgent,
    isDeferrableReviewHold,
    summarizeForMeetingBubble,
    getDeptName,
    getAgentDisplayName,
    appendTaskLog,
    REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
    REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
    appendTaskProjectMemo,
    sleepMs,
    randomDelay,
    collectRevisionMemoItems,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    pickL,
    l,
    db,
    REVIEW_MAX_REMEDIATION_REQUESTS,
    notifyCeo,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    reviewRoundState,
    reviewInFlight,
    appendTaskReviewFinalMemo,
    scheduleNextReviewRound,
  } = ctx;

  // Final review result should follow each leader's last approval statement,
  // not stale "needs revision" flags from earlier feedback turns.
  const finalHoldLeaders: any[] = [];
  const deferredMonitoringLeaders: any[] = [];
  const deferredMonitoringNotes: string[] = [];
  const finalHoldDeptCount = new Map<string, number>();
  for (const leader of leaders as any[]) {
    if (meetingReviewDecisionByAgent.get(leader.id) !== "hold") continue;
    const latestDecisionLine = findLatestTranscriptContentByAgent(transcript as MeetingTranscriptEntry[], leader.id);
    if (isDeferrableReviewHold(latestDecisionLine)) {
      const clipped = summarizeForMeetingBubble(latestDecisionLine, 160, lang as Lang);
      deferredMonitoringLeaders.push(leader);
      deferredMonitoringNotes.push(
        `${getDeptName(leader.department_id ?? "")} ${getAgentDisplayName(leader, lang)}: ${clipped}`,
      );
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: converted deferrable hold to post-merge monitoring (${leader.id})`,
      );
      continue;
    }
    if (finalHoldLeaders.length >= REVIEW_MAX_REVISION_SIGNALS_PER_ROUND) {
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: hold signal ignored (round cap ${REVIEW_MAX_REVISION_SIGNALS_PER_ROUND})`,
      );
      continue;
    }
    const deptKey = leader.department_id ?? `agent:${leader.id}`;
    const deptCount = finalHoldDeptCount.get(deptKey) ?? 0;
    if (deptCount >= REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND) {
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: hold signal ignored for dept ${deptKey} (dept cap ${REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND})`,
      );
      continue;
    }
    finalHoldDeptCount.set(deptKey, deptCount + 1);
    finalHoldLeaders.push(leader);
  }
  const needsRevision = finalHoldLeaders.length > 0;
  if (!needsRevision && deferredMonitoringNotes.length > 0) {
    appendTaskProjectMemo(taskId, "review", round, deferredMonitoringNotes, lang);
    appendTaskLog(
      taskId,
      "system",
      `Review round ${round}: deferred ${deferredMonitoringLeaders.length} hold opinions to SLA monitoring checklist`,
    );
  }

  await sleepMs(randomDelay(540, 920));
  if (abortIfInactive()) return true;

  if (needsRevision) {
    const rawMemoItems = collectRevisionMemoItems(
      transcript as MeetingTranscriptEntry[],
      REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
      REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    );
    const { freshItems, duplicateCount } = reserveReviewRevisionMemoItems(taskId, round, rawMemoItems);
    const hasFreshMemoItems = freshItems.length > 0;
    const fallbackMemoItem = pickL(
      l([
        "A review hold signal was detected. Document residual risks against agreed quality gates and move to a final decision.",
      ]),
      lang,
    );
    const memoItemsForAction = hasFreshMemoItems ? freshItems : [fallbackMemoItem];
    const recentMemoItems = hasFreshMemoItems ? [] : loadRecentReviewRevisionMemoItems(taskId, 4);
    const memoItemsForProject = hasFreshMemoItems
      ? freshItems
      : recentMemoItems.length > 0
        ? recentMemoItems
        : memoItemsForAction;
    appendTaskProjectMemo(taskId, "review", round, memoItemsForProject, lang);

    appendTaskLog(
      taskId,
      "system",
      `Review consensus round ${round}: revision requested (mode=${roundMode}, new_items=${freshItems.length}, duplicates=${duplicateCount})`,
    );

    const remediationRequestCountRow = db
      .prepare(
        `
          SELECT COUNT(*) AS cnt
          FROM meeting_minutes
          WHERE task_id = ?
            AND meeting_type = 'review'
            AND status = 'revision_requested'
        `,
      )
      .get(taskId) as { cnt: number } | undefined;
    const remediationRequestCount = remediationRequestCountRow?.cnt ?? 0;
    const remediationLimitReached = remediationRequestCount >= REVIEW_MAX_REMEDIATION_REQUESTS;

    if ((isRound1Remediation || isRound2Merge) && !remediationLimitReached) {
      const nextRound = round + 1;
      appendTaskLog(
        taskId,
        "system",
        `${REVIEW_DECISION_PENDING_LOG_PREFIX} (round=${round}, options=${memoItemsForAction.length})`,
      );
      notifyCeo(
        pickL(
          l([
            `[CEO OFFICE] Team-lead remediation opinions for '${taskTitle}' in review round ${round} are consolidated. In Decision Inbox, cherry-pick multiple items and optionally add an extra note for remediation, or skip to round ${nextRound}.`,
          ]),
          lang,
        ),
        taskId,
      );
      if (meetingId) finishMeetingMinutes(meetingId, "revision_requested");
      dismissLeadersFromCeoOffice(taskId, leaders);
      reviewRoundState.delete(taskId);
      reviewInFlight.delete(taskId);
      return true;
    }

    if ((isRound1Remediation || isRound2Merge) && remediationLimitReached) {
      appendTaskLog(
        taskId,
        "system",
        `Review consensus round ${round}: remediation request cap reached (${REVIEW_MAX_REMEDIATION_REQUESTS}/task), skipping additional remediation`,
      );
      notifyCeo(
        pickL(
          l([
            `[CEO OFFICE] '${taskTitle}' reached the remediation-request cap (${REVIEW_MAX_REMEDIATION_REQUESTS} per task). Skipping additional remediation and moving to final decision.`,
          ]),
          lang,
        ),
        taskId,
      );
    }

    const forceReason = isRound2Merge ? "round2_no_more_remediation_allowed" : `round${round}_finalization`;
    appendTaskLog(
      taskId,
      "system",
      `Review consensus round ${round}: forcing finalization with documented residual risk (${forceReason})`,
    );

    appendTaskReviewFinalMemo(taskId, round, transcript as MeetingTranscriptEntry[], lang, true);
    notifyCeo(
      pickL(
        l([
          `[CEO OFFICE] In review round ${round} for '${taskTitle}', residual risks were embedded in the final document package. Closing with final approval decision and no further remediation.`,
        ]),
        lang,
      ),
      taskId,
    );
    if (meetingId) finishMeetingMinutes(meetingId, "completed");
    dismissLeadersFromCeoOffice(taskId, leaders);
    reviewRoundState.delete(taskId);
    reviewInFlight.delete(taskId);
    onApproved();
    return true;
  }

  if (deferredMonitoringLeaders.length > 0) {
    notifyCeo(
      pickL(
        l([
          `[CEO OFFICE] In review round ${round} for '${taskTitle}', ${deferredMonitoringLeaders.length} hold opinions were classified as MVP-out-of-scope and moved to post-merge SLA monitoring checklist.`,
        ]),
        lang,
      ),
      taskId,
    );
  }

  if (isRound2Merge) {
    appendTaskLog(taskId, "system", `Review consensus round ${round}: merge consolidation complete`);
    notifyCeo(
      pickL(
        l([
          `[CEO OFFICE] Review round ${round} consolidation/merge review for '${taskTitle}' is complete. Moving to round 3 final approval.`,
        ]),
        lang,
      ),
      taskId,
    );
    if (meetingId) finishMeetingMinutes(meetingId, "completed");
    dismissLeadersFromCeoOffice(taskId, leaders);
    reviewRoundState.delete(taskId);
    reviewInFlight.delete(taskId);
    scheduleNextReviewRound(taskId, taskTitle, round, lang);
    return true;
  }

  appendTaskLog(taskId, "system", `Review consensus round ${round}: all leaders approved`);
  if (isFinalDecisionRound) {
    appendTaskReviewFinalMemo(
      taskId,
      round,
      transcript as MeetingTranscriptEntry[],
      lang,
      deferredMonitoringLeaders.length > 0,
    );
  }
  notifyCeo(pickL(l([`[CEO OFFICE] '${taskTitle}' is approved by all leaders. Proceeding to Done.`]), lang), taskId);
  if (meetingId) finishMeetingMinutes(meetingId, "completed");
  dismissLeadersFromCeoOffice(taskId, leaders);
  reviewRoundState.delete(taskId);
  reviewInFlight.delete(taskId);
  onApproved();
  return true;
}
