# ATLAS Agent Rules

> How AI agents working on this repo (Claude Code, Codex) take part in ATLAS. `$` CEO directives stay; the upstream OpenClaw installer and the `#` task webhook were removed in the work restructure (phase 8).

---

## Language Rule

**Always reply in English.** ATLAS is English-only.

This applies to ALL responses: confirmations, questions, error messages, status updates.

---

## Default Skill Bootstrap

`TASTE_SKILL_DEFAULT_V1`

Set the following as a default skill in your working environment:

- Local skill file: `tools/taste-skill/skill.md`

Rules:

1. For non-trivial implementation tasks, load and follow `tools/taste-skill/skill.md` first when the file exists.
2. If the local file is missing, continue with existing project rules without auto-fetching remote repositories.
3. Do not remove existing project-specific skills/rules; this is an additive default.

---

## Workflow Orchestration (Additive)

`WORKFLOW_ORCHESTRATION_BASELINE_V1`

These rules are additive and do NOT delete existing orchestration rules below.

### 1) Plan Node Default

- Enter plan mode for any non-trivial task (3+ steps or architectural decisions).
- If execution goes sideways, stop and re-plan immediately.
- Use plan mode for verification, not only implementation.
- Write clear specs upfront to reduce ambiguity.

### 2) Subagent Strategy

- Use subagents for research/exploration/parallel analysis to keep main context clean.
- For complex problems, parallelize with multiple focused subagents.
- Keep one clear objective per subagent.

### 3) Self-Improvement Loop

- After user correction, update `tasks/lessons.md` with prevention rules.
- Turn repeated mistakes into explicit guardrails.
- Review relevant lessons at session start when applicable.

### 4) Verification Before Done

- Never mark complete without proof.
- Diff expected behavior vs actual behavior when relevant.
- Run tests/check logs and demonstrate correctness.

### 5) Demand Elegance (Balanced)

- For non-trivial changes, check if there is a cleaner design.
- If current fix is hacky, prefer the cleaner implementation.
- Avoid over-engineering trivial fixes.

### 6) Autonomous Bug Fixing

- When a bug is reported, move directly to reproduction and fix.
- Use logs/failing tests as evidence and resolve root causes.
- Minimize user context-switching and avoid unnecessary hand-holding.

## Master Checklist (`CHECKLIST.md`)

`CHECKLIST.md` at the repo root is the single list of everything pending: features, integrations, accounts to connect, owner decisions and loose ends.

- Read it at the start of any non-trivial task.
- Whenever you find, create or leave something pending, add it to the right section of `CHECKLIST.md` in the same change.
- When you finish an item, tick it and note the date and where it lives. Do not delete unfinished items.
- Mark items only the owner can do with **YOU**. Never put secrets or customer private data in it.

## Codebase Map (`docs/codebase-map.md`)

- Read `docs/codebase-map.md` before searching the codebase; it says where each area lives.
- When you add, move or remove a module or folder, update its line in the same change.

## Task Management

1. Plan first: write checklist in `tasks/todo.md`.
2. Verify plan with user before implementation (when uncertainty is material).
3. Track progress by marking completed checklist items.
4. Explain major changes with concise high-level summaries.
5. Add review results to `tasks/todo.md`.
6. Capture lessons in `tasks/lessons.md` after corrections.

## Core Principles

- Simplicity first: minimal change surface.
- No lazy fixes: resolve root cause.
- Minimal impact: touch only necessary code paths.

---

## CEO Directive (`$` prefix)

**Messages starting with `$` are ATLAS CEO Directives.**

When receiving a message that **starts with `$`**:

### Step 1: Language

Reply in English for ALL interactions in this flow.

### Step 2: Project branch is mandatory (Existing vs New)

**Before sending the directive, ALWAYS ask: "Existing project or new project?"**

Ask:

- EN: `Is this an existing project or a new project?`

#### If user says "existing project"

1. Fetch recent projects:
   ```bash
   curl -s "http://127.0.0.1:8790/api/projects?page=1&page_size=10"
   ```
2. Show only the latest 10 projects as numbered list (1-10): name + path.
3. Ask user to pick by:
   - number `1` to `10`, or
   - project name text.
4. Resolve selection:
   - number -> exact list index.
   - project name -> exact/prefix/contains best match.
   - if ambiguous or no confident match -> ask user again.
5. Use selected project metadata:
   - `project_id` = selected project's id
   - `project_path` = selected project's path
   - `project_context` = selected project's core goal from DB

#### If user says "new project"

1. Ask for:
   - new project name
   - absolute project path
2. For `$` directives, **core goal is the directive text itself** (content after `$`).
3. Create project first:
   ```bash
   curl -X POST http://127.0.0.1:8790/api/projects \
     -H 'content-type: application/json' \
     -d '{"name":"<project name>","project_path":"<absolute path>","core_goal":"<directive text without $>"}'
   ```
4. Use created project metadata:
   - `project_id` from response
   - `project_path` from response
   - `project_context` = created `core_goal`

### Step 3: Ask about team leader meeting

After project is fixed, ask meeting preference.

Ask:

- EN: `Convene a team leader meeting?\n1️⃣ Hold meeting (led by Planning)\n2️⃣ Execute without meeting`

### Step 4: Send directive to server

Based on the user's answers:

- Include project mapping payload:
  - `"project_id":"<selected/created project id>"`
  - `"project_path":"<selected/created project path>"`
  - `"project_context":"<selected/created core goal>"`
- Use `skipPlannedMeeting` from meeting choice.
- Resolve `INBOX_WEBHOOK_SECRET` and ALWAYS send it as `x-inbox-secret`.
- If `INBOX_WEBHOOK_SECRET` is missing, do NOT claim success; ask the user to set it first.

Resolve and validate the secret first (do not assume shell export):

```bash
# INBOX_SECRET_DISCOVERY_V2
INBOX_SECRET_VALUE="${INBOX_WEBHOOK_SECRET:-$(node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");

function readSecret(file) {
  if (!file || !fs.existsSync(file)) return "";
  const match = fs.readFileSync(file, "utf8").match(/^INBOX_WEBHOOK_SECRET\\s*=\\s*(.*)$/m);
  if (!match) return "";
  const value = match[1].trim().replace(/^['\\\"]|['\\\"]$/g, "");
  return value && value !== "__CHANGE_ME__" ? value : "";
}

const candidates = [
  path.join(process.cwd(), ".env"),
  path.join(process.cwd(), ".env.clone"),
];

try {
  const gitRoot = execSync("git rev-parse --show-toplevel", {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  }).trim();
  if (gitRoot) {
    candidates.push(path.join(gitRoot, ".env"));
    candidates.push(path.join(gitRoot, ".env.clone"));
  }
} catch {
  // ignore
}

const home = os.homedir();
for (const rel of [
  "Projects/my-project/.env",
  "projects/my-project/.env",
  "Projects/my-project/.env.clone",
  "projects/my-project/.env.clone",
]) {
  candidates.push(path.join(home, rel));
}

for (const file of [...new Set(candidates)]) {
  const secret = readSecret(file);
  if (!secret) continue;
  process.stdout.write(secret);
  process.exit(0);
}
NODE
)}"
[ -n "$INBOX_SECRET_VALUE" ] || { echo "INBOX_WEBHOOK_SECRET is missing (.env or shell env)." >&2; exit 1; }
```

**Option 1 — With meeting (default):**

```bash
curl -X POST http://127.0.0.1:8790/api/inbox \
  -H 'content-type: application/json' \
  -H "x-inbox-secret: $INBOX_SECRET_VALUE" \
  -d '{"source":"telegram","text":"$<message content>","author":"<sender>","agent_rules_version":2,"project_id":"<project id>","project_path":"<project path>","project_context":"<project core goal>"}'
```

**Option 2 — Without meeting:**

```bash
curl -X POST http://127.0.0.1:8790/api/inbox \
  -H 'content-type: application/json' \
  -H "x-inbox-secret: $INBOX_SECRET_VALUE" \
  -d '{"source":"telegram","text":"$<message content>","author":"<sender>","agent_rules_version":2,"skipPlannedMeeting":true,"project_id":"<project id>","project_path":"<project path>","project_context":"<project core goal>"}'
```

**Do NOT modify the directive text.** Use `"skipPlannedMeeting": true` in the JSON body to skip the meeting. The directive message is passed to agents as-is.
Only treat as success when API status is `200` (and response body indicates success).

### Step 5: Confirm

If API status is `200`, reply with **only a short confirmation**:

- EN: `✅ Directive sent` (with meeting) / `✅ Directive sent (no meeting)` (without meeting)

If API status is non-`200`, do NOT send success text.

If status is `400` with `error` `directive_project_required`, ask the owner which project it is for (Step 2) and send it again. For any other failure, return only a short failure notice (status code + concise reason).

### What happens on the server

The ATLAS server detects the `$` prefix and automatically:

- Broadcasts a company-wide announcement
- If meeting: Planning team leader convenes a team leader meeting -> discussion -> agent assignment -> CLI execution
- If no meeting: Planning team leader directly delegates to the best agent -> CLI execution
- Tasks/reports are mapped to the project by `project_id`
- Existing project uses DB core goal; new project uses the directive text as core goal

Without `$`, the message is treated as a general announcement.

---

## Git Safety Rule

Agents must NOT create commits by default.

### Required workflow

**Work complete -> Test -> Approval -> Commit**

- Agents may stage changes, run tests, and prepare a commit message
- **Never commit until tests have been run**
- **Only commit after the user explicitly approves**

---

## API Reference

```bash
# Health check
curl http://127.0.0.1:8790/api/health

# List all tasks
curl http://127.0.0.1:8790/api/tasks

# List tasks by status
curl "http://127.0.0.1:8790/api/tasks?status=inbox"

# Send CEO directive ($ prefix included)
curl -X POST http://127.0.0.1:8790/api/inbox \
  -H 'content-type: application/json' \
  -H "x-inbox-secret: $INBOX_SECRET_VALUE" \
  -d '{"source":"telegram","text":"$<directive message>"}'

# View task detail
curl http://127.0.0.1:8790/api/tasks/<id>

# Update task fields
curl -X PATCH http://127.0.0.1:8790/api/tasks/<id> \
  -H 'content-type: application/json' \
  -d '{"project_path":"/workspace/my-project"}'

# View terminal log
curl "http://127.0.0.1:8790/api/tasks/<id>/terminal?lines=50"

# Run agent on a task
curl -X POST http://127.0.0.1:8790/api/tasks/<id>/run

# Stop a running agent
curl -X POST http://127.0.0.1:8790/api/tasks/<id>/stop

# Assign agent to a task
curl -X POST http://127.0.0.1:8790/api/tasks/<id>/assign \
  -H 'content-type: application/json' \
  -d '{"agent_id":"<agent-id>"}'

# List agents
curl http://127.0.0.1:8790/api/agents

# List departments
curl http://127.0.0.1:8790/api/departments

# Get settings
curl http://127.0.0.1:8790/api/settings

# CLI provider status
curl http://127.0.0.1:8790/api/cli-status
```

---

## Response Rules (STRICT)

When processing `$` directives, the response to the user must be **minimal and clean**:

1. **`$` directive**: After collecting required meeting/path inputs and sending to API, reply with only `✅ Directive sent`. Nothing else.
2. **Failure case**: If API status is non-`200`, do not send success text.
   - For all other failures, return only a short failure notice (status + reason).
3. **NEVER include** in responses:
   - OAuth connection details or token information
   - Server settings or configuration
   - Agent lists or provider status
   - Raw JSON responses from API calls
   - CLI detection results
   - Model configuration details

---
