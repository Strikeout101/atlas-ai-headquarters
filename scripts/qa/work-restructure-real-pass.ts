/** Phase 9 real-model QA. Fresh synthetic data only; never connects to the live ATLAS database or service. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyBaseSchema } from "../../server/modules/bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../server/modules/bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "../../server/modules/bootstrap/schema/work-model-migration.ts";
import { ensureControlStateSchema } from "../../server/modules/control-state.ts";
import { RESEARCH_ANGLES, saveStrategy } from "../../server/modules/goal-strategy.ts";
import { proposeInitiative } from "../../server/modules/playbooks.ts";
import { ensureReviewSchema, startReview, taskReviews } from "../../server/modules/task-review.ts";
import { ensureWorkEngineSchema, maybeStartSynthesis, startResearchPhase } from "../../server/modules/work-engine.ts";
import { saveHandoff } from "../../server/modules/work-model.ts";
import type { AgentRow } from "../../server/modules/workflow/core/conversation-types.ts";

type Row = Record<string, unknown>;
type SynthesisIdea = {
  title: string;
  description: string;
  demand_score: number;
  revenue_score: number;
  cost_score: number;
  difficulty_score: number;
  time_to_launch_score: number;
  budget: number;
};
type SynthesisResult = { summary: string; ideas: SynthesisIdea[] };
const root = path.resolve(import.meta.dirname, "../..");
const parent = path.join(root, ".tmp", "phase9-real-pass");
const dryRun = !process.argv.includes("--run");
fs.mkdirSync(parent, { recursive: true });
const runDir = path.join(parent, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
const workDir = path.join(runDir, "work");
const researchDir = path.join(workDir, "research");
fs.mkdirSync(researchDir, { recursive: true });
const db = new DatabaseSync(path.join(runDir, "atlas.synthetic.sqlite"));
const now = Date.now();
const goalId = "phase9-synthetic-goal";
const evidence: Row = {
  run_dir: runDir,
  mode: dryRun ? "dry-run" : "real-model",
  started_at: new Date(now).toISOString(),
};

function task(id: string): Row {
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Row | undefined;
  assert.ok(row, `Task ${id} missing`);
  return row;
}

function writeEvidence(): void {
  fs.writeFileSync(path.join(runDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

function parseCodexOutput(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Row;
      const item = event.item as Row | undefined;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string")
        messages.push(item.text);
    } catch {
      // Codex also prints non-JSON diagnostics.
    }
  }
  return messages.at(-1)?.trim() ?? "";
}

async function model(provider: "codex" | "claude", prompt: string, timeoutMs = 360_000): Promise<string> {
  // Both models get read/search tools only. The script, not the model, writes research notes and records.
  const args =
    provider === "codex"
      ? [
          "--search",
          "exec",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--ephemeral",
          "--json",
          "--sandbox",
          "read-only",
        ]
      : [
          "--restricted",
          "--strict-mcp-config",
          "--print",
          "--output-format",
          "text",
          "--tools=Read,Grep,Glob,WebSearch",
        ];
  // Keep subscription login paths, but never pass ATLAS or business credentials to a model process.
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "TEMP",
    "TMP",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "LANG",
    "TERM",
  ])
    if (process.env[key]) safeEnv[key] = process.env[key];
  safeEnv.NO_COLOR = "1";
  safeEnv.CI = "1";
  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(provider, args, {
      cwd: workDir,
      shell: process.platform === "win32",
      windowsHide: true,
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(prompt);
  });
  if (output.code !== 0)
    throw new Error(`${provider} exited ${output.code}: ${(output.stderr || output.stdout).trim().slice(-600)}`);
  const text = provider === "codex" ? parseCodexOutput(output.stdout) : output.stdout.trim();
  if (!text) throw new Error(`${provider} returned no final text: ${output.stderr.slice(-600)}`);
  return text;
}

function countSources(markdown: string): number {
  return new Set(markdown.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).size;
}

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseJson(text: string): SynthesisResult {
  const clean = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(clean) as SynthesisResult;
}

function assertNoSideEffects(): void {
  for (const name of ["spend_requests", "business_email_approvals", "listing_packages", "etsy_shop_changes"]) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (exists) assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n, 0, name);
  }
}

try {
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureWorkEngineSchema(db);
  ensureReviewSchema(db);
  db.exec(`
    INSERT INTO departments(id,name,name_ko,name_ja,name_zh,icon,color,sort_order)
      VALUES ('planning','Planning','','','','','#334455',1);
    INSERT INTO agents(id,name,role,department_id,cli_provider,status,created_at)
      VALUES ('codex-lead','Codex researcher','team_leader','planning','codex','idle',1),
             ('claude-senior','Claude researcher','senior','planning','claude','idle',2);
  `);
  db.prepare(
    `INSERT INTO business_goals(id,business,title,metric,target,period_start,period_end,initiative_slots,created_at,updated_at)
     VALUES (?,?,?,? ,?,?,?,3,?,?)`,
  ).run(
    goalId,
    "ventures",
    "Synthetic digital template research",
    "verified_revenue",
    1000,
    now - 1000,
    now + 30 * 86_400_000,
    now,
    now,
  );
  const goal = db.prepare("SELECT * FROM business_goals WHERE id=?").get(goalId) as Row;
  const ids = startResearchPhase(db, goal, "isolated Phase 9 verification", now);
  assert.equal(ids.length, RESEARCH_ANGLES.length);
  evidence.assignments = ids.map((id) => ({ id, title: task(id).title, agent: task(id).assigned_agent_id }));
  assert.ok(new Set(ids.map((id) => task(id).assigned_agent_id)).size >= 2, "Both models must research");
  writeEvidence();
  if (dryRun) {
    console.log(`Dry run ready: ${runDir}`);
    console.log(
      "No model calls made. Run `pnpm exec tsx scripts/qa/work-restructure-real-pass.ts --run` for the real pass.",
    );
  } else {
    for (const [index, id] of ids.entries()) {
      const row = task(id);
      const angle = RESEARCH_ANGLES[index];
      const provider = row.assigned_agent_id === "codex-lead" ? "codex" : "claude";
      const prompt = `${row.description}\n\nPHASE 9 TEST RULES: This is synthetic research. Use public web search only. Do not call ATLAS, Etsy, email, payment, shell, or business tools. Do not write files. Return the complete contents for research/${angle.key}.md as your final Markdown answer; the test runner saves it. Include at least 10 distinct linked, dated sources and distinguish MEASURED facts from ESTIMATE judgements.`;
      const note = await model(provider, prompt);
      assert.ok(countSources(note) >= 10, `${angle.key} has fewer than 10 distinct source URLs`);
      assert.match(note, /MEASURED/i);
      assert.match(note, /ESTIMATE/i);
      const filename = path.join(researchDir, `${angle.key}.md`);
      fs.writeFileSync(filename, note);
      saveHandoff(
        db,
        id,
        {
          summary: `${angle.title}: ${countSources(note)} public sources checked.`,
          files: [`research/${angle.key}.md`],
          numbers: { sources: countSources(note) },
        },
        now + index + 1,
      );
      db.prepare("UPDATE tasks SET status='done', work_folder=?, completed_at=? WHERE id=?").run(
        workDir,
        now + index + 1,
        id,
      );
      evidence[`research_${angle.key}`] = { provider, sources: countSources(note), file: filename };
      writeEvidence();
    }
    const synthesisId = maybeStartSynthesis(db, goal, now + 1000);
    assert.ok(synthesisId, "Synthesis was not created");
    const synthesis = task(synthesisId);
    const synthesisProvider = synthesis.assigned_agent_id === "codex-lead" ? "codex" : "claude";
    const synthesisPrompt = `${synthesis.description}\n\nPHASE 9 TEST RULES: Read the five research/*.md files. Do not call ATLAS or business tools; do not write files. Return ONLY JSON: {"summary":"at least 200 characters with measured versus estimated arithmetic and source links","ideas":[{"title":"specific product","description":"evidence and links","demand_score":0,"revenue_score":0,"cost_score":0,"difficulty_score":0,"time_to_launch_score":0,"budget":0}]}. Provide 6 to 10 distinct ideas; the test runner will record them as proposed only.`;
    const result = parseJson(await model(synthesisProvider, synthesisPrompt));
    assert.ok(typeof result.summary === "string" && result.summary.length >= 200);
    assert.ok(Array.isArray(result.ideas) && result.ideas.length >= 6 && result.ideas.length <= 10);
    for (const idea of result.ideas) {
      assert.ok(typeof idea.title === "string" && typeof idea.description === "string");
      for (const score of [
        "demand_score",
        "revenue_score",
        "cost_score",
        "difficulty_score",
        "time_to_launch_score",
      ] as const)
        assert.ok(typeof idea[score] === "number" && Number.isFinite(idea[score]), `${idea.title}: ${score} missing`);
    }
    const strategy = saveStrategy(
      db,
      { summary: result.summary },
      { taskId: synthesisId, agentId: String(synthesis.assigned_agent_id) },
      now + 1100,
    );
    for (const idea of result.ideas)
      proposeInitiative(db, idea, { business: "ventures", goalId, taskId: synthesisId }, now + 1100);
    saveHandoff(
      db,
      synthesisId,
      {
        summary: result.summary.slice(0, 1200),
        files: RESEARCH_ANGLES.map((angle) => `research/${angle.key}.md`),
        numbers: { ideas: result.ideas.length },
      },
      now + 1101,
    );
    db.prepare("UPDATE tasks SET status='review', work_folder=?, updated_at=? WHERE id=?").run(
      workDir,
      now + 1102,
      synthesisId,
    );
    const beforeReview = RESEARCH_ANGLES.map((angle) => fileHash(path.join(researchDir, `${angle.key}.md`)));
    await startReview(
      {
        db,
        runAgentOneShot: async (agent: AgentRow, prompt, opts) => {
          assert.equal(opts.readOnly, true);
          assert.equal(opts.projectPath, workDir);
          const text = await model(agent.cli_provider === "codex" ? "codex" : "claude", prompt);
          return { text };
        },
        startTask: async () => {
          throw new Error("Reviewer requested changes; no automatic retry in this QA harness");
        },
        completeTask: (id) => {
          db.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?").run(Date.now(), id);
        },
        appendTaskLog: () => {},
      },
      synthesisId,
    );
    const review = taskReviews(db, synthesisId);
    assert.ok(
      review.some((item) => item.status === "approved"),
      "Cross-model review did not approve",
    );
    assert.ok(
      review.some((item) => item.same_model === false),
      "Reviewer must be on the other model",
    );
    assert.deepEqual(
      RESEARCH_ANGLES.map((angle) => fileHash(path.join(researchDir, `${angle.key}.md`))),
      beforeReview,
      "Reviewer modified research files",
    );
    assert.equal(strategy.status, "proposed", "Owner strategy approval must remain pending");
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM initiatives WHERE goal_id=? AND status='proposed'").get(goalId) as {
          n: number;
        }
      ).n,
      result.ideas.length,
    );
    assertNoSideEffects();
    evidence.synthesis = {
      id: synthesisId,
      provider: synthesisProvider,
      strategy: strategy.id,
      ideas: result.ideas.length,
    };
    evidence.review = review;
    evidence.completed_at = new Date().toISOString();
    writeEvidence();
    console.log(`Real-model research and cross-model review passed: ${runDir}`);
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  writeEvidence();
  throw error;
} finally {
  db.close();
}
