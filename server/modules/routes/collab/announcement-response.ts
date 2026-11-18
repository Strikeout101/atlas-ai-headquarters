import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";

type L10n = Record<Lang, string[]>;

type AnnouncementReplyDeps = {
  db: RuntimeContext["db"];
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getDeptName: (deptId: string) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  l: (en: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
};

export function createAnnouncementReplyScheduler(deps: AnnouncementReplyDeps): {
  generateAnnouncementReply: (agent: AgentRow, announcement: string, lang: Lang) => string;
  scheduleAnnouncementReplies: (announcement: string) => void;
} {
  const { db, resolveLang, getDeptName, getRoleLabel, l, pickL, sendAgentMessage } = deps;

  function generateAnnouncementReply(agent: AgentRow, announcement: string, lang: Lang): string {
    const name = agent.name;
    const dept = agent.department_id ? getDeptName(agent.department_id) : "";
    const role = getRoleLabel(agent.role, lang);

    const isUrgent = /urgent|important|immediately|critical/i.test(announcement);
    const isGoodNews = /congrat|achieve|success|thank/i.test(announcement);
    const isPolicy = /policy|change|rule|update/i.test(announcement);
    const isMeeting = /meeting|gather/i.test(announcement);

    if (isUrgent)
      return pickL(
        l([
          `${name} from ${dept} — acknowledged! I'll relay this to my team immediately! 🚨`,
          `Urgent noted! ${dept} is on it right away.`,
          `${name} here — confirmed! Sharing with the team ASAP.`,
        ]),
        lang,
      );
    if (isGoodNews)
      return pickL(
        l([
          `Congratulations! ${dept} is thrilled! 🎉`,
          `Great news! I'll share this with my team 😊`,
          `${name} here — wonderful to hear! 👏`,
        ]),
        lang,
      );
    if (isMeeting)
      return pickL(
        l([
          `${name} from ${dept} — noted! I'll block the time 📅`,
          `Will be there! I'll let my team know too.`,
          `${name} confirmed! I'll prepare for the meeting.`,
        ]),
        lang,
      );
    if (isPolicy)
      return pickL(
        l([
          `${name} from ${dept} — understood. I'll share with the team and align accordingly 📋`,
          `Policy update noted! ${dept} will review and adjust.`,
        ]),
        lang,
      );
    return pickL(
      l([
        `${name} from ${dept} — acknowledged! 👍`,
        `Noted! ${dept} will take this into account.`,
        `${name} here — confirmed. I'll share with the team!`,
        `Got it! We'll factor this into ${dept}'s work 📝`,
      ]),
      lang,
    );
  }

  function scheduleAnnouncementReplies(announcement: string): void {
    const lang = resolveLang(announcement);
    const teamLeaders = db
      .prepare("SELECT * FROM agents WHERE role = 'team_leader' AND status != 'offline'")
      .all() as unknown as AgentRow[];

    let delay = 1500;
    for (const leader of teamLeaders) {
      const replyDelay = delay + Math.random() * 1500;
      setTimeout(() => {
        const reply = generateAnnouncementReply(leader, announcement, lang);
        sendAgentMessage(leader, reply, "chat", "all", null, null);
      }, replyDelay);
      delay += 1500 + Math.random() * 1500;
    }
  }

  return { generateAnnouncementReply, scheduleAnnouncementReplies };
}
