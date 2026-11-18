import type { Lang } from "../../../types/lang.ts";
import type { L10n } from "./language-policy.ts";

interface MessageDeps {
  l: (en: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
}

interface LeaderAckParams extends MessageDeps {
  lang: Lang;
  subRole: string;
  subName: string;
  skipPlannedMeeting: boolean;
  isPlanningLead: boolean;
  crossDeptNames: string;
}

interface DelegateMessageParams extends MessageDeps {
  lang: Lang;
  subName: string;
  ceoMessage: string;
}

interface SubordinateAckParams extends MessageDeps {
  lang: Lang;
  leaderRole: string;
  leaderName: string;
}

interface SelfMessageParams extends MessageDeps {
  lang: Lang;
  skipPlannedMeeting: boolean;
}

interface ManualFallbackNoticeParams extends MessageDeps {
  lang: Lang;
  leaderName: string;
}

export function buildLeaderAckMessage(params: LeaderAckParams): string {
  const { l, pickL, lang, subRole, subName, skipPlannedMeeting, isPlanningLead, crossDeptNames } = params;

  if (skipPlannedMeeting && isPlanningLead && crossDeptNames) {
    return pickL(
      l([
        `Understood. We'll skip the leaders' planning meeting, coordinate quickly with ${crossDeptNames}, then delegate immediately to ${subRole} ${subName}. 📋`,
      ]),
      lang,
    );
  }

  if (skipPlannedMeeting && crossDeptNames) {
    return pickL(
      l([
        `Understood. We'll skip the planning meeting, delegate directly to ${subRole} ${subName}, and coordinate with ${crossDeptNames} in parallel. 📋`,
      ]),
      lang,
    );
  }

  if (skipPlannedMeeting) {
    return pickL(
      l([`Understood. We'll skip the leaders' planning meeting and delegate immediately to ${subRole} ${subName}. 📋`]),
      lang,
    );
  }

  if (isPlanningLead && crossDeptNames) {
    return pickL(
      l([
        `Understood. I'll first confirm related departments (${crossDeptNames}), finish cross-team pre-processing, then delegate to ${subRole} ${subName}. 📋`,
      ]),
      lang,
    );
  }

  if (crossDeptNames) {
    return pickL(
      l([
        `Understood. We'll run the team-lead planning meeting first, then delegate to ${subRole} ${subName} and coordinate with ${crossDeptNames}. 📋`,
        `Got it. After the leaders' planning meeting, I'll assign ${subName} and sync with ${crossDeptNames}. 🤝`,
      ]),
      lang,
    );
  }

  return pickL(
    l([
      `Understood. I'll convene the team-lead planning meeting first, then assign to ${subRole} ${subName} after the planning output is finalized. 📋`,
      `Got it. ${subName} is the best fit, and I'll delegate in sequence after the leaders' planning meeting concludes.`,
      `Confirmed. After the leaders' planning meeting, I'll hand this off to ${subName} and manage execution.`,
    ]),
    lang,
  );
}

export function buildDelegateMessage(params: DelegateMessageParams): string {
  const { l, pickL, lang, subName, ceoMessage } = params;
  return pickL(
    l([
      `${subName}, directive from the CEO: "${ceoMessage}" — please handle this!`,
      `${subName}! Priority task: "${ceoMessage}" — needs immediate attention.`,
      `${subName}, new assignment: "${ceoMessage}" — keep me posted on progress 👍`,
    ]),
    lang,
  );
}

export function buildSubordinateAckMessage(params: SubordinateAckParams): string {
  const { l, pickL, lang, leaderRole, leaderName } = params;
  return pickL(
    l([
      `Yes, ${leaderName}! Confirmed. Starting right away! 💪`,
      `Got it! On it now. I'll keep you updated on progress.`,
      `Confirmed, ${leaderName}! I'll give it my best 🔥`,
    ]),
    lang,
  );
}

export function buildSelfExecutionMessage(params: SelfMessageParams): string {
  const { l, pickL, lang, skipPlannedMeeting } = params;
  if (skipPlannedMeeting) {
    return pickL(
      l([
        `Understood. We'll skip the leaders' planning meeting and I'll execute this directly right away since no assignee is available. 💪`,
      ]),
      lang,
    );
  }
  return pickL(
    l([
      `Understood. We'll complete the team-lead planning meeting first, and since no one is available I'll execute it myself after the plan is organized. 💪`,
      `Got it. I'll proceed personally after the leaders' planning meeting.`,
    ]),
    lang,
  );
}

export function buildManualFallbackNotice(params: ManualFallbackNoticeParams): string {
  const { l, pickL, lang, leaderName } = params;
  return pickL(
    l([
      `[CEO OFFICE] Manual assignment safeguard applied: no eligible subordinate in assigned agents, so team leader (${leaderName}) will execute directly.`,
    ]),
    lang,
  );
}
