import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { ensureBusinessProfilesSchema } from "./routes/ops/business-profiles.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { addMemory, ensureAgentMemorySchema } from "./agent-memory.ts";
import { buildReferenceBlock } from "./agent-knowledge.ts";
import { captureTaskLessons, lessonCoverage, parseLessonLines } from "./task-lessons.ts";
import {
  AUTO_END,
  AUTO_START,
  buildAutoSection,
  mergeAutoSection,
  syncSystemsRegistry,
} from "./systems-registry-sync.ts";
import { createMeetingPromptTools } from "./workflow/core/meeting-prompt-tools.ts";
import { buildProposalPrompt } from "./agent-proposals.ts";
import type { AgentRow } from "./workflow/core/conversation-types.ts";

let knowledgeDir: string;
beforeAll(() => {
  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-knowledge-everywhere-"));
  fs.writeFileSync(
    path.join(knowledgeDir, "systems.md"),
    "# Systems registry\n\n## Summary\n\n- ATLAS app on port 8800.\n\n## Owner notes\n\nKeep this line.\n",
  );
  process.env.KNOWLEDGE_DIR = knowledgeDir;
});
afterAll(() => {
  delete process.env.KNOWLEDGE_DIR;
  fs.rmSync(knowledgeDir, { recursive: true, force: true });
});

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  ensureBusinessProfilesSchema(db);
  ensureAutonomySchema(db);
  ensureAgentMemorySchema(db);
  db.exec(`
    UPDATE business_profiles SET name='Primrose Events', services='Flower Wall $250.' WHERE business='rental';
    INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at,business)
      VALUES ('p-rental','Primrose site','C:/sites/primrose','Get more flower wall bookings',1,1,'rental');
    INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex');
    INSERT INTO tasks (id,title,description,status,assigned_agent_id,project_id,created_at,updated_at)
      VALUES ('t1','Improve flower wall page','Rewrite the flower wall section','in_progress','worker','p-rental',1,1),
             ('t2','Tidy scripts','Shared scripts','in_progress','worker',NULL,1,1),
             ('t3','Write FAQ','FAQ page','in_progress','worker','p-rental',1,1);`);
  addMemory(db, {
    kind: "lesson",
    scope: "business",
    business: "rental",
    title: "Flower wall photos",
    body: "Use the white flower wall photos; the red ones look dated.",
  });
  return db;
}

const agent = (overrides: Partial<AgentRow> = {}): AgentRow =>
  ({
    id: "worker",
    name: "Worker",
    role: "senior",
    personality: null,
    status: "idle",
    department_id: "dev",
    current_task_id: null,
    avatar_emoji: "",
    cli_provider: "codex",
    ...overrides,
  }) as AgentRow;

describe("knowledge outside task prompts", () => {
  it("builds a no-tools block with the project goal, business and matching memories", () => {
    const db = harness();
    const block = buildReferenceBlock(db, { taskId: "t1", query: "flower wall" });
    expect(block).toContain("[Knowledge, reference only]");
    expect(block).toContain("Get more flower wall bookings");
    expect(block).toContain("Primrose Events");
    expect(block).toContain("Flower wall photos");
    expect(block).toContain("ATLAS app on port 8800");
    expect(block).not.toContain("memory.add");
    expect(
      Buffer.byteLength(buildReferenceBlock(db, { taskId: "t1", query: "flower wall", maxBytes: 400 })),
    ).toBeLessThanOrEqual(400);
  });

  it("adds knowledge to meeting turns and 1:1 replies, and survives a failing lookup", () => {
    const db = harness();
    const base = {
      getDeptName: () => "Development",
      getDeptRoleConstraint: () => "",
      getRoleLabel: () => "Senior",
      getRecentConversationContext: () => "",
      getAgentDisplayName: (a: AgentRow) => a.name,
      formatMeetingTranscript: () => "",
      compactTaskDescriptionForMeeting: () => "",
      normalizeMeetingLang: () => "en" as const,
      localeInstruction: () => "Respond in English.",
      resolveLang: () => "en",
    };
    const tools = createMeetingPromptTools({
      ...base,
      knowledgeBlock: ({ taskId, query }) => buildReferenceBlock(db, { taskId, query }),
    });
    const meeting = tools.buildMeetingPrompt(agent(), {
      taskId: "t1",
      meetingType: "planned",
      round: 1,
      taskTitle: "Improve flower wall page",
      taskDescription: null,
      transcript: [],
      turnObjective: "Kickoff",
      lang: "en",
    });
    expect(meeting).toContain("Get more flower wall bookings");
    const reply = tools.buildDirectReplyPrompt(
      agent({ current_task_id: "t1" }),
      "How is the flower wall page?",
      "chat",
    );
    expect(reply.prompt).toContain("Flower wall photos");

    const broken = createMeetingPromptTools({
      ...base,
      knowledgeBlock: () => {
        throw new Error("db closed");
      },
    });
    expect(broken.buildDirectReplyPrompt(agent(), "hello", "chat").prompt).toContain("CEO message: hello");
  });

  it("puts knowledge in the think-loop prompt", () => {
    const prompt = buildProposalPrompt(
      { id: "a", name: "Iris", role: "senior", personality: null, department_id: "design" } as never,
      {
        department: null,
        projects: [],
        recentTasks: [],
        openDepartmentTasks: [],
        pastProposals: [],
        businesses: [],
        knowledge: "[Knowledge, reference only]\n[Memory] Use the white photos",
      },
    );
    expect(prompt).toContain("Use the white photos");
  });
});

describe("lessons at task end", () => {
  it("reads LESSON and FACT lines and a declared none", () => {
    const parsed = parseLessonLines(
      "Done.\nLESSON: Check image sizes | Resize hero images to 1600px before upload.\n- FACT: Booking form | Lives in src/forms/booking.tsx\nLESSON: none",
    );
    expect(parsed.lessons).toEqual([
      { kind: "lesson", title: "Check image sizes", body: "Resize hero images to 1600px before upload." },
      { kind: "fact", title: "Booking form", body: "Lives in src/forms/booking.tsx" },
    ]);
    expect(parsed.declaredNone).toBe(true);
  });

  it("saves lessons from the final output as unreviewed project memories, and records every outcome", () => {
    const db = harness();
    expect(
      captureTaskLessons(db, {
        taskId: "t1",
        agentId: "worker",
        output: "LESSON: Check image sizes | Resize hero images to 1600px before upload.",
      }),
    ).toEqual({ outcome: "captured", saved: 1 });
    const saved = db
      .prepare(
        "SELECT scope, project_id, reviewed_at, source_task_id FROM agent_memories WHERE title='Check image sizes'",
      )
      .get();
    expect(saved).toEqual({ scope: "project", project_id: "p-rental", reviewed_at: null, source_task_id: "t1" });

    // The agent already used memory.add on t3: nothing more is taken.
    addMemory(
      db,
      { kind: "fact", scope: "global", title: "FAQ source", body: "FAQ answers come from the owner's notes." },
      { taskId: "t3" },
    );
    expect(
      captureTaskLessons(db, { taskId: "t3", agentId: "worker", output: "LESSON: Extra one | Should not be saved." })
        .outcome,
    ).toBe("agent_added");
    expect(captureTaskLessons(db, { taskId: "t2", agentId: "worker", output: "All done." }).outcome).toBe("missing");

    const coverage = lessonCoverage(db);
    expect(coverage.counts).toEqual({ agent_added: 1, captured: 1, none_declared: 0, missing: 1 });
    expect(coverage.recentMissing.map((item) => item.title)).toEqual(["Tidy scripts"]);
  });

  it("refuses lessons that look like secrets and never throws", () => {
    const db = harness();
    const result = captureTaskLessons(db, {
      taskId: "t2",
      agentId: "worker",
      output: "LESSON: Deploy key | password: hunter2hunter2 is the admin password",
    });
    expect(result.saved).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE source_task_id='t2'").get()).toEqual({ n: 0 });
  });
});

describe("systems registry sync", () => {
  it("lists projects, accounts and hosts without any secret column", () => {
    const db = harness();
    db.exec(`
      CREATE TABLE homelab_ssh_targets (id TEXT, name TEXT, host TEXT, ssh_user TEXT, port INTEGER, enabled INTEGER,
        auth_method TEXT, credential_enc TEXT);
      INSERT INTO homelab_ssh_targets VALUES ('h1','Media','10.0.60.35','atlas',22,1,'password','SECRET-CIPHERTEXT');
      CREATE TABLE github_accounts (id TEXT, label TEXT, business TEXT, login TEXT, token_enc TEXT, is_default INTEGER,
        last_test_ok INTEGER);
      INSERT INTO github_accounts VALUES ('g1','Tech GitHub','tech','tech-bot','SECRET-TOKEN',1,1);`);
    const section = buildAutoSection(db);
    expect(section).toContain("Primrose site, business rental, C:/sites/primrose");
    expect(section).toContain("Media, atlas@10.0.60.35:22, password auth");
    expect(section).toContain("Tech GitHub, login tech-bot, for tech, default, test passed");
    expect(section).not.toContain("SECRET");
  });

  it("rewrites only its own section and leaves the owner's text alone", () => {
    const db = harness();
    const file = path.join(knowledgeDir, "systems.md");
    expect(syncSystemsRegistry(db, file)).toBe("updated");
    expect(syncSystemsRegistry(db, file)).toBe("unchanged");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("Keep this line.");
    expect(text.indexOf(AUTO_START)).toBeGreaterThan(text.indexOf("Keep this line."));
    const replaced = mergeAutoSection(text, "## Current setup\n\nnew");
    expect(replaced.split(AUTO_START).length).toBe(2);
    expect(replaced).toContain(`${AUTO_START}\n## Current setup\n\nnew\n${AUTO_END}`);
    expect(syncSystemsRegistry(db, path.join(knowledgeDir, "missing.md"))).toBe("no_registry");
  });
});
