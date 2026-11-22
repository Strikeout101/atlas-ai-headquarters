# Work restructure plan: goals, initiatives and tasks

Status: **approved by the owner 2026-11-22**, open items answered (section 13). Build follows section 12. Phases 0–4 built on branch `work-restructure` (not committed yet).
Live ATLAS is on "Stop everything" until this rebuild is done.

This replaces how work is planned, run, reviewed and shown in ATLAS. It comes from a code trace on 2026-11-21 (what is wrong today) and the owner's answers to 20 questions (what it should be).

---

## 1. Why we're rebuilding

What the code does today, checked by reading it:

1. **One piece of work lives in four systems that don't share state.** Goal and strategy → idea (opportunity), playbook and experiment → proposal, VP queue and autonomy work row → task, subtask and meeting. One autonomous task is three rows with three status machines. Ideas are tracked by project, not by goal.
2. **Context gets lost.** The strategy only reaches the VP planner. Step results never reach the next step. A task's saved result is the last 2,000 characters of its log. Child tasks' output never reaches the parent.
3. **Reviews can't work.** Reviewers never see the output and may not open files. Verdicts come from keywords ("risk" = hold). Every department reviews everything, up to 3 rounds, then a project gate, an owner decision and a code-push approval. A counting bug lets both rounds reach the owner.
4. **Everything is treated as software.** Every task uses the `development` workflow, gets `git init` and a worktree, and is told to run tests and produce diffs.
5. **Paths behave differently.** Autonomy tasks: team lead, no meeting. Chat tasks: meeting plus a staff member. Free-time ideas: approved, then never started. A failed playbook step silently ends the playbook. Planner-made ideas never get a playbook (why shop setup was skipped).
6. **Progress is fake.** Subtasks are marked done whenever a run ends without an error.
7. **"Project" means a folder.** A path is required; goals live elsewhere; tasks have no goal link.

---

## 2. Decisions (owner answers, 2026-11-22)

| #   | Decision                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Structure is **Business → Goal → Initiative → Task**. Folders are a detail of code tasks only.                                                                                                                                         |
| 2   | Work outside goals goes in a standing **Operations** area per business.                                                                                                                                                                |
| 3   | A goal runs **2–3 initiatives at a time**, set per goal.                                                                                                                                                                               |
| 4   | Every initiative follows a **playbook**. A failed step retries, then escalates. It never silently stops.                                                                                                                               |
| 5   | Agents stop for the owner at: **strategy approval, initiative approval before building, any spending, anything public** (listings, shop changes, emails, posts). Everything else runs on its own.                                      |
| 6   | The Decision Inbox shows only **real decisions: 2–3 short, plain options plus a recommendation.** No raw meeting notes.                                                                                                                |
| 7   | VPs approve **the plan once per initiative**, not every task.                                                                                                                                                                          |
| 8   | **One reviewer** matched to the type of work. They see the real output, can open files, and judge it against the task.                                                                                                                 |
| 9   | Team-lead meetings only for **`$` directives and big strategy calls.**                                                                                                                                                                 |
| 10  | Changes requested by the reviewer go **back to the agent automatically**; the owner sees it only after 2 failed tries.                                                                                                                 |
| 11  | Each **work type** has its own instructions and review checklist. Only code gets git.                                                                                                                                                  |
| 12  | Every task ends with a **structured hand-off** (summary, files, key numbers) that the next step reads.                                                                                                                                 |
| 13  | **Leads do real work.** They handle important tasks themselves and give smaller jobs to staff. With 3+ important tasks waiting, they delegate important ones too.                                                                      |
| 14  | Free-time ideas stay, **only for improvements outside goals**, approved ones actually start, and the **think loop gets settings** (how often, on/off, limits).                                                                         |
| 15  | Daily cap plus a **cap per initiative**, with **bigger caps for planning and research** so agents can plan thoroughly.                                                                                                                 |
| 16  | Archive current tasks and ideas and start the Etsy goal fresh; **keep the strategy.**                                                                                                                                                  |
| 17  | ATLAS leaves upstream for good. **Remove every trace of Claw-Empire**, including the old 2D office.                                                                                                                                    |
| 18  | Rebuild the work board for the new structure, plus **a new per-agent "behind the scenes" view.**                                                                                                                                       |
| 19  | Stop everything is on until the rebuild ships.                                                                                                                                                                                         |
| 20a | An agent with no model **must not break anything.** VPs manage agent models and fix model errors. The model director is **always on, part of the VPs**. The Model Director tab under Team goes; only needed settings move to Settings. |
| 20b | **The owner should not have to babysit agents.**                                                                                                                                                                                       |
| 20c | Agents talk to the owner **casually**, never in corporate speak (carried over from commit `ee2ce22`).                                                                                                                                  |

---

## 3. The new model

### 3.1 Things and how they connect

```
Business (tech, rental, ventures)
 ├─ Goal                      "Reach $2,000/month on Etsy"
 │   ├─ Strategy (versions)   research result the owner approves
 │   └─ Initiative            "Wedding budget workbook" (one idea / product)
 │        ├─ playbook + current step
 │        ├─ budget, task cap, stop rules, variants
 │        └─ Task  ──►  Hand-off (summary, files, numbers)
 │             └─ Helper task (another department, same initiative)
 └─ Operations                standing area for non-goal work
      └─ Task (one-off asks, upkeep, free-time improvements)
```

- **Goal**: what the owner wants, with a measured target. Keeps milestones. Owns its strategy and initiatives directly (by `goal_id`, not by project).
- **Strategy**: a versioned research result. The owner approves it. Its summary is given to **every task** under the goal, not only to the planner.
- **Initiative**: replaces opportunity + playbook stage + experiment. One row holds status, playbook, current step, budget, task cap, variants, launch date and stop reason. Status: `proposed → approved → in_progress → launched → measuring → stopped/done`.
- **Task**: one unit of work, one status machine. Belongs to a goal's initiative **or** to a business's Operations area. Carries `work_type`, `importance`, the assigned agent and the step it serves.
- **Hand-off**: the structured result every task saves when it finishes (see 3.4). Replaces "last 2,000 log characters".
- **Workspace** (was "project"): only for code. A code task points at a repo folder. Non-code tasks get a plain per-initiative files folder with no git.

**Gone**: `agent_task_proposals` as the vehicle for autonomy work, `autonomy_work`, the polymorphic purpose/playbook_step columns, the `projects.core_goal` text, the fake "Finalize plan" / "Consolidate deliverables" subtasks.

### 3.2 Work types

Each type has its own prompt, files rules and review checklist.

| Type       | Examples                                 | Files               | Reviewer (default)                    |
| ---------- | ---------------------------------------- | ------------------- | ------------------------------------- |
| research   | strategy, market and trend research      | notes folder        | Planning                              |
| product    | printables, templates, digital files     | initiative folder   | QA                                    |
| design     | mockups, logo, banner, images            | initiative folder   | Design lead (or QA if Design made it) |
| listing    | Etsy/itch.io listing copy, tags, pricing | listing package     | QA                                    |
| shop_admin | shop profile, policies, sections         | shop changes        | Planning                              |
| outreach   | emails, social posts                     | drafts              | Planning                              |
| code       | websites, ATLAS itself, scripts          | git repo + worktree | Development                           |
| ops        | homelab, accounts, checks                | none                | DevSecOps                             |

The reviewer is never the agent who did the work, and **is on the other model** whenever possible (see 6). The software rules (tests, diffs, git guardrails, MVP code review) apply **only** to `code`.

### 3.3 Playbooks

- An approved initiative always has a playbook. The planner can't create an initiative without one.
- Default Etsy playbook: **research → build → mockups → listing → (owner approves publish) → launch → measure**. Shop setup is its own playbook, run once per shop, before the first listing.
- Each step names its work type, department and cap. The step's task gets the strategy summary, the initiative brief and **the hand-offs of earlier steps**.
- A step that fails: retry once (same agent, with the failure reason), then try another agent, then escalate to the VPs, then to the owner as one clear decision. The initiative shows "blocked" in the meantime. It never silently ends.

### 3.4 Hand-off format

Every task finishes by calling `task.handoff` (agent tool). Saved as structured data:

- `summary`: what was done, in plain words (≤ 1,200 characters)
- `files`: paths plus one line each
- `numbers`: key facts (prices, counts, measured vs estimated)
- `open_issues`: anything left for the next step
- `next_step_notes`: what the next step must know

If an agent ends without one, ATLAS makes one from its final message and flags it for the reviewer.

---

## 4. Flows

### 4.1 Goal to launch

```
Owner sets goal
  → Research phase (parallel angles, both models, big cap; see 8) → synthesis writes the strategy + 6–10 scored ideas
  → Owner approves the strategy (Decision Inbox: approve / change / redo)
  → VPs rank the ideas; owner approves which initiatives to build (up to the goal's 2–3 slots)
  → VPs approve each initiative's plan once (budget, caps, playbook)
  → Playbook steps run on their own: each task → review → hand-off → next step
  → Anything public or paid stops for owner approval
  → Launch → metrics → stop rules → slot frees → next idea starts
  → Strategy refreshes when ideas run out or every 14 days
```

### 4.2 Owner requests

- **Chat to an agent or lead**: becomes an Operations task (or attaches to an initiative if the owner picks one). No meeting.
- **`$` directive**: Planning lead holds a short team-lead meeting, then work is created as tasks (and initiatives if it's goal-sized). Meeting summary in plain words.
- **Manual create** on the board: the owner picks goal/initiative or Operations, and a work type.

### 4.3 Free-time ideas

- Only for improvements in Operations (never goal work; goals are handled by the planner).
- VPs approve; approved ideas are **actually queued and started**.
- Settings: on/off, how often each agent thinks (default 24h, was 6h), how often ATLAS checks (default 30 min, was 10), max pending per agent and total, and a separate daily cap for idea-tasks.

---

## 5. Who does the work (leads and staff)

- **Roster (owner, 2026-11-22):** every department has two agents: a **lead on Codex** and a **senior on Claude**. This pairing stays; it gives each team two models to check each other. Hiring adds more when both are overloaded.
- Each task gets `importance`: **important** (strategy, product build, anything public, anything with money, code changes) or **routine** (drafts, checks, image variants, data pulls, helper work).
- **Leads do important tasks themselves**, up to 2 at a time. Routine tasks go to the senior (and other staff once hired).
- **3 or more important tasks waiting in a department** → the lead delegates important ones to the senior, keeping the most important for themselves.
- A department with too much waiting work raises a hiring request (existing org-requests flow, VP-approved).
- One code path starts every task (today there are two separate launch paths).

---

## 6. Reviews

- **One reviewer** per task, chosen by work type (table in 3.2). **Cross-model rule:** from the reviewing department, pick the member on a different model from the agent who did the work (Codex work → Claude reviewer, Claude work → Codex reviewer). Only if that agent is unavailable does a same-model reviewer step in, and the review notes say so. They get the task, the hand-off, and **file access** (read-only), and answer with a structured verdict: `approve` or `changes` with a specific list. No keyword guessing.
- `changes` → back to the same agent with the list. After 2 failed tries → VPs decide (accept, reassign, drop). Only if VPs can't → owner, as one decision with a recommendation.
- No project gate, no multi-round team-lead review, no merge-synthesis rounds.
- Code still needs the code-push approval before it reaches GitHub (that's the "public" stop), but leader review and code push are the only two layers.
- Helper tasks' hand-offs go to the parent task and its reviewer.
- Subtasks are only marked done when the agent marks them done.

---

## 7. VPs, models and not babysitting

- **VPs run the company day to day**: approve initiative plans, decide stuck reviews, fix model problems, and only escalate real decisions.
- **Model director becomes part of the VPs, always on.** On every start ATLAS checks the agent has a working model. If not (none set, provider down, out of usage, error), the VPs pick one from the allowed list, record why, and the task runs. The Model Director tab under Team is removed; allowed models and provider limits stay in Settings.
- **Self-healing**: timeouts resume with the work kept (no more deleting the worktree on failure), stuck tasks get picked up, failed steps retry (3.3). A daily VP note tells the owner what was fixed, in two or three plain lines.
- **Casual voice** everywhere the owner reads: Decision Inbox, chat, VP notes, meeting summaries. Customer-facing text follows the business brand voice.

---

## 8. Pace and caps

- **Daily start cap** stays (setting, default 6, owner can raise).
- **Per-initiative cap** on tasks per day and in total.
- **Bigger caps for research and planning**: research steps default to a larger task and time budget (longer timeout, more helper tasks, more web searches) so the strategy is thorough.
- **Wider research (owner, 2026-11-22: past research was too fast and too narrow).** A goal strategy is a research _phase_, not one task:
  1. The Planning lead splits it into parallel research tasks by angle: market and trends (Google, Pinterest, social), best sellers and competitors on the platform, pricing and fees, buyer problems (reviews, Reddit, forums), and production effort for us.
  2. Each angle has a floor: at least 10 distinct sources, measured facts kept apart from estimates, dated, with links.
  3. Codex and Claude both take angles, so the findings come from two models.
  4. A synthesis task merges the hand-offs into the strategy: 6–10 scored ideas with evidence, not 3–5.
  5. The synthesis is reviewed cross-model before it reaches the owner.
- Free-time ideas have their own small cap, so they never eat goal work.
- Caps are shown on the board so the owner can see why something is waiting.

---

## 9. Screens

- **Goals page**: each goal with progress, strategy, and its initiatives as cards (step, status, blocked reason, budget used).
- **Initiative page**: playbook steps as a timeline, each step's task, hand-off, files and review.
- **Work board** rebuilt: grouped by goal → initiative, plus Operations. Columns: Waiting, Working, In review, Needs you, Done. "Needs you" only holds owner decisions.
- **New "Behind the scenes" view, per agent**: one column or card per agent showing what they're doing right now, their queue, recent hand-offs, reviews they're doing, model in use and any problems the VPs fixed. Live updates.
- **Decision Inbox**: one item per real decision, 2–3 options, recommendation first.
- Removed: Model Director tab, 2D office, anything still saying Claw-Empire.

---

## 10. Removing Claw-Empire

About 79 tracked files mention it today (docs, scripts, e2e tests, Blender art, a few server modules).

- Remove the 2D office (`src/components/office-view/`, 25 files) and its route. The 3D ATLAS office stays (parked).
- Remove the upstream updater (`routes/core/update-auto/`).
- Rename every user-visible and code reference to ATLAS; delete upstream-only scripts and docs.
- Decide on the open items in section 13 (OpenClaw, `$`/`#` webhook, file and DB names).

---

## 11. Moving over

1. Back up the live database.
2. Archive (not delete) current tasks, proposals, autonomy work, meetings and opportunities into `archive_*` tables.
3. Keep: businesses, goals, milestones, the current Etsy strategy, agents, departments, ledger, listings, Etsy connection and shop data, memories, settings.
4. Create the Etsy goal's records in the new shape; the 5 strategy ideas become `proposed` initiatives for the owner to approve.
5. Turn autonomy back on only after the owner checks the new board.

---

## 12. Build phases

Each phase is tested before the next starts. Nothing reaches live ATLAS until the owner says so.

| Phase | What                                                                                                                                   | Done when                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0     | Backup, archive tables, branch                                                                                                         | Live DB backed up; archive verified                                    |
| 1     | New data model: goals own initiatives; one task table with goal/initiative/Operations, work type, importance; hand-offs                | Schema + tests; old data migrated in a copy                            |
| 2     | One task runner: single start path, work-type prompts, no git for non-code, hand-off tool, timeouts keep work, model check through VPs | A research and a product task run end to end in the test runtime       |
| 3     | Planner and playbooks: strategy → initiatives → steps with hand-offs, retries and escalation, caps                                     | Etsy goal runs from strategy to "awaiting publish" in the test runtime |
| 4     | Reviews: one reviewer, file access, structured verdict, auto-return, VP escalation; remove meetings except `$` and strategy            | Review loop tests; no old review code left                             |
| 5     | Leads and staff: importance, lead takes important work, delegation rule, hiring trigger                                                | Assignment tests                                                       |
| 6     | Owner surfaces: Decision Inbox rewrite, think-loop settings, casual voice check                                                        | Each decision kind renders with 2–3 options                            |
| 7     | Screens: Goals, Initiative, new Work board, Behind the scenes per agent; remove Model Director tab                                     | Browser tests at desktop and phone width                               |
| 8     | Remove Claw-Empire and the 2D office; update docs (codebase map, task flow, agent tools)                                               | No remaining references; all suites pass                               |
| 9     | Migration on a DB copy, owner walkthrough, then live update                                                                            | Owner signs off; autonomy resumed                                      |

---

## 12a. Phase 1 technical design (data model)

Checked against the live DB backup `backups/claw-empire.before-restructure-2026-11-22.sqlite` (1 goal, 5 opportunities, 1 strategy, 8 tasks, 29 proposals, 3 ledger rows with an opportunity id).

New module `server/modules/work-model.ts` owns the schema (`ensureWorkModelSchema`) and the one-time migration (`migrateToWorkModel`, guarded by a `settings` flag, run inside a transaction).

**Goals** (`business_goals`, rebuilt): `project_id` becomes nullable and unused; add `title`, `initiative_slots` (default 3, 1–10).

**Strategies** (`goal_strategies`): add `version`, `status` (`draft`/`proposed`/`approved`/`superseded`), `approved_at`. The existing row becomes version 1, `approved` (the owner already chose to keep it).

**Initiatives** (new table, replaces `opportunities`):
`id, business, goal_id NOT NULL, title, brief, demand/revenue/cost/difficulty/time_to_launch scores, budget, status (proposed|approved|in_progress|blocked|launched|measuring|stopped|done), playbook_key NOT NULL, current_step, step_attempts, blocked_reason, task_cap_total, task_cap_daily, time_limit_days, launched_at, window_started_at, stop_reason, strategy_id, source_task_id, approved_at, approved_by, created_at, updated_at`.

- Renames: `opportunity_variants` → `initiative_variants`, `opportunity_metrics` → `initiative_metrics`; column `opportunity_id` → `initiative_id` in those, `experiment_rules`, `deals`, `spend_requests`, `listing_packages`, `ledger_entries`, `media_assets`.
- The code follows: every "opportunity" in server and web (about 600 references in 46 files) becomes "initiative", including agent tools (`opportunity.propose` → `initiative.propose`) and API routes.

**Tasks** (new columns): `business`, `goal_id`, `initiative_id`, `work_type` (research|product|design|listing|shop_admin|outreach|code|ops), `importance` (important|routine), `playbook_step`, `attempt`. A task with `business` set and no `initiative_id` is Operations work. `source_task_id` stays the parent link. `task_type`/`workflow_pack_key` stop being read in phase 2.

**Hand-offs** (new table `task_handoffs`): `task_id PK, summary, files_json, numbers_json, open_issues, next_step_notes, generated (0/1), created_at`.

**Projects** stay as the table behind code workspaces for now (only code tasks need one). Renaming `projects` → `workspaces` is in phase 8 with the rest of the Claw-Empire cleanup, because upstream code uses `project_id` in hundreds of places.

**Archive**: copy `tasks, subtasks, task_logs, autonomy_work, agent_task_proposals, meeting_minutes, meeting_minute_entries, opportunities, project_review_decision_*, review_round_decision_states, review_revision_history` into `archive_20261122_<table>`, then clear the live copies (except the strategy and anything money-related). `autonomy_work` and the autonomy use of `agent_task_proposals` are deleted in phase 3.

**Done when**: schema and migration tests pass against a copy of the live backup; every existing suite passes after the rename; `pnpm openapi:check` is clean.

## 12b. Phase 3 technical design (planner and playbooks)

**One step runner** (`server/modules/work-engine.ts`) replaces `autonomy_work`, its snapshots and the autonomy use of `agent_task_proposals`. Steps are ordinary task rows (`origin='autonomy'`, with `goal_id`, `initiative_id`, `playbook_step`, `attempt`, `work_type`, `importance`). The owner's goal, strategy and initiative approvals replace a VP vote on every task. The tables are archived (phase 1) and dropped.

Each tick, for each live goal:

1. **Research phase** when the goal has no approved strategy, its strategy is over 14 days old, it has no ideas left, or the owner asked for a redo.
   - 5 angle tasks (`research:<angle>`), split between the research department's Codex and Claude members.
   - Each angle writes `research/<angle>.md` in the goal folder (10+ dated, linked sources) and a hand-off.
   - When no angle is open and at least 3 finished, one **synthesis** task (`strategy`) gets every angle's hand-off and the old strategy and ideas as input. It saves the strategy as `proposed` and 6–10 scored ideas.
2. **Owner approves the strategy** (`POST /api/autonomy/strategies/:id/decision`: approve, or redo with a note). Approving supersedes the old one.
3. **Shop setup** (Etsy, once per shop): an Operations task under the goal (`shop_setup`, `shop_admin`). Listing steps wait for it.
4. **Owner approves initiatives** (`POST /api/autonomy/initiatives/:id/approve`), up to the goal's slots (approved, in progress or blocked). The VPs' plan check sets the playbook, caps and budget once and records it.
5. **Playbook steps** run in order.
   - Each step task's brief holds the strategy summary, the initiative brief and **every earlier step's hand-off**.
   - A `owner_approval` step stops the initiative at that stage (Etsy: `awaiting_publish`). The listing approval and publish flow takes it from there (`launched`).

**Failures** (`tasks.step_failure`, set by the run handler):

- Attempt 2: the same agent, with the reason.
- Attempt 3: another agent, on the other model when possible.
- Then the initiative is `blocked` and escalated to the VPs (`escalation='vp'`). The planner's VP decides: retry with notes, skip the step, stop, or ask the owner (`escalation='owner'`, shown as a decision in phase 6).
- A research angle that fails three times is dropped, and synthesis uses the angles that finished.

**Caps:**

- Daily start cap: research-phase tasks don't count.
- Per initiative: `task_cap_daily` (rolling 24 hours) and the stop rules' task limit.
- Research tasks get double the idle timeout.

**VP planner**: re-scores ideas, handles escalations, and may add up to 2 tasks for launched initiatives (variants). It no longer queues strategy, shop setup or playbooks.

**Schedules** create Operations tasks directly. Failures count toward pausing the schedule.

## 12c. Phase 4 technical design (reviews)

**One reviewer** (`server/modules/task-review.ts`) replaces the team-lead review meeting, the project review gate, merge-synthesis rounds and the Decision Inbox review picks.

When a run succeeds, the task goes to `review` and `startReview` runs:

1. **Wait for helpers.** It waits (`review_state='waiting_helpers'`) while helper tasks are open. Helper tasks finish without their own review; their hand-offs go to the parent's reviewer.
2. **Pick the reviewer** by work type (table 3.2; Design work made by Design goes to QA).
   - Never the worker, and on the other model first: in the department, then the worker's team, then anyone.
   - Same-model only as a last resort, and the prompt and log say so.
   - If nobody else exists, the task is approved without a review, with a log line.
3. **Run the review** one-shot and **read-only** in the task's folder:
   - Codex runs in its read-only sandbox; Claude gets only Read/Grep/Glob/web tools.
   - The reviewer gets the brief, the hand-off, the helpers' hand-offs, open subtasks, the earlier rounds' lists, a per-type checklist and, for code, the git diff.
4. **Read the verdict:** JSON only, `approve` or `changes` with at least one item. No keyword guessing.
   - No usable verdict: one more reviewer is tried, then the VPs.
5. **`changes`** go straight back to the same agent: the list is added to the brief and the task restarts.
   - After 2 rounds of changes the VPs decide once: accept, reassign, drop, or pass to the owner.
   - A failure after the VPs' reassign goes to the owner.
6. **The owner decides** in the Decision Inbox (kind `review_owner`: one more go / accept / drop) or with `POST /api/tasks/:id/review-decision`. History is at `GET /api/tasks/:id/reviews`, stored in `task_reviews`.
7. **Approved** → `finishReview`: merges a code worktree (the code-push approval still guards GitHub), sets done, reports.

**Removed:**

- Review consensus meeting and its outcome logic.
- Project review gate, review-round Decision Inbox items and their state tables' code.
- Review revision memos, the review-round scheduler, auto-finalizing collaboration children.
- Subtask auto-complete on a clean exit, and the review "auto-heal".

Subtasks are now done only when the agent says so: its own todo events, or the new `subtask.done` tool. Delegated subtasks still close when their helper task finishes.

**Meetings:** the kickoff meeting runs only for `$` directives (`DelegationOptions.directive`). Chat, @mentions and handoffs go straight to work. The research synthesis (strategy) gets a cross-model review like any task before it reaches the owner.

## 13. Open items (answered 2026-11-22)

1. **`$` directives stay as an ATLAS feature** (chat and Telegram); the OpenClaw installer and `#` task webhook rules go.
2. **Rename on disk to `atlas`**: repo folder, `claw-empire.sqlite`, service paths. Phase 8, with a tested rename script and a backup first.
3. **Roster**: each department already has a Codex lead and a Claude senior (checked in the live DB). Keep it; hire when both are overloaded. Reviews use the pairing (section 6).
4. **Fresh Etsy research run** with the wider research phase (section 8); the 5 old ideas are input only.
