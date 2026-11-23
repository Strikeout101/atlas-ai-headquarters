# Work restructure: hand-off (for Codex or the next session)

Updated: 2026-11-22, during Phase 9. Read `docs/work-restructure-plan.md` and `CHECKLIST.md` section R first.

## Where things stand

- Branch `work-restructure`. Phases 1–4 are committed as `75ee14d` and pushed; GitHub `main` was fast-forwarded to it.
- **Live ATLAS is NOT updated.** It runs a built release of an older commit (service on port 8800). Do not run the service Update (`scripts/atlas-service/atlas-service.ps1 update` or Settings > General > Service > Update): it builds HEAD and migrates the real database. That is Phase 9, after a backup and the owner's walkthrough.
- "Stop everything" is on, by the owner's choice, until the rebuild is done.

## How to check your work

Run all of these before saying something is done:

```
npx tsc -b
npx vitest run --config server/vitest.config.ts
npx vitest run --config vitest.config.ts
npx eslint src server        # 0 errors; about 42 old warnings are expected
npm run -s openapi:sync && npm run -s openapi:check   # after route changes (paths are hand-added to docs/openapi.json)
PW_CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/run-e2e.mjs
npx prettier --write <changed files>
```

- **Browser tests** run in an isolated runtime (ports 8810/8811, its own DB and `ATLAS_WORK_DIR`).
  - `tests/e2e/business-settings.spec.ts` sometimes fails 1–2 tests on timing in a full run but passes alone (`node scripts/run-e2e.mjs tests/e2e/business-settings.spec.ts`). This is known and listed in the checklist.
- Standard automated suites mock agents and VPs. The explicit `scripts/qa/work-restructure-real-pass.ts --run` check makes real model calls in a disposable workspace.

## Owner rules that matter for the remaining work

- **Roster:** every department has a Codex lead and a Claude senior; hiring adds more when both are overloaded.
- **Leads** do important tasks themselves, at most 2 at a time. Routine work goes to the senior. With 3 or more important tasks waiting in a department, the lead hands important ones to the senior too, keeping the most important.
- **The owner stops only for:** strategy approval, initiative approval, any spending, anything public. "I should not have to babysit the agents."
- **Agents talk to the owner casually**, not in corporate language.
- **Commits:** commit only after tests pass and the owner approves. After an approved commit, push the branch and fast-forward `origin/main` (never force).

## Phase 5: leads and seniors

Status: built, tested, not committed (waiting for the owner's OK to commit).

Goal (plan section 5): importance-based assignment, the lead takes important work (max 2 at a time), routine work goes to the senior, the delegation rule, and the hiring trigger. Done when assignment tests pass.

### Phase 5 progress

- [x] Staffing rules module: `server/modules/staffing.ts`.
  - `chooseAssignee` (lead up to `LEAD_IMPORTANT_MAX`=2 important tasks, routine work to the least-loaded staff, important work delegated when `DELEGATE_AT`=3+ are waiting).
  - `work-engine.ts` `pickStepAgent` now calls it.
- [x] Engine rebalances waiting tasks: `rebalanceDepartment`, run from `runStaffing` in `runWorkEngineTick` before tasks start.
  - Only planned autonomy tasks that never started, attempt 1, no `review_state`, not research angles.
  - Each move writes a ledger line `reassigned`.
- [x] Hiring trigger: `maybeRequestHire`. `HIRE_AT`=4 waiting tasks with every member running something → the lead's `hire_agent` org request (VP-reviewed), on the model the team has fewer of. At most one open or one per day per department.
- [x] Owner/chat delegation (`routes/collab/task-delegation.ts`): an important ask stays with the lead while they have room, instead of always going to a subordinate.
- [x] Tests: `server/modules/staffing.test.ts` (7). Full server suite: 867 pass; all 59 browser tests pass; tsc clean; eslint 0 errors.
- [x] Docs: plan section 12d, `CHECKLIST.md` section R, `tasks/todo.md`, `docs/codebase-map.md`.
- Not done in phase 5 (small, optional): the `WORKLOAD_HINT_AT` line in `createWorkTask` (work-engine.ts) still tells the lead to ask for a hire by hand. The automatic trigger now covers that, so the line can be removed or reworded.

## Phase 6: owner surfaces

Status: built and tested, not committed. No live service or database changes.

- Decision Inbox aggregates strategies, idea approvals, owner-blocked initiatives, stuck reviews and existing approvals. It has 2–3 plain options with the recommendation first. Inferred free-form chat notes no longer become inbox cards. Strategy redo asks for a note. Server builder: `server/modules/routes/ops/messages/decision-inbox/work-items.ts`; client cards: `src/app/decision-inbox.ts`.
- Think-loop controls are under Autonomy > Operating limits: on/off, 24h per-agent interval, 30m check interval, pending caps (2 per agent, 12 total), and a separate daily idea-start cap (2). Old off setting migrates. Approved ideas start as Operations tasks through the common work engine.
- Owner-facing prompt and fallback text is more casual. `docs/work-restructure-plan.md` section 12e records the implementation.
- Checks: 870 server tests, 223 web tests plus a focused Decision Inbox rendering test, `tsc -b`, OpenAPI sync/check, ESLint 0 errors (42 old warnings). The full isolated browser run had 58/59 pass; the one failure was an old 404 assertion for a non-owner decision reply, now correctly rejected with 403. The corrected spec passes both tests alone. No model calls were made.

### Phase 6 review (Claude, 2026-11-22)

Reviewed Codex's Phase 6: sound, matches the plan, all checks pass. Three small fixes:

- Decision Inbox cards named the goal by its metric; they now use the goal's title (`work-items.ts`).
- Approval cards always recommended "keep pending"; now the VPs' verdict is the recommendation when they gave one (`src/app/decision-inbox.ts` `approvalOptions`). With no verdict, holding stays first, so spending and anything public never default to yes.
- Phase 5 rebalancing could move a free-time idea away from the agent who suggested it; `operations:idea` tasks now stay put (`staffing.ts`).

Known, not fixed: "Leave this idea for later" (`initiative_defer`) does nothing on the server, so the card comes back on the next load. Phase 7's Goals page is the better place to park ideas.

## Phase 7: screens (built and tested, Claude; not committed)

- [x] Server read models: `server/modules/work-views.ts` (tests in `work-views.test.ts`).
  - `workBoard`: goal → research + initiatives, then Operations; columns waiting / working / in_review / needs_you / done. Needs-you = `review_state='owner'` or the initiative is blocked with `escalation='owner'`. Done = last 7 days.
  - `initiativeDetail`: playbook steps timeline with task, hand-off and reviews.
  - `behindTheScenes`: per agent: current task, queue, recent hand-offs, running reviews, model, VP model fixes.
- [x] Routes: `server/modules/routes/ops/work-views.ts` → `GET /api/work/board`, `GET /api/work/initiatives/:id`, `GET /api/work/agents`. Not yet in `docs/openapi.json`; add them and run `openapi:sync`.
- [x] Web, Work page (`src/components/work/WorkView.tsx`): tabs "By goal" (new `WorkBoard.tsx`, default) and "All tasks" (the old `TaskBoard`, which keeps New task, filters and bulk hide). An initiative opens `InitiativePanel.tsx` over the board via `?initiative=<id>`; cards and steps open the task drawer. API client: `src/api/work.ts`.
- [x] Team: the Model Director tab is replaced by "Behind the scenes" (`src/components/work/BehindTheScenes.tsx`, view `behind_scenes`, `/team/behind-the-scenes`). Model Director moved to Settings > Models (`SettingsPanel.tsx`, tab `models`); the old `/team/models` address opens Settings.
- [x] No-model agents show "no model yet" in AgentCard and AgentDetail; nothing threw before, the label was just blank.
- [x] Autonomy: goals and initiatives no longer need a project (server `validate()` and the form); schedules still do.
- [x] Browser tests: `ui-shell.spec.ts` (Team tabs now check Behind the scenes; `/team/models` opens Settings; the no-sideways-scroll list includes `/team/behind-the-scenes`), `model-workers.spec.ts` (now `/settings?tab=models`), and the new `work-board.spec.ts` (board, initiative panel, All tasks tab, Behind the scenes at 1440px and 375px). These pass on their own; full-suite result is below.
- [x] Goals cards: progress, strategy and initiative cards inside AutonomyWorkspace, completed in Phase 9 (`GoalsOverview.tsx`). The Decision Inbox carries owner actions.
- [x] The 3 `/api/work/*` routes are in `docs/openapi.json` (sync and check pass).
- Checks: 874 server tests, 224 web tests, tsc clean, eslint 0 errors (src, server), OpenAPI check passes. Full browser run: 60/61; the one failure was a timing flake in `model-workers.spec.ts` after a reload, fixed with explicit waits (3/3 passes after).

## Phase 8: Claw-Empire cleanup (built, Claude; not committed)

- **2D office removed:** `src/components/office-view/` (25 files), `OfficeView.tsx`, `ReferenceOfficeView.tsx`, the 2D office QA scripts (`scripts/qa/office-*`), `scripts/generate-office-map-assets.mjs` and `public/office-map/`. The Office page is the 3D ATLAS office only. `pixi.js` was removed in Phase 9.
- **Upstream auto-updater removed** (helper): `routes/core/update-auto/`, `routes/update-auto-*`, the update banner, the "Auto Update" notice and toggle, update-status polling, `autoUpdate*` settings (their rows are deleted at startup in `seeds.ts`), and the openapi paths. ATLAS's service updater is unchanged.
- **Database name:** default `atlas.sqlite`; `claw-empire.sqlite` is still used while it's the only file (`server/config/runtime.ts` `resolveDbPath`). Nothing renames a live file. New backups are `atlas-<time>.sqlite`; old `claw-empire-*` backups still list and prune.
- **Old review tables:** no longer created; dropped after the archive (`dropRetiredWorkTables`). Readers removed.
- **Agent tool:** `scripts/atlas-agent-tool.mjs`, env `ATLAS_TASK_TOKEN` / `ATLAS_TOOL_URL` / `ATLAS_TOOLS_CLI` / `ATLAS_AGENT_PROCESS`. The model-upgrade marker is now `.atlas-model-upgrade.json`.
- **Upstream setup removed:** the OpenClaw installer, `setup.mjs`, `auto-apply-v1.0.5.mjs` (it ran before every dev/start), `templates/AGENTS-empire.md`. The `$`-directive "OpenClaw AGENTS outdated (428)" reply is now `400 directive_project_required`. AGENTS.md keeps `$` directives and drops the OpenClaw and `#` webhook rules. package.json name is `atlas`.
- **Names:**
  - Browser storage keys are `atlas.*` (`src/storage-keys.ts` moves old values once).
  - The language event is `atlas-language-change`.
  - User-Agent / Editor-Version headers say `atlas`.
  - The classroom image is `public/atlas-teacher.png`.
  - Test DBs are `atlas.e2e.sqlite` / `atlas.vitest.*`.
  - Docs (DESIGN, api, operations, codebase map, SECURITY, setup example) and Blender scripts (`ATLAS_PROJECT` or the `atlas` folder) are updated.
- **Rename script:** `scripts/atlas-service/rename-to-atlas.ps1`.
  - Dry run by default. With `-Apply` it stops the service, backs up the DB, renames `claw-empire.sqlite` → `atlas.sqlite` and the folder → `atlas`, then reinstalls the login task.
  - Dry-run output checked. **Not run. The owner runs it** (it moves the folder this session works in).
- **Kept on purpose:**
  - **Security audit chain seed `claw-empire-security-audit-v1`.** Renaming it breaks verification of existing logs.
  - **Worktree names inside project repos:** `.climpire/`, `.climpire-worktrees/`, branch prefix `climpire/`. Existing worktrees and the code that finds them rely on them; a rename needs a fallback for the old names.
  - **License credit:** `LICENSE` and one README line. The license requires keeping the notice.
  - **Dated history docs** (phase reports, 2026-11-12/14 reviews) and old CHECKLIST entries.
- **Found while testing and fixed:**
  - The updater removal also took out `/api/health` (`/health`, `/healthz`), which the service supervisor checks after an Update. They're back in `server/modules/routes/core/health.ts`, with a test.
  - The free-time think loop had no browser-test-runtime guard, so it could call a real model there. It now skips, like the other loops (`lifecycle.ts`).
- **Checks:** 858 server tests, 212 web tests, tsc clean, eslint 0 errors (39 warnings), openapi check passes. Three slow git test files got a 20s timeout (they timed out at 5s under full-suite load; each passes alone in about 2s). Browser suite: 60/61 passed. The one failure, `accounts.spec.ts` "deal-size limit and spending budgets", is the known Settings-page timing flake (the "Business settings" heading wasn't visible within 5s). Not re-run yet: re-run it alone, and if it flakes again give it explicit waits like `model-workers.spec.ts`.

## Phase 9: release (live since 2026-11-23)

- Phase 7's missing Goals cards now show each goal's title, progress, strategy, initiatives, status, current step, blocked reason and recorded USD spend in Autonomy. The legacy Etsy goal title is derived from its project core goal during migration. A task held after a model-routing check returns to `planned`, where the work engine can pick it up. These changes have focused tests.
- Removed unused `pixi.js` with `pnpm remove pixi.js`; package and lockfile no longer contain it. Retained the security audit fingerprint and `.climpire*` worktree/branch names for compatibility. Project → workspace table rename was deliberately deferred by the approved revised plan; the on-disk rename remains an owner task.
- A read-only snapshot of the live `claw-empire.sqlite` was taken with SQLite `VACUUM INTO` into `.tmp/phase9-copy/live-before-2026-11-22.sqlite`. `scripts/qa/work-restructure-migration-check.ts` migrated a separate copy twice. Integrity is OK; foreign-key errors are zero; 14 agents, one goal, two contacts, three mailboxes, three business profiles, one social account, three ledger entries and the existing Etsy and Square connection rows are preserved. Eight legacy tasks, five ideas and 29 proposals archived once. Five initiatives migrated and one fresh Etsy research run queued. The copied control state remains `stopped`.
- Walkthrough preview: `http://127.0.0.1:8820/` (Vite UI, API on 8821), backed only by `.tmp/phase9-copy/walkthrough-2026-11-22.sqlite`. The copied database has a test-runtime marker, disabled messenger receivers and scheduled backups, and Stop Everything is on. It uses the owner's existing local login. The Goals screen was checked at 1440px and 375px with no horizontal overflow. It is an isolated copy; changes made there do not affect live ATLAS.
- Suggested owner walkthrough: open `/autonomy` to inspect the Etsy goal, strategy, progress and five initiative cards; open `/work` to inspect goal groups, the initiative step/review drawer and Operations; open `/team/behind-the-scenes` for staffing and reviews; open Decisions and `/settings?tab=models` for owner actions and Model Director. Keep the preview in Stop Everything while reviewing.
- Real-model QA: `scripts/qa/work-restructure-real-pass.ts --run` uses a fresh synthetic DB/work folder and read-only CLI tools. Codex completed the first market angle with 14 public sources. Claude then exited at its five-hour account usage limit, so the five-angle synthesis and cross-model review remain unverified. Run it again when Claude is available; the current harness starts a new synthetic run.
- Verification: TypeScript build, 863 server tests, 213 web tests, ESLint (0 errors, 40 warnings), and OpenAPI check (222 operations) pass. The focused `accounts.spec.ts` passed 3/3. Full browser run with `PW_CHROMIUM_PATH` set to the installed Chromium passed 59/61. The two failures were an old Goals display assertion and a 5-second Settings loading wait. Both were corrected; their focused two-spec rerun passed 6/6. No full rerun after those focused fixes.
- **Went live 2026-11-23:** commit 46b7222 pushed (main fast-forwarded). Live DB backed up to `backups/claw-empire.before-restructure-update-20261123-002847.sqlite`. Service updated from ee2ce22; health OK. The migration on live is clean: integrity ok, 0 FK errors, data kept, old work archived, fresh research flag set. Stop everything is still on; the owner turns autonomy on and tests real models on live. Full browser suite before release: 61/61.
- Release gate (superseded by the owner's choice to test on live): finish the real-model pass and browser suite, then the owner walks through the preview. Only after owner sign-off and explicit commit approval: commit/push the release, take a new live backup, run service Update, check health and data, then turn autonomy back on with the owner.
