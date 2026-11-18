import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";

type L10n = Record<Lang, string[]>;

type ChatResponseDeps = {
  db: RuntimeContext["db"];
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getDeptName: (deptId: string) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  pickRandom: <T>(arr: T[]) => T;
  getFlairs: (agentName: string, lang: Lang) => string[];
  classifyIntent: (msg: string, lang: Lang) => Record<string, boolean>;
  l: (en: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
};

export function createChatReplyGenerator(deps: ChatResponseDeps): {
  generateChatReply: (agent: AgentRow, ceoMessage: string) => string;
} {
  const { db, resolveLang, getDeptName, getRoleLabel, pickRandom, getFlairs, classifyIntent, l, pickL } = deps;

  function generateChatReply(agent: AgentRow, ceoMessage: string): string {
    const msg = ceoMessage.trim();
    const lang = resolveLang(msg);
    const name = agent.name;
    const dept = agent.department_id ? getDeptName(agent.department_id) : "";
    const role = getRoleLabel(agent.role, lang);
    const nameTag = dept ? `${name}, ${role} of ${dept}` : `${role} ${name}`;
    const flairs = getFlairs(agent.name, lang);
    const flair = () => pickRandom(flairs);
    const intent = classifyIntent(msg, lang);

    let taskTitle = "";
    if (agent.current_task_id) {
      const t = db.prepare("SELECT title FROM tasks WHERE id = ?").get(agent.current_task_id) as
        | { title: string }
        | undefined;
      if (t) taskTitle = t.title;
    }

    if (agent.status === "offline")
      return pickL(l([`[Auto-reply] ${name} is currently offline. I'll check when I'm back.`]), lang);

    if (agent.status === "break") {
      if (intent.presence)
        return pickL(
          l([
            `Oh! I just stepped out for coffee. I'm back now! ☕`,
            `Yes! I was on a short break but I'm here. What do you need?`,
            `I'm here! Just took a quick breather. What's up? 😊`,
          ]),
          lang,
        );
      if (intent.greeting)
        return pickL(
          l([
            `Hi! I was on a quick break. How can I help? ☕`,
            `Hey! ${name} here. Was taking a breather. What's going on?`,
          ]),
          lang,
        );
      return pickL(
        l([
          `Oh, I was taking a break! Let me check right away 😅`,
          `Got it! Break's over, I'll look into it now!`,
          `I'm back! I'll handle that right away ☕`,
        ]),
        lang,
      );
    }

    if (agent.status === "working") {
      const taskEn = taskTitle ? ` "${taskTitle}"` : " my current task";

      if (intent.presence)
        return pickL(
          l([
            `Yes! I'm here. Currently working on${taskEn}. What do you need?`,
            `I'm at my desk! ${flair()} and making good progress 💻`,
            `Right here! Working on${taskEn}. What's up?`,
          ]),
          lang,
        );
      if (intent.greeting)
        return pickL(
          l([
            `Hi! ${nameTag} here. Currently ${flair()} 😊`,
            `Hello! I'm focused on${taskEn} right now, but go ahead!`,
          ]),
          lang,
        );
      if (intent.whatDoing)
        return pickL(
          l([
            `Working on${taskEn} right now! ${flair()} — going smoothly 📊`,
            `I'm ${flair()} on${taskEn}. About 70% done!`,
            `Deep into${taskEn} at the moment. Should be done soon! 💪`,
          ]),
          lang,
        );
      if (intent.report)
        return pickL(
          l([
            `${taskEn} is progressing well. ${flair()} — wrapping up! 📊`,
            `About 70% done on${taskEn}. On track for completion!`,
          ]),
          lang,
        );
      if (intent.complaint)
        return pickL(
          l([`Sorry about that! I'll pick up the pace 🏃‍♂️`, `Working as fast as I can! Just need a bit more time.`]),
          lang,
        );
      if (intent.canDo)
        return pickL(
          l([
            `I'm tied up right now, but I'll jump on it as soon as I finish! 📝`,
            `Can do! Let me wrap up my current task first.`,
          ]),
          lang,
        );
      return pickL(
        l([`Got it! I'll check after finishing my current task 📝`, `Noted! I'll get to it once I'm done here.`]),
        lang,
      );
    }

    if (intent.presence)
      return pickL(
        l([
          `Yes, I'm here! ${nameTag}. What do you need? 😊`,
          `Right here! I was on standby. What's up?`,
          `I'm at my desk! Ready for anything.`,
          `Always ready! ${name} is here ✋`,
        ]),
        lang,
      );
    if (intent.greeting)
      return pickL(
        l([
          `Hello! ${nameTag} here. Having a good day? 😊`,
          `Hi! ${nameTag}. Feel free to let me know if you need anything!`,
          `Hey! ${name} here. Let's make today count! 🔥`,
          `Good to see you! ${name} from ${dept}, ready to go!`,
        ]),
        lang,
      );
    if (intent.whatDoing)
      return pickL(
        l([
          `I'm on standby! Was ${flair()} to sharpen my skills 📚`,
          `Nothing assigned right now, so I was ${flair()}.`,
          `I'm free! Give me something to do and I'll jump right in 🙌`,
        ]),
        lang,
      );
    if (intent.praise)
      return pickL(
        l([
          `Thank you! I'll keep up the great work! 💪`,
          `That means a lot! I'll do my best 😊`,
          `Thanks! Really motivating to hear that ✨`,
        ]),
        lang,
      );
    if (intent.encourage)
      return pickL(l([`Thanks! Your support means everything! 💪`, `You got it! I won't let you down 🔥`]), lang);
    if (intent.report)
      return pickL(
        l([
          `Currently on standby with no assigned tasks. Ready to start anything! 📋`,
          `I'm available! Just waiting for the next assignment.`,
        ]),
        lang,
      );
    if (intent.joke)
      return pickL(
        l([
          `Haha, you're in a good mood today! 😄`,
          `Love the vibes! Working with you is always fun~`,
          `😂 Good laugh! Alright, ready to get back to work!`,
        ]),
        lang,
      );
    if (intent.complaint)
      return pickL(l([`Sorry about that! I'll step it up.`, `I hear you. I'll improve and show results! 🙏`]), lang);
    if (intent.opinion)
      return pickL(
        l([
          `From a ${dept} perspective, let me think about that... 🤔`,
          `Great question! Let me put together my thoughts on this.`,
          `Looks promising from where I sit. I'll analyze the details and get back to you 📊`,
        ]),
        lang,
      );
    if (intent.canDo)
      return pickL(
        l([
          `Absolutely! I can start right away. Just give me the details! 🚀`,
          `Can do! I'm free right now, so I'll get on it.`,
          `Leave it to me! ${name} will handle it 💪`,
        ]),
        lang,
      );
    if (intent.question)
      return pickL(
        l([
          `Let me check on that! One moment 🔍`,
          `Good question! Let me look into it and get back to you.`,
          `I'll find out and get back to you ASAP.`,
        ]),
        lang,
      );
    return pickL(
      l([
        `Got it! Let me know if you need anything else.`,
        `Understood! ${name} is on it 😊`,
        `Roger that! I'll get moving on this.`,
        `Noted! I'll take care of it 📝`,
      ]),
      lang,
    );
  }

  return { generateChatReply };
}
