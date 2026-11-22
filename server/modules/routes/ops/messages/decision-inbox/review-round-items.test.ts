import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../../bootstrap/schema/task-schema-migrations.ts";
import { createReviewRoundDecisionItems } from "./review-round-items.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function setup() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at) VALUES ('p1','Etsy Shop','C:/x','Sell',1,1);
    INSERT INTO tasks (id,title,status,project_id,created_at,updated_at) VALUES ('t1','Baby shower bundle','review','p1',1,1);`);
  db.prepare(
    "INSERT INTO meeting_minutes (id,task_id,meeting_type,round,title,status,started_at,completed_at,created_at) VALUES ('m1','t1','review',1,'Review','revision_requested',10,20,10)",
  ).run();
  const long = (who: string, text: string) => `${text} ${"and the print files need checking. ".repeat(10)}`.trim();
  const entries = [
    ["Design", "Iris", long("Iris", "Revision is needed before Design approval: show all five games")],
    ["Development", "Marcus", "Revision is needed: provide a build manifest."],
    ["Design", "Iris", long("Iris", "I'm holding Design approval until the five games and previews are back")],
  ];
  entries.forEach(([department, speaker, content], seq) =>
    db
      .prepare(
        "INSERT INTO meeting_minute_entries (meeting_id,seq,speaker_name,department_name,message_type,content,created_at) VALUES ('m1',?,?,?,'chat',?,?)",
      )
      .run(seq, speaker, department, content, seq),
  );
  // Saved notes as older versions stored them: two per speaker, cut at 220 characters.
  entries.forEach(([department, speaker, content], index) => {
    const note = `${department} ${speaker}: ${content}`;
    const stored = note.length > 220 ? `${note.slice(0, 219).trimEnd()}…` : note;
    db.prepare(
      "INSERT INTO review_revision_history (task_id,normalized_note,raw_note,first_round,created_at) VALUES ('t1',?,?,1,?)",
    ).run(`n${index}`, stored, index);
  });
  const queue = vi.fn();
  const items = createReviewRoundDecisionItems({
    db,
    nowMs: () => 100_000,
    getPreferredLanguage: () => "en",
    pickL: (lines: { en: string[] }) => lines.en[0],
    l: (en: string[]) => ({ en }),
    buildReviewRoundSnapshotHash: () => "hash",
    getReviewRoundDecisionState: () => ({ snapshot_hash: "hash", status: "ready", planner_summary: "Pick 1, skip 2." }),
    upsertReviewRoundDecisionState: vi.fn(),
    resolvePlanningLeadMeta: () => ({
      agent_id: "a1",
      agent_name: "Charlotte",
      agent_name_ko: null,
      agent_avatar: null,
    }),
    formatPlannerSummaryForDisplay: (text: string) => text,
    queueReviewRoundPlanningConsolidation: queue,
  } as never);
  return items.buildReviewRoundDecisionItems();
}

describe("review round decision options", () => {
  it("offers each team lead once, with their latest note in full, and does not repeat the options in the message", () => {
    const [item] = setup();
    const labels = item.options.filter((o) => o.action === "apply_review_pick").map((o) => o.label);
    expect(labels).toHaveLength(2);
    expect(labels[0].startsWith("Design Iris: I'm holding Design approval")).toBe(true);
    expect(labels[0].endsWith("…")).toBe(false);
    expect(labels[0].length).toBeGreaterThan(220);
    expect(labels[1]).toBe("Development Marcus: Revision is needed: provide a build manifest.");
    expect(item.summary).toContain("Charlotte's take:");
    expect(item.summary).toContain("Pick 1, skip 2.");
    expect(item.summary).not.toContain("Available options now");
    expect(item.summary).not.toContain("cherry-pick");
  });
});
