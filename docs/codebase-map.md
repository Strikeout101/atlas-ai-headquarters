# Codebase map

Where things live, so an agent can go straight to the right files instead of searching the whole repo. First version, written 2026-11-18. When you add, move or remove a module, update its line here in the same change. If a line is wrong, fix it.

Rules of thumb:

- **Server** code is in `server/` (Express + `node:sqlite`, run with `tsx`). **Web app** code is in `src/` (React + Vite). **Browser tests** are in `tests/e2e/`.
- Unit tests sit next to the file they test (`foo.ts` → `foo.test.ts`).
- Each module creates its own tables on first use (`ensure…Schema(db)` near the top of the file). There is no separate migrations folder, apart from the bootstrap schema.
- New HTTP routes go in `server/modules/routes/ops/<area>.ts`, are registered in `server/modules/routes/ops.ts`, and need `docs/api.md` plus `docs/openapi.json` (`pnpm openapi:sync`).
- New web API calls go in `src/api/<area>.ts`. New pages or panels go in `src/components/<area>/`.
- Pending work is in `CHECKLIST.md` (start with section E). Docs index: `docs/README.md`.

## Repo root

| Path                                         | What it is                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                                  | Rules for coding agents in this repo (workflow, git safety, `$`/`#` directives)                          |
| `CHECKLIST.md`                               | The single list of pending work, owner steps and decisions                                               |
| `README.md`                                  | What ATLAS is, how to run it, checks                                                                     |
| `start-atlas.bat` / `start-atlas-dev.bat`    | Start the service (port 8800) / the live-reload dev server (only while the service is stopped)           |
| `package.json`                               | Scripts: `test:api`, `test:web`, `test:e2e`, `lint`, `openapi:check`, `dev`, `dev:e2e`                   |
| `.env` (private), `.env.example`             | Settings and secrets / template                                                                          |
| `knowledge/` (private), `knowledge.example/` | Systems registry (`systems.md`: hosts, accounts, ports) / template                                       |
| `claw-empire.sqlite` (private)               | The live database. Never edit it by hand; back up first (`backups/`)                                     |
| `logs/`, `backups/`, `.tmp/` (private)       | Task and server logs; database backups; scratch and test runtimes                                        |
| `public/`                                    | Static assets: 3D models (`models/atlas`), sprites, portraits, office map art, `atlas.svg` icon          |
| `templates/AGENTS-empire.md`                 | AGENTS.md template installed for OpenClaw                                                                |
| `tools/`                                     | Vendored agent tools: `taste-skill` (UI design rules), `ppt_team_agent` (report decks), `playwright-mcp` |
| `art/`, `docs/art/`                          | Art sources and credits                                                                                  |

## server/

| Path                              | What it is                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `index.ts`, `server-main.ts`      | Entry point; wires the DB, routes, WebSocket and background jobs (backups, registry sync, autonomy ticks) |
| `config/runtime.ts`               | Ports, paths, env settings                                                                                |
| `db/runtime.ts`                   | Opens SQLite, busy timeouts, runtime constants                                                            |
| `security/`                       | Owner login sessions, CSRF, agent task tokens, network trust, audit log                                   |
| `ws/hub.ts`                       | WebSocket broadcast hub                                                                                   |
| `gateway/client.ts`, `messenger/` | Telegram, Discord and other messenger channels (send and receive)                                         |
| `oauth/`                          | OAuth helpers for provider sign-ins                                                                       |
| `types/lang.ts`                   | `Lang` type (English only)                                                                                |

### server/modules/ (feature modules)

**Business engine (section E)**

| File                            | What it does                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `autonomy-store.ts`             | Tables: goals, opportunities, schedules, autonomy work, ledger, config                           |
| `autonomy-planner.ts`           | VP planning beat: compares goals with results, scores opportunities, proposes work               |
| `autonomy-engine.ts`            | Runs due schedules and admitted work: daily cap, usage gate, failure auto-pause                  |
| `agent-proposals.ts`            | Think loop: idle agents suggest tasks                                                            |
| `finance-store.ts`              | Deals, ledger entries (verified money), spend requests                                           |
| `square-sync.ts`                | Read-only Square payment sync into the ledger                                                    |
| `listings.ts`                   | Etsy and itch.io listing packages and the listing-fee budget                                     |
| `spend-budgets.ts`              | Monthly spending budgets per category                                                            |
| `etsy.ts`                       | Etsy connection (OAuth PKCE), draft and publish listings, sync orders, fees and favorites        |
| `studio.ts`, `media-library.ts` | Image studio (free mockup renderer, optional image API with a monthly cap) and the media library |
| `experiments.ts`                | Opportunity budgets, variants, metrics and the owner's stop rules                                |
| `playbooks.ts`                  | Editable playbooks (default: Etsy digital products), step advance, `opportunity.propose`         |
| `profit.ts`                     | Monthly costs and profit per business and opportunity                                            |
| `businesses.ts`                 | The business registry (`tech`, `rental`, `ventures`)                                             |

**Approvals and safety**

| File                                                         | What it does                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `approval-policy.ts`                                         | `routeApproval()`: who approves what (owner, VPs, nobody)                   |
| `business-policies.ts`                                       | Per-business approval settings (levels, deal size, client tier, trust ramp) |
| `approval-facts.ts`, `approval-review-state.ts`              | Facts attached to approvals (client tier, amounts) and snapshot hashing     |
| `vp-review.ts`, `vp-execution.ts`                            | The two VPs' votes and carrying out approved items                          |
| `trust-ramp.ts`                                              | Track record and owner-to-VP trust suggestions                              |
| `record-changes.ts`                                          | Agent changes to business records that need approval                        |
| `code-pushes.ts`                                             | Pushing reviewed work to GitHub                                             |
| `org-requests.ts`                                            | Hiring and department change requests                                       |
| `control-state.ts`                                           | Emergency pause and stop                                                    |
| `ssh-access.ts`, `ssh-approvals.ts`, `ssh-command-policy.ts` | Homelab SSH: running commands, approvals, the read-only command list        |

**Agents, knowledge and models**

| File                       | What it does                                                               |
| -------------------------- | -------------------------------------------------------------------------- |
| `agent-knowledge.ts`       | Knowledge blocks for prompts (task and no-tools versions), `knowledge.get` |
| `agent-memory.ts`          | Facts and lessons agents save; search; owner review                        |
| `task-lessons.ts`          | Lesson check at task end (`LESSON:` lines) and coverage                    |
| `systems-registry-sync.ts` | Keeps the "Current setup" section of `knowledge/systems.md` current        |
| `agent-web.ts`             | `web.search` / `web.read` for agents (SSRF-safe)                           |
| `model-routing.ts`         | Which model or provider runs a task; upgrade requests                      |
| `agent-performance.ts`     | Worker results per model, used for routing                                 |
| `codex-cli-models.ts`      | Lists Codex models                                                         |
| `github-accounts.ts`       | Several GitHub accounts per business                                       |
| `local-api.ts`             | Server calling its own API with the internal token                         |

**Running ATLAS**

| File                                                                        | What it does                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `lifecycle.ts`, `lifecycle/`                                                | Server start, health payload, startup recovery, graceful shutdown         |
| `db-backups.ts`                                                             | Daily restore-tested backups, off-PC copy                                 |
| `service-status.ts`                                                         | Service panel data and update or restart requests                         |
| `bootstrap/`                                                                | Base schema, migrations and default seeds (agents, departments, settings) |
| `routes.ts`, `workflow.ts`, `deferred-runtime.ts`, `runtime-helper-keys.ts` | Wiring that connects routes and workflow modules at startup               |

### server/modules/routes/ (HTTP API)

| Path                                                                                 | What it is                                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `core/tasks/`                                                                        | Task CRUD, run, stop, pause, resume, subtasks, auto-assign                                          |
| `core/agents/`, `core/departments.ts`, `core/projects/`                              | Agents (spawn, process inspector), departments, projects (folder picker, paths)                     |
| `core/github-routes.ts`, `core/update-auto/`                                         | GitHub import; the upstream updater (locked)                                                        |
| `collab/`                                                                            | CEO chat, directives, delegation between departments, meetings coordination, report routing         |
| `ops/agent-tools.ts`                                                                 | **Agent tool gateway** (`/api/agent-tools`): everything agents can call (see `docs/agent-tools.md`) |
| `ops/approvals.ts`, `ops/approval-settings.ts`, `ops/vp-reviews.ts`                  | Approvals feed (Today), approval settings, VP decision log                                          |
| `ops/autonomy.ts`, `ops/agent-proposals.ts`, `ops/org-requests.ts`                   | Goals, opportunities, schedules; suggested tasks; hiring requests                                   |
| `ops/business*.ts`                                                                   | Business records (contacts, tickets, quotes, drafts), email, mailboxes, profiles, social accounts   |
| `ops/finance.ts`, `ops/square.ts`, `ops/listings.ts`                                 | Deals, ledger, spend; Square; listing packages                                                      |
| `ops/etsy.ts`, `ops/studio.ts`                                                       | Etsy connection and listing push/publish; image studio and media library                            |
| `ops/knowledge.ts`                                                                   | Knowledge pages and memories (owner)                                                                |
| `ops/system.ts`                                                                      | Service and backups (owner)                                                                         |
| `ops/control.ts`                                                                     | Emergency controls                                                                                  |
| `ops/homelab.ts`, `ops/ssh-approvals.ts`                                             | Homelab hosts and SSH approvals                                                                     |
| `ops/model-routing.ts`, `ops/models-routes.ts`, `ops/api-providers.ts`, `ops/oauth/` | Models, API providers, provider sign-ins                                                            |
| `ops/messages/`                                                                      | Chat, announcements, decision inbox, directives webhook (`/api/inbox`)                              |
| `ops/task-reports/`, `ops/terminal/`, `ops/worktrees-and-usage.ts`                   | Reports, terminal logs, worktrees and usage                                                         |
| `ops/skills/`, `ops/custom-skills.ts`                                                | Skills library                                                                                      |
| `ops/settings-stats.ts`, `ops/api-docs.ts`                                           | Settings and stats; Swagger page                                                                    |

### server/modules/workflow/ (how tasks run)

| Path                                                           | What it is                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `orchestration/execution-start-task.ts`                        | Starts a task run: worktree, prompt, provider                                 |
| `orchestration/run-complete-handler.ts`                        | After a run ends: results, lessons, review, retries                           |
| `orchestration/review-finalize-tools.ts`                       | Review, merge and finishing (keeps failed merges in Review)                   |
| `orchestration/planned-approval.ts`, `orchestration/meetings/` | Team lead meetings (planned and review consensus)                             |
| `orchestration/report-*.ts`, `planning-archive-tools.ts`       | Report and deck flows                                                         |
| `core/project-context-tools.ts`                                | Builds the task prompt (project context, knowledge block, policies)           |
| `core/meeting-prompt-tools.ts`, `core/reply-core-tools.ts`     | Meeting and 1:1 chat prompts; reply cleanup                                   |
| `core/one-shot-runner.ts`                                      | Single no-tools model calls (VPs, think loop, meetings)                       |
| `core/worktree/`                                               | Git worktrees per task: create, merge, clean up                               |
| `agents/cli-runtime.ts`                                        | Spawns CLI workers (Claude, Codex, Gemini, OpenCode, Kimi)                    |
| `agents/providers/`                                            | Provider adapters: HTTP and API workers, OAuth, usage readers, stream parsing |
| `agents/context-rollover-*.ts`                                 | Continuing long tasks in a fresh context                                      |
| `agents/subtask-*.ts`                                          | Splitting work into subtasks and routing them to departments                  |

## src/ (web app)

| Path                                                                         | What it is                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `main.tsx`, `App.tsx`, `app/`                                                | Entry, app shell, routes and navigation (`app/routes.ts`), layout, bootstrap data                  |
| `api/`                                                                       | One file per area for calling the server (`core.ts` has `request`/`post` and CSRF)                 |
| `i18n.ts`                                                                    | Text helper (`t({ en })`); English only                                                            |
| `types/`                                                                     | Shared web types                                                                                   |
| `components/today/`                                                          | Today page: approvals waiting, digest                                                              |
| `components/autonomy/`                                                       | Goals, opportunities, schedules                                                                    |
| `components/revenue/`, `components/listings/`                                | Revenue and ledger; listing packages                                                               |
| `components/work/`, `components/taskboard/`                                  | Work views and the task board (task drawer, create modal)                                          |
| `components/team/`                                                           | Team area: knowledge, VP decisions, model director                                                 |
| `components/settings/`                                                       | Settings tabs: general (service, backups), businesses, accounts, approvals, API providers, gateway |
| `components/control/`                                                        | Emergency controls                                                                                 |
| `components/chat/`, `components/chat-panel/`                                 | CEO chat and decision messages                                                                     |
| `components/agent-manager/`, `components/agent-detail/`                      | Agent and department editors                                                                       |
| `components/project-manager/`                                                | Projects                                                                                           |
| `components/skills-library/`, `components/skill-history/`                    | Skills                                                                                             |
| `components/atlas-office/`, `components/office-view/`                        | 3D office and the older 2D office (parked)                                                         |
| `components/dashboard/`, `components/terminal-panel/`, `components/command/` | Dashboard widgets, terminal view, Ctrl+K command palette                                           |
| `styles/`                                                                    | CSS                                                                                                |

## scripts/

| Path                                     | What it is                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas-service/`                         | The Windows service: `supervisor.mjs`, `atlas-service.ps1` (install, update, status), `restore-backup.ps1`, `run-hidden.vbs`, `db-tool.mjs` |
| `claw-agent-tool.mjs`                    | The command-line tool agents use to call the agent tool gateway                                                                             |
| `run-e2e.mjs`, `prepare-e2e-runtime.mjs` | Browser tests in an isolated runtime (ports 8810/8811, own DB)                                                                              |
| `openapi-contract.mjs`                   | `openapi:sync` / `openapi:check`                                                                                                            |
| `qa/`                                    | Real-provider checks (autonomy cycle, local worker) and office QA scripts                                                                   |
| `setup.mjs`, `openclaw-setup.*`          | First-time setup and OpenClaw AGENTS install                                                                                                |
| Others                                   | Upstream helpers (sprites, office map assets, architecture report, staff cleanup)                                                           |

## docs/

See `docs/README.md` for which documents are current and which are history. Most used: `agent-tools.md` (what agents can call), `api.md` + `openapi.json` (HTTP API), `operations.md` (service, backups, restore), `models-and-workers.md`, the `phase*.md` docs (approvals, autonomy, finance, listings) and this file.
