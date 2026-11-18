import type { Lang } from "../../../../types/lang.ts";
import { randomUUID } from "node:crypto";

interface AgentRow {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
}

export type MeetingTranscriptEntry = {
  speaker_agent_id: string;
  speaker: string;
  department: string;
  role: string;
  content: string;
};

type MeetingMinutesDeps = {
  db: any;
  nowMs: () => number;
  getDeptName: (departmentId: string) => string;
  getRoleLabel: (role: string, lang: Lang) => string;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  pickL: (choices: any, lang: string) => string;
  l: (en: string[]) => any;
  summarizeForMeetingBubble: (text: string, maxChars: number, lang?: Lang) => string;
  appendTaskLog: (taskId: string | null, kind: string, message: string) => void;
  broadcast: (event: string, payload: unknown) => void;
  REVIEW_MAX_MEMO_ITEMS_PER_ROUND: number;
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT: number;
};

export function createMeetingMinutesTools(deps: MeetingMinutesDeps) {
  const {
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
  } = deps;

  function beginMeetingMinutes(
    taskId: string,
    meetingType: "planned" | "review",
    round: number,
    title: string,
  ): string {
    const meetingId = randomUUID();
    const t = nowMs();
    db.prepare(
      `
    INSERT INTO meeting_minutes (id, task_id, meeting_type, round, title, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)
  `,
    ).run(meetingId, taskId, meetingType, round, title, t, t);
    return meetingId;
  }

  function appendMeetingMinuteEntry(
    meetingId: string,
    seq: number,
    agent: AgentRow,
    lang: string,
    messageType: string,
    content: string,
  ): void {
    const deptName = getDeptName(agent.department_id ?? "");
    const roleLabel = getRoleLabel(agent.role, lang as Lang);
    db.prepare(
      `
    INSERT INTO meeting_minute_entries
      (meeting_id, seq, speaker_agent_id, speaker_name, department_name, role_label, message_type, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(
      meetingId,
      seq,
      agent.id,
      getAgentDisplayName(agent, lang),
      deptName || null,
      roleLabel || null,
      messageType,
      content,
      nowMs(),
    );
  }

  function finishMeetingMinutes(meetingId: string, status: "completed" | "revision_requested" | "failed"): void {
    db.prepare("UPDATE meeting_minutes SET status = ?, completed_at = ? WHERE id = ?").run(status, nowMs(), meetingId);
  }

  function normalizeRevisionMemoNote(note: string): string {
    const trimmed = note
      .replace(/\s+/g, " ")
      .replace(/^[\s\-*0-9.)]+/, "")
      .trim()
      .toLowerCase();
    const withoutPrefix = trimmed.replace(/^[^:]{1,80}:\s*/, "");
    const normalized = withoutPrefix
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalized || withoutPrefix || trimmed;
  }

  function reserveReviewRevisionMemoItems(
    taskId: string,
    round: number,
    memoItems: string[],
  ): { freshItems: string[]; duplicateCount: number } {
    if (memoItems.length === 0) return { freshItems: [], duplicateCount: 0 };
    const now = nowMs();
    const freshItems: string[] = [];
    let duplicateCount = 0;
    const insert = db.prepare(`
    INSERT OR IGNORE INTO review_revision_history
      (task_id, normalized_note, raw_note, first_round, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

    for (const raw of memoItems) {
      const note = raw.replace(/\s+/g, " ").trim();
      if (!note) continue;
      const normalized = normalizeRevisionMemoNote(note);
      if (!normalized) continue;
      const result = insert.run(taskId, normalized, note, round, now) as { changes?: number } | undefined;
      if ((result?.changes ?? 0) > 0) {
        freshItems.push(note);
      } else {
        duplicateCount += 1;
      }
    }
    return { freshItems, duplicateCount };
  }

  function loadRecentReviewRevisionMemoItems(taskId: string, maxItems = 4): string[] {
    const rows = db
      .prepare(
        `
    SELECT raw_note
    FROM review_revision_history
    WHERE task_id = ?
    ORDER BY first_round DESC, id DESC
    LIMIT ?
  `,
      )
      .all(taskId, maxItems) as Array<{ raw_note: string }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const note = row.raw_note.replace(/\s+/g, " ").trim();
      if (!note) continue;
      const key = note.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(note);
    }
    return out;
  }

  function collectRevisionMemoItems(
    transcript: MeetingTranscriptEntry[],
    maxItems = REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    maxPerDepartment = REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  ): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const perDept = new Map<string, number>();
    const isIssue = (text: string) =>
      /0%|hold|revise|revision|required|pending|risk|block|missing|not attached|incomplete/i.test(text);

    for (const row of transcript) {
      const base = row.content.replace(/\s+/g, " ").trim();
      if (!base || !isIssue(base)) continue;
      const deptKey = row.department.replace(/\s+/g, " ").trim().toLowerCase() || "unknown";
      const deptCount = perDept.get(deptKey) ?? 0;
      if (deptCount >= maxPerDepartment) continue;
      const note = `${row.department} ${row.speaker}: ${base}`;
      const normalized = normalizeRevisionMemoNote(note);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      perDept.set(deptKey, deptCount + 1);
      out.push(note.length > 220 ? `${note.slice(0, 219).trimEnd()}…` : note);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function collectPlannedActionItems(transcript: MeetingTranscriptEntry[], maxItems = 10): string[] {
    const riskFirst = collectRevisionMemoItems(transcript, maxItems);
    if (riskFirst.length > 0) return riskFirst;

    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of transcript) {
      const base = row.content.replace(/\s+/g, " ").trim();
      if (!base || base.length < 8) continue;
      const note = `${row.department} ${row.speaker}: ${base}`;
      const normalized = note.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(note.length > 220 ? `${note.slice(0, 219).trimEnd()}…` : note);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function appendTaskProjectMemo(
    taskId: string,
    phase: "planned" | "review",
    round: number,
    notes: string[],
    lang: string,
  ): void {
    const current = db.prepare("SELECT description, title FROM tasks WHERE id = ?").get(taskId) as
      | {
          description: string | null;
          title: string;
        }
      | undefined;
    if (!current) return;

    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const phaseLabel = phase === "planned" ? "Planned Kickoff" : "Review";
    const header = `[PROJECT MEMO] ${phaseLabel} round ${round} unresolved improvement items (${stamp})`;
    const fallbackLine = "- No explicit issue line captured; follow-up verification is still required.";
    const body = notes.length > 0 ? notes.map((note) => `- ${note}`).join("\n") : fallbackLine;

    const block = `${header}\n${body}`;
    const existing = current.description ?? "";
    const next = existing ? `${existing}\n\n${block}` : block;
    const trimmed = next.length > 18_000 ? next.slice(next.length - 18_000) : next;

    db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(trimmed, nowMs(), taskId);
    appendTaskLog(taskId, "system", `Project memo appended (${phase} round ${round}, items=${notes.length})`);
    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  }

  function appendTaskReviewFinalMemo(
    taskId: string,
    round: number,
    transcript: MeetingTranscriptEntry[],
    lang: string,
    hasResidualRisk: boolean,
  ): void {
    const current = db.prepare("SELECT description FROM tasks WHERE id = ?").get(taskId) as
      | {
          description: string | null;
        }
      | undefined;
    if (!current) return;

    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const header = `[PROJECT MEMO] Review round ${round} final package (${stamp})`;
    const decisionLine = hasResidualRisk
      ? pickL(l(["Finalized with conditional approval and documented residual risks."]), lang as Lang)
      : pickL(l(["Final approval completed based on full leader alignment and merge readiness."]), lang as Lang);

    const evidence: string[] = [];
    const seen = new Set<string>();
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const row = transcript[i];
      const clipped = summarizeForMeetingBubble(row.content, 140, lang as Lang);
      if (!clipped) continue;
      const line = `${row.department} ${row.speaker}: ${clipped}`;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(line);
      if (evidence.length >= 6) break;
    }

    const bodyLines = [decisionLine, ...evidence];
    const block = `${header}\n${bodyLines.map((line) => `- ${line}`).join("\n")}`;
    const existing = current.description ?? "";
    const next = existing ? `${existing}\n\n${block}` : block;
    const trimmed = next.length > 18_000 ? next.slice(next.length - 18_000) : next;

    db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(trimmed, nowMs(), taskId);
    appendTaskLog(
      taskId,
      "system",
      `Project memo appended (review round ${round}, final package, residual_risk=${hasResidualRisk ? "yes" : "no"})`,
    );
    broadcast("task_update", db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
  }

  return {
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
    appendTaskReviewFinalMemo,
  };
}
