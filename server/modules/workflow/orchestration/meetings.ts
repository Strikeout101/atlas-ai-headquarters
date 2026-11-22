import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { REVIEW_MAX_MEMO_ITEMS_PER_DEPT, REVIEW_MAX_MEMO_ITEMS_PER_ROUND } from "../../../db/runtime.ts";
import { createMeetingLeaderSelectionTools } from "./meetings/leader-selection.ts";
import { createMeetingMinutesTools } from "./meetings/minutes.ts";
import { createMeetingPresenceTools } from "./meetings/presence.ts";

export function initializeWorkflowMeetingTools(ctx: RuntimeContext): any {
  const __ctx: RuntimeContext = ctx;
  const db = __ctx.db;
  const nowMs = __ctx.nowMs;
  const broadcast = __ctx.broadcast;
  const appendTaskLog = __ctx.appendTaskLog;
  const detectTargetDepartments =
    typeof __ctx.detectTargetDepartments === "function" ? __ctx.detectTargetDepartments : (_text: string) => [];
  const findTeamLeader = __ctx.findTeamLeader;
  const getAgentDisplayName = __ctx.getAgentDisplayName;
  const getDeptName = __ctx.getDeptName;
  const getRoleLabel = __ctx.getRoleLabel;
  const l = __ctx.l;
  const pickL = __ctx.pickL;
  const summarizeForMeetingBubble = __ctx.summarizeForMeetingBubble;
  const classifyMeetingReviewDecision = __ctx.classifyMeetingReviewDecision;
  const meetingPresenceUntil = __ctx.meetingPresenceUntil;
  const meetingSeatIndexByAgent = __ctx.meetingSeatIndexByAgent;
  const meetingPhaseByAgent = __ctx.meetingPhaseByAgent;
  const meetingTaskIdByAgent = __ctx.meetingTaskIdByAgent;
  const meetingReviewDecisionByAgent = __ctx.meetingReviewDecisionByAgent;
  const reviewRoundState = __ctx.reviewRoundState;
  const reviewInFlight = __ctx.reviewInFlight;
  const getTaskStatusById = __ctx.getTaskStatusById;
  const notifyCeo = __ctx.notifyCeo;
  const runAgentOneShot = __ctx.runAgentOneShot;
  const resolveProjectPath = __ctx.resolveProjectPath;
  const resolveLang = __ctx.resolveLang;
  const chooseSafeReply = __ctx.chooseSafeReply;
  const sendAgentMessage = __ctx.sendAgentMessage;
  const randomDelay = __ctx.randomDelay;
  const sleepMs = __ctx.sleepMs;
  const clearTaskWorkflowState = __ctx.clearTaskWorkflowState;
  const isTaskWorkflowInterrupted = __ctx.isTaskWorkflowInterrupted;
  const buildMeetingPrompt = __ctx.buildMeetingPrompt;
  const reviewMeetingOneShotTimeoutMs = Number((__ctx as any).reviewMeetingOneShotTimeoutMs ?? 65_000);

  const { getLeadersByDepartmentIds, getAllActiveTeamLeaders, getTaskRelatedDepartmentIds, getTaskReviewLeaders } =
    createMeetingLeaderSelectionTools({
      db,
      findTeamLeader,
      detectTargetDepartments,
    });

  const {
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
  } = createMeetingMinutesTools({
    db,
    nowMs,
    getDeptName,
    getRoleLabel,
    getAgentDisplayName,
    pickL,
    l,
    summarizeForMeetingBubble,
    appendTaskLog,
    broadcast,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  });

  const {
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
  } = createMeetingPresenceTools({
    db,
    nowMs,
    broadcast,
    meetingPresenceUntil,
    meetingSeatIndexByAgent,
    meetingPhaseByAgent,
    meetingTaskIdByAgent,
    meetingReviewDecisionByAgent,
    summarizeForMeetingBubble,
    classifyMeetingReviewDecision,
  });

  return {
    getLeadersByDepartmentIds,
    getAllActiveTeamLeaders,
    getTaskRelatedDepartmentIds,
    getTaskReviewLeaders,
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    markAgentInMeeting,
    isAgentInMeeting,
    callLeadersToCeoOffice,
    dismissLeadersFromCeoOffice,
    emitMeetingSpeech,
  };
}
