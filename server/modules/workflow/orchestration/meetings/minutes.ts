import type { Lang } from "../../../../types/lang.ts";
import { randomUUID } from "node:crypto";

/** Longest review note kept as a decision option. */
const REVIEW_NOTE_MAX_CHARS = 1200;

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

  function collectRevisionMemoItems(
    transcript: MeetingTranscriptEntry[],
    maxItems = REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    maxPerDepartment = REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
  ): string[] {
    // One option per speaker: their latest stance in the round replaces their opening one, so a leader who spoke
    // twice is not offered twice. Kept whole up to REVIEW_NOTE_MAX_CHARS (it used to stop at 220 characters).
    void maxPerDepartment;
    const isIssue = (text: string) =>
      /0%|hold|revise|revision|required|pending|risk|block|missing|not attached|incomplete/i.test(text);
    const latest = new Map<string, string>();
    for (const row of transcript) {
      const base = row.content.replace(/\s+/g, " ").trim();
      if (!base || !isIssue(base)) continue;
      const speakerKey = `${row.department}|${row.speaker}`.toLowerCase();
      const note = `${row.department} ${row.speaker}: ${base}`;
      latest.delete(speakerKey);
      latest.set(
        speakerKey,
        note.length > REVIEW_NOTE_MAX_CHARS ? `${note.slice(0, REVIEW_NOTE_MAX_CHARS - 1).trimEnd()}…` : note,
      );
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const note of latest.values()) {
      const normalized = normalizeRevisionMemoNote(note);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(note);
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
      out.push(note.length > REVIEW_NOTE_MAX_CHARS ? `${note.slice(0, REVIEW_NOTE_MAX_CHARS - 1).trimEnd()}…` : note);
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

  return {
    beginMeetingMinutes,
    appendMeetingMinuteEntry,
    finishMeetingMinutes,
    normalizeRevisionMemoNote,
    collectRevisionMemoItems,
    collectPlannedActionItems,
    appendTaskProjectMemo,
  };
}
