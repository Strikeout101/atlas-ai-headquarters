import type { Lang } from "../../../types/lang.ts";
import { getContextRollover } from "../agents/context-rollover-store.ts";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    all: (...args: any[]) => unknown;
  };
};

type CreateConversationContextToolsDeps = {
  db: DbLike;
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  summarizeForMeetingBubble: (text: string, maxChars?: number, lang?: Lang) => string;
};

export function createConversationContextTools(deps: CreateConversationContextToolsDeps) {
  const { db, normalizeStreamChunk, summarizeForMeetingBubble } = deps;

  function getRecentConversationContext(agentId: string, limit = 10): string {
    const msgs = db
      .prepare(
        `
    SELECT sender_type, sender_id, content, message_type, created_at
    FROM messages
    WHERE (
      (sender_type = 'ceo' AND receiver_type = 'agent' AND receiver_id = ?)
      OR (sender_type = 'agent' AND sender_id = ?)
      OR (receiver_type = 'all')
    )
    ORDER BY created_at DESC
    LIMIT ?
  `,
      )
      .all(agentId, agentId, limit) as Array<{
      sender_type: string;
      sender_id: string | null;
      content: string;
      message_type: string;
      created_at: number;
    }>;

    if (msgs.length === 0) return "";

    const lines = msgs.reverse().map((m) => {
      const role = m.sender_type === "ceo" ? "CEO" : "Agent";
      const type = m.message_type !== "chat" ? ` [${m.message_type}]` : "";
      return `${role}${type}: ${m.content}`;
    });

    return `\n\n--- Recent conversation context ---\n${lines.join("\n")}\n--- End context ---`;
  }

  function extractLatestProjectMemoBlock(description: string, maxChars = 1600): string {
    if (!description) return "";
    const marker = "[PROJECT MEMO]";
    const idx = description.lastIndexOf(marker);
    if (idx < 0) return "";
    const block = description
      .slice(idx)
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!block) return "";
    return block.length > maxChars ? `...${block.slice(-maxChars)}` : block;
  }

  function getTaskContinuationContext(taskId: string): string {
    try {
      const rollover = getContextRollover(db as any, taskId);
      if (rollover && rollover.status !== "complete") {
        return `\n\n--- Durable context rollover checkpoint ---\n${rollover.checkpointText}\n--- End checkpoint ---`;
      }
    } catch {
      // Older isolated test databases may not have the optional rollover schema.
    }
    const runCountRow = db
      .prepare(
        `
    SELECT COUNT(*) AS cnt
    FROM task_logs
    WHERE task_id = ?
      AND kind = 'system'
      AND message LIKE 'RUN start%'
  `,
      )
      .get(taskId) as { cnt: number } | undefined;
    if ((runCountRow?.cnt ?? 0) === 0) return "";

    const taskRow = db.prepare("SELECT description, result FROM tasks WHERE id = ?").get(taskId) as
      | { description: string | null; result: string | null }
      | undefined;

    const latestRunSummary = db
      .prepare(
        `
    SELECT message
    FROM task_logs
    WHERE task_id = ?
      AND kind = 'system'
      AND (message LIKE 'RUN completed%' OR message LIKE 'RUN failed%')
    ORDER BY created_at DESC
    LIMIT 1
  `,
      )
      .get(taskId) as { message: string } | undefined;

    const latestHandoff = db
      .prepare(
        `SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE 'HANDOFF:%' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as { message: string } | undefined;

    // The last review that asked for changes (task-review.ts), so a resumed run knows what to fix.
    let reviewItems: string[] = [];
    try {
      const lastChanges = db
        .prepare(
          "SELECT items_json FROM task_reviews WHERE task_id = ? AND status = 'changes' ORDER BY created_at DESC LIMIT 1",
        )
        .get(taskId) as { items_json: string } | undefined;
      reviewItems = lastChanges ? (JSON.parse(lastChanges.items_json) as string[]) : [];
    } catch {
      reviewItems = []; // reviews not set up in this database
    }

    const unresolvedLines = reviewItems
      .map((item) => String(item).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 6);

    const memoBlock = extractLatestProjectMemoBlock(taskRow?.description ?? "", 900);
    const normalizedResult = normalizeStreamChunk(taskRow?.result ?? "", { dropCliNoise: true }).trim();
    const resultTail = normalizedResult.length > 900 ? `...${normalizedResult.slice(-900)}` : normalizedResult;

    const lines: string[] = [];
    if (latestHandoff?.message) lines.push(latestHandoff.message);
    if (latestRunSummary?.message) lines.push(`Last run: ${latestRunSummary.message}`);
    if (unresolvedLines.length > 0) {
      lines.push("The last review asked for:");
      lines.push(...unresolvedLines.map((line) => `- ${line}`));
    }
    if (memoBlock) {
      lines.push("Latest project memo excerpt:");
      lines.push(memoBlock);
    }
    if (resultTail) {
      lines.push("Previous run output tail:");
      lines.push(resultTail);
    }
    if (lines.length === 0) return "";

    return `\n\n--- Continuation brief (same owner, same task) ---\n${lines.join("\n")}\n--- End continuation brief ---`;
  }

  return {
    getRecentConversationContext,
    extractLatestProjectMemoBlock,
    getTaskContinuationContext,
  };
}
