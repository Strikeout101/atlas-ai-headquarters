import { isLang, type Lang } from "../../../types/lang.ts";
import { readNonNegativeIntEnv } from "../../../db/runtime.ts";
import {
  compactMeetingPromptText,
  formatMeetingTranscriptForPrompt,
  type MeetingTranscriptLine,
} from "../meeting-prompt-utils.ts";
import type {
  AgentRow,
  MeetingReviewDecision,
  MeetingTranscriptEntry,
  OneShotRunResult,
  ReplyKind,
  RunFailureKind,
} from "./conversation-types.ts";

type LocalizedLines = {
  en: string[];
};

type CreateReplyCoreToolsDeps = {
  detectLang: (text: string) => string;
  getPreferredLanguage: () => string;
  pickL: (lines: LocalizedLines, lang: string) => string;
  prettyStreamJson: (raw: string) => string;
};

const MEETING_BUBBLE_EMPTY: LocalizedLines = {
  en: ["Sharing thoughts shortly."],
};

const MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS = Math.max(
  320,
  readNonNegativeIntEnv("MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS", 1200),
);
const MEETING_TRANSCRIPT_MAX_TURNS = Math.max(4, readNonNegativeIntEnv("MEETING_TRANSCRIPT_MAX_TURNS", 20));
const MEETING_TRANSCRIPT_LINE_MAX_CHARS = Math.max(72, readNonNegativeIntEnv("MEETING_TRANSCRIPT_LINE_MAX_CHARS", 180));
const MEETING_TRANSCRIPT_TOTAL_MAX_CHARS = Math.max(
  720,
  readNonNegativeIntEnv("MEETING_TRANSCRIPT_TOTAL_MAX_CHARS", 2400),
);

export function createReplyCoreTools(deps: CreateReplyCoreToolsDeps) {
  const { detectLang, getPreferredLanguage, pickL, prettyStreamJson } = deps;

  function normalizeMeetingLang(value: unknown): Lang {
    if (isLang(value)) return value;
    const preferred = getPreferredLanguage();
    return isLang(preferred) ? preferred : "en";
  }

  function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(minMs: number, maxMs: number): number {
    return Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  }

  function getAgentDisplayName(agent: AgentRow, lang: string): string {
    return agent.name;
  }

  function localeInstruction(_lang: string): string {
    return "Respond in English.";
  }

  function normalizeConversationReply(raw: string, maxChars = 420, opts: { maxSentences?: number } = {}): string {
    if (!raw.trim()) return "";
    const parsed = prettyStreamJson(raw);
    let text = parsed.trim() ? parsed : raw;
    text = text
      .replace(/^\[(init|usage|mcp|thread)\][^\n]*$/gim, "")
      .replace(/^\[reasoning\]\s*/gim, "")
      .replace(/\[(tool|result|output|spawn_agent|agent_done|one-shot-error)[^\]]*\]/gi, " ")
      .replace(/^\[(copilot|antigravity)\][^\n]*$/gim, "")
      .replace(
        /\{"type"\s*:\s*"(?:step_finish|step-finish|tool_use|tool_result|thinking|reasoning|text|content)"[^\n]*\}/gm,
        " ",
      )
      .replace(/^!?\s*permission requested:.*auto-rejecting\s*$/gim, "")
      .replace(/^!?\s*execution error:.*$/gim, "")
      .replace(/^!?\s*command rejected:.*$/gim, "")
      .replace(/^!?\s*Tool execution failed:.*$/gim, "")
      .replace(/^\[(?:stdout|stderr)\]\s*/gim, "")
      .replace(/^"(.*)"$/gm, "$1")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text) return "";

    let cleaned = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^[{}[\],]+$/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    cleaned = collapseRepeatedSentenceCycles(cleaned);

    if (opts.maxSentences && opts.maxSentences > 0) {
      const sentences = cleaned
        .split(/(?<=[.!?。！？])\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (sentences.length > opts.maxSentences) {
        cleaned = sentences.slice(0, opts.maxSentences).join(" ");
      }
    }

    if (cleaned.length > maxChars) {
      cleaned = `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
    }

    return cleaned;
  }

  function collapseRepeatedSentenceCycles(text: string): string {
    const sentences = text
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length < 4) return text;

    const total = sentences.length;
    for (let cycleLen = 1; cycleLen <= Math.floor(total / 2); cycleLen += 1) {
      if (total % cycleLen !== 0) continue;
      const repeatCount = total / cycleLen;
      if (repeatCount < 2) continue;

      const pattern = sentences.slice(0, cycleLen);
      let repeated = true;
      for (let i = cycleLen; i < total; i += 1) {
        if (sentences[i] !== pattern[i % cycleLen]) {
          repeated = false;
          break;
        }
      }
      if (!repeated) continue;

      const collapsed = pattern.join(" ").trim();
      if (collapsed.length >= 24) return collapsed;
    }
    return text;
  }

  function isInternalWorkNarration(text: string): boolean {
    return /\b(I need to|Let me|I'll|I will|analy[sz]e|examin|inspect|check files|run command|current codebase|relevant files)\b/i.test(
      text,
    );
  }

  function fallbackTurnReply(kind: ReplyKind, lang: string, agent?: AgentRow): string {
    const name = agent ? getAgentDisplayName(agent, lang) : "";
    switch (kind) {
      case "opening":
        return `${name}: Got it. What should we tackle first?`;
      case "feedback":
        return `${name}: I found a few gaps. Let's check the biggest one first.`;
      case "summary":
        return `${name}: I'll pull the feedback together and take the next step.`;
      case "approval":
        return `${name}: Got it. I'll go with that decision.`;
      case "direct":
      default:
        return `${name}: Got it. I'll get started.`;
    }
  }

  function buildAgentReplyText(lang: string, agent: AgentRow | undefined, messages: { en: string }): string {
    const body = messages.en;
    const name = agent ? getAgentDisplayName(agent, lang) : "";
    return name ? `${name}: ${body}` : body;
  }

  function clipFailureDetail(value: string, max = 180): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1).trimEnd()}…`;
  }

  function extractRunFailureDetail(rawText: string, runError?: string): string {
    const candidates: string[] = [];
    if (runError && runError.trim()) candidates.push(runError.trim());
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      candidates.push(trimmed);
    }
    for (const candidate of candidates) {
      const line = candidate
        .replace(/^\[(?:one-shot-error|tool-error)\]\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim();
      if (!line) continue;
      if (line.startsWith("{")) continue;
      if (/^(permission requested:|auto-rejecting)/i.test(line)) continue;
      if (/^(type=|sessionid=|timestamp=)/i.test(line)) continue;
      return clipFailureDetail(line);
    }
    return "";
  }

  function detectRunFailure(rawText: string, runError?: string): RunFailureKind | null {
    const source = [runError || "", rawText || ""].filter(Boolean).join("\n");
    if (!source.trim()) return null;
    if (
      /auto-rejecting|permission.*rejected|rejected permission|external_directory|user rejected permission/i.test(
        source,
      )
    )
      return "permission";
    if (/modified since it was last read|read the file again before modifying/i.test(source)) return "stale_file";
    if (/"type"\s*:\s*"(?:step_finish|step-finish)".*"reason"\s*:\s*"tool-calls"/i.test(source))
      return "tool_calls_only";
    if (/timeout after|timed out|request timed out/i.test(source)) return "timeout";
    if (runError || /\[(?:one-shot-error|tool-error)\]/i.test(source) || /^error:/im.test(source)) return "generic";
    return null;
  }

  function buildRunFailureReply(kind: RunFailureKind, lang: string, agent?: AgentRow, detail = ""): string {
    if (kind === "permission") {
      return buildAgentReplyText(lang, agent, {
        en: "The requested operation was blocked by a file-access permission. Please check the project directory settings.",
      });
    }
    if (kind === "stale_file") {
      return buildAgentReplyText(lang, agent, {
        en: "The file changed after it was read, so the operation was stopped. Please re-read the file and retry.",
      });
    }
    if (kind === "tool_calls_only") {
      return buildAgentReplyText(lang, agent, {
        en: "The run ended at tool-calls without producing a final reply. Please retry.",
      });
    }
    if (kind === "timeout") {
      return buildAgentReplyText(lang, agent, {
        en: "Response generation timed out, so the run was stopped. Please try again shortly.",
      });
    }
    const suffix = detail ? ` (${detail})` : "";
    return buildAgentReplyText(lang, agent, {
      en: `CLI execution failed${suffix}.`,
    });
  }

  function chooseSafeReply(run: OneShotRunResult, lang: string, kind: ReplyKind, agent?: AgentRow): string {
    const maxReplyChars = kind === "direct" ? 12000 : 2000;
    const rawText = run.text || "";
    const failureKind = detectRunFailure(rawText, run.error);
    if (failureKind) {
      const detail = failureKind === "generic" ? extractRunFailureDetail(rawText, run.error) : "";
      return buildRunFailureReply(failureKind, lang, agent, detail);
    }
    const cleaned = normalizeConversationReply(rawText, maxReplyChars, { maxSentences: 0 });
    if (!cleaned) return fallbackTurnReply(kind, lang, agent);
    if (/timeout after|response failed|one-shot-error/i.test(cleaned)) {
      return fallbackTurnReply(kind, lang, agent);
    }
    if (isInternalWorkNarration(cleaned)) return fallbackTurnReply(kind, lang, agent);

    return cleaned;
  }

  function compactForMeetingPrompt(text: string, maxChars: number): string {
    return compactMeetingPromptText(text, maxChars);
  }

  function summarizeForMeetingBubble(
    text: string,
    maxChars = 96,
    lang: Lang = normalizeMeetingLang(getPreferredLanguage()),
  ): string {
    const cleaned = normalizeConversationReply(text, maxChars + 24)
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return pickL(MEETING_BUBBLE_EMPTY, lang);
    if (cleaned.length <= maxChars) return cleaned;
    return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
  }

  function isMvpDeferralSignal(text: string): boolean {
    return /mvp|production|post[-\s]?merge|post[-\s]?release|stabilization|monitoring|sla|checklist|runbook|defer|deferred|later\s*phase/i.test(
      text,
    );
  }

  function isHardBlockSignal(text: string): boolean {
    return /cannot\s+(approve|ship|release)|must\s+fix\s+before|hard\s+blocker|critical\s+blocker|p0|data\s+loss|security\s+incident|integrity\s+broken|audit\s*fail|build\s*fail/i.test(
      text,
    );
  }

  function hasApprovalAgreementSignal(text: string): boolean {
    return /approve|approved|agree|agreed|lgtm|go\s+ahead|merge\s+approve/i.test(text);
  }

  function isDeferrableReviewHold(text: string): boolean {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return false;
    if (!isMvpDeferralSignal(cleaned)) return false;
    if (isHardBlockSignal(cleaned)) return false;
    return true;
  }

  function classifyMeetingReviewDecision(text: string): MeetingReviewDecision {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return "reviewing";
    const hasApprovalAgreement = hasApprovalAgreementSignal(cleaned);
    const hasMvpDeferral = isMvpDeferralSignal(cleaned);
    const hasHardBlock = isHardBlockSignal(cleaned);
    const hasApprovalSignal = /(approve|approved|lgtm|ship\s+it|go\s+ahead)/i.test(cleaned);
    const hasNoRiskSignal = /(no\s+risk|without\s+risk|risk[-\s]?free|no\s+issue|no\s+blocker)/i.test(cleaned);
    const hasConditionalOrHoldSignal =
      /(hold|revise|revision|changes?\s+requested|required|pending|risk|block|missing|incomplete|not\s+ready)/i.test(
        cleaned,
      );

    if (hasApprovalSignal && hasNoRiskSignal) return "approved";
    if ((hasApprovalAgreement || hasApprovalSignal) && hasMvpDeferral && !hasHardBlock) return "approved";
    if (hasConditionalOrHoldSignal) {
      if ((hasApprovalAgreement || hasApprovalSignal) && hasMvpDeferral && !hasHardBlock) return "approved";
      return "hold";
    }
    if (hasApprovalSignal || hasNoRiskSignal || hasApprovalAgreement) return "approved";
    return "reviewing";
  }

  function wantsReviewRevision(content: string): boolean {
    return classifyMeetingReviewDecision(content) === "hold";
  }

  function findLatestTranscriptContentByAgent(transcript: MeetingTranscriptEntry[], agentId: string): string {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const row = transcript[i];
      if (row.speaker_agent_id === agentId) return row.content;
    }
    return "";
  }

  function compactTaskDescriptionForMeeting(taskDescription: string | null): string {
    if (!taskDescription) return "";
    const marker = "[PROJECT MEMO]";
    const markerIdx = taskDescription.indexOf(marker);
    const base = markerIdx >= 0 ? taskDescription.slice(0, markerIdx) : taskDescription;
    return compactForMeetingPrompt(base, MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS);
  }

  function formatMeetingTranscript(
    transcript: MeetingTranscriptEntry[],
    lang: Lang = normalizeMeetingLang(getPreferredLanguage()),
  ): string {
    const lines: MeetingTranscriptLine[] = transcript.map((row) => ({
      speaker: row.speaker,
      department: row.department,
      role: row.role,
      content: row.content,
    }));

    return formatMeetingTranscriptForPrompt(lines, {
      maxTurns: MEETING_TRANSCRIPT_MAX_TURNS,
      maxLineChars: MEETING_TRANSCRIPT_LINE_MAX_CHARS,
      maxTotalChars: MEETING_TRANSCRIPT_TOTAL_MAX_CHARS,
      summarize: (text, maxChars) => summarizeForMeetingBubble(text, maxChars, lang),
    });
  }

  return {
    normalizeMeetingLang,
    sleepMs,
    randomDelay,
    getAgentDisplayName,
    localeInstruction,
    normalizeConversationReply,
    isInternalWorkNarration,
    fallbackTurnReply,
    chooseSafeReply,
    summarizeForMeetingBubble,
    isMvpDeferralSignal,
    isHardBlockSignal,
    hasApprovalAgreementSignal,
    isDeferrableReviewHold,
    classifyMeetingReviewDecision,
    wantsReviewRevision,
    findLatestTranscriptContentByAgent,
    compactTaskDescriptionForMeeting,
    formatMeetingTranscript,
  };
}
