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
          `${name}: Got it. I'll tell the team now.`,
          `${dept} is on it now.`,
          `${name}: I'll share this with the team right away.`,
        ]),
        lang,
      );
    if (isGoodNews)
      return pickL(
        l([`Great news for ${dept}!`, `Nice! I'll share this with my team.`, `${name}: Glad to hear it.`]),
        lang,
      );
    if (isMeeting)
      return pickL(
        l([
          `${name}: I'll be there.`,
          `Will be there! I'll let my team know too.`,
          `${name}: I'll get ready for the meeting.`,
        ]),
        lang,
      );
    if (isPolicy)
      return pickL(
        l([`${name}: Got it. I'll share the change with the team.`, `${dept} will check what needs to change.`]),
        lang,
      );
    return pickL(
      l([
        `${name}: Got it.`,
        `${dept} will keep this in mind.`,
        `${name}: I'll share this with the team.`,
        `Got it. We'll use this in ${dept}'s work.`,
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
