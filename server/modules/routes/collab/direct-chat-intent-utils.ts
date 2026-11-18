export function shouldTreatDirectChatAsTask(ceoMessage: string, messageType: string): boolean {
  if (messageType === "task_assign") return true;
  if (messageType === "report") return false;
  const text = ceoMessage.trim();
  if (!text) return false;
  if (/^\[(decision\s*reply)\]/i.test(text)) return false;

  if (/^\s*(task|todo)\s*[:-]/i.test(text)) return true;

  const taskKeywords =
    /(fix|implement|refactor|test|verify|check|review|audit|analyze|analysis|report|run|apply|update|debug|investigate)/i;
  if (taskKeywords.test(text)) return true;

  const requestTone = /(please|can you|could you|would you)/i;
  if (requestTone.test(text) && text.length >= 12) return true;

  const requestIntent = /(want|need|i need|i want)/i;
  if (requestIntent.test(text) && /(review|audit|analy|report)/i.test(text)) {
    return true;
  }

  const analysisRequestVerb = /(identify|find|inspect|investigate|analyze|review|audit)/i;
  const softwareContext = /(repo|repository|test|build|lint|tsc|report)/i;
  if (analysisRequestVerb.test(text) && softwareContext.test(text)) {
    return true;
  }

  return false;
}

export function isProjectProgressInquiry(text: string, messageType: string = "chat"): boolean {
  if (messageType === "task_assign") return false;
  const normalized = text.trim();
  if (!normalized) return false;

  const progressPatterns = [
    /(project|task).*(status|progress|update|where are we|how far)/i,
    /(status|progress|update).*(project|task)/i,
  ];
  if (!progressPatterns.some((pattern) => pattern.test(normalized))) return false;

  const projectScopeHints = [/(project|task|tasks)/i];
  return projectScopeHints.some((pattern) => pattern.test(normalized)) || /how far/i.test(normalized);
}

export function isTaskKickoffMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[!?.。！？…~]+$/g, "");
  if (!normalized) return false;
  if (/^(go|go go|gogo|let'?s go|start|proceed|execute|go ahead)$/i.test(normalized)) return true;
  return false;
}

export function isAffirmativeReply(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[!?.。！？…~]+$/g, "");
  if (!normalized) return false;

  const negativePatterns = [/^(stop|no|nope|nah|don'?t|not now|later)/i];
  if (negativePatterns.some((pattern) => pattern.test(normalized))) return false;

  const affirmativePatterns = [/^(ok|okay|sure|yep|yeah|yes|go|go ahead|proceed|do it|start|let'?s go|let?s do it)/i];
  return affirmativePatterns.some((pattern) => pattern.test(normalized));
}

export function isAgentEscalationPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const patterns = [
    /(shall i|should i|would you like me to|may i|can i).*(start|proceed|execute|run|begin)/i,
    /(start now|proceed now|go ahead\?)/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function isCancelReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  return /^(cancel|stop|abort|later|not now)/i.test(normalized);
}

export function isNoPathReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  const patterns = [
    /(no path|don't have.*path|no project path|without path|unknown path)/i,
    /(create new project|new project please|make new project)/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export function detectProjectKindChoice(text: string): "existing" | "new" | null {
  const raw = text.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");

  const numericExisting = /(?:^|\s)1(?:\s|$)/.test(normalized) || /1️⃣/.test(raw) || compact === "1";
  const numericNew = /(?:^|\s)2(?:\s|$)/.test(normalized) || /2️⃣/.test(raw) || compact === "2";
  if (numericExisting && !numericNew) return "existing";
  if (numericNew && !numericExisting) return "new";

  const existingHit = /(?:existing\s*project|existing\s*one|\bexisting\b|already\s*project|already\s*existing)/i.test(
    raw,
  );
  const newHit = /(new\s*project|\bnew\b)/i.test(raw) || compact.includes("newproject");

  if (existingHit && !newHit) return "existing";
  if (newHit && !existingHit) return "new";
  return null;
}

export function shouldPreserveStructuredFallback(fallback: string): boolean {
  const text = fallback.trim();
  if (!text) return false;

  if (/[1-9]️⃣/.test(text)) return true;
  if (/(reply)\s*[:(]/i.test(text)) return true;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;

  const hasListLikeLine = lines.some((line) => /^(\d+[.)]|[-*•])\s+/.test(line) || /^[1-9]️⃣/.test(line));
  if (hasListLikeLine) return true;

  const hasPathLabel = lines.some((line) => /(path)\s*:/i.test(line));
  if (hasPathLabel) return true;

  return false;
}

function isTaskReadinessMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (shouldTreatDirectChatAsTask(normalized, "chat")) return true;
  const readinessPatterns = [/(go ahead|can proceed|ready to start|start this)/i];
  return readinessPatterns.some((pattern) => pattern.test(normalized));
}

type RecentCeoMessage = {
  content: string;
  messageType?: string | null;
  createdAt?: number | null;
};

export function resolveContextualTaskMessage(
  currentMessage: string,
  recentCeoMessages: RecentCeoMessage[],
  recentAgentMessages: Array<{ content: string; createdAt?: number | null }> = [],
): string | null {
  const kickoff = isTaskKickoffMessage(currentMessage);
  const affirmative = isAffirmativeReply(currentMessage);
  if (!kickoff && !affirmative) return null;
  const current = currentMessage.trim();

  const escalationPromptTs = recentAgentMessages
    .filter((row) => isAgentEscalationPrompt(row.content))
    .map((row) => row.createdAt ?? 0)
    .sort((a, b) => b - a)[0];
  if (affirmative && !kickoff && !escalationPromptTs) return null;

  for (const row of recentCeoMessages) {
    const candidate = (row.content || "").trim();
    if (!candidate) continue;
    if (candidate === current) continue;
    if (affirmative && escalationPromptTs) {
      const candidateTs = row.createdAt ?? 0;
      if (candidateTs > escalationPromptTs) continue;
    }
    if (shouldTreatDirectChatAsTask(candidate, row.messageType ?? "chat") || isTaskReadinessMessage(candidate)) {
      return candidate;
    }
  }
  return null;
}

function splitSentences(text: string): string[] {
  return (
    text
      .match(/[^.!?…。！？]+[.!?…。！？]?/gu)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? [text.trim()]
  ).filter(Boolean);
}

function collapseAdjacentRepeatedSentenceBlocks(sentences: string[]): string[] {
  const next = [...sentences];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let blockSize = Math.floor(next.length / 2); blockSize >= 1; blockSize -= 1) {
      for (let start = 0; start + blockSize * 2 <= next.length; start += 1) {
        let equal = true;
        for (let i = 0; i < blockSize; i += 1) {
          if (next[start + i] !== next[start + blockSize + i]) {
            equal = false;
            break;
          }
        }
        if (equal) {
          next.splice(start + blockSize, blockSize);
          changed = true;
          break outer;
        }
      }
    }
  }
  return next;
}

export function normalizeAgentReply(content: string): string {
  const trimmed = (content || "").trim();
  if (!trimmed) return "";

  const mergedWhitespace = trimmed
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
  if (!mergedWhitespace) return "";

  const repeatedBlock = mergedWhitespace.match(/^(.{6,}?)(?:\s+\1)+$/su);
  if (repeatedBlock?.[1]) {
    return repeatedBlock[1].trim();
  }

  const lines = mergedWhitespace
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 2 && lines.every((line) => line === lines[0])) {
    return lines[0];
  }

  const dedupedSentences = collapseAdjacentRepeatedSentenceBlocks(splitSentences(mergedWhitespace));
  const sentenceNormalized = dedupedSentences.join(" ").trim();
  return sentenceNormalized || mergedWhitespace;
}
