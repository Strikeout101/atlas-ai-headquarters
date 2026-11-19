# ATLAS master checklist

The one place for everything that is pending: features to build, accounts to connect, decisions to make and loose ends.
Anything pending goes here, not in chat, not only in `tasks/todo.md` and not in a phase doc.

**Goal:** agents run the businesses (Small Business Tech, Primrose Events, AI Ventures), the homelab and whatever comes next on their own.
Today the owner approves almost everything because the system is being tested. That is temporary.
In the end the owner approves only big deals, important clients, money and anything irreversible.

**Not in scope for now:** the 3D office and gameplay. The foundation is in place and it is parked until after this list (see section 15).

Last full review: 2026-11-17.

## How to use this file

- `[ ]` not started, `[~]` partly done or built but not connected, `[x]` done (move it to "Done" at the bottom with the date).
- **YOU** means only the owner can do it: an account, a password, a decision or a real-world check. Agents must not do these.
- **P1** blocks the autonomy goal or something already half built. **P2** is needed for real day-to-day running. **P3** is nice to have.
- Rules for agents (also in `AGENTS.md`):
  - When you find, create or leave anything pending, add it here in the right section in the same change.
  - When you finish an item, tick it and add a one-line note with the date and where it lives (file, page or doc).
  - Do not delete items you did not finish. If an item is no longer wanted, mark it `[x] dropped:` with the reason.
  - Do not put passwords, tokens, API keys or customer private data in this file.

---

## 0. What works today (short version)

- **Tasks and agents:** CLI agents (Codex, Claude, Gemini, OpenCode, Kimi) run tasks in git worktrees. There are departments, meetings, reports, a task board and the Today page.
- **Approvals:** two VPs review proposals, model upgrades, org changes and Ventures email or listings. Everything for Tech and Rental customers goes to the owner. Emergency pause and stop are available.
- **Autonomy engine:** goals, scored opportunities, research schedules, a daily start cap and a usage-headroom gate. Nothing is configured yet and every routine is off.
- **Businesses:** contacts, tickets (Tech), quotes (Rental), drafts, a deals pipeline, a ledger and spend requests. These are records only.
- **Email:** three business mailboxes are connected and tested. Sending works after owner approval, one recipient, plain text. Nothing reads the inbox.
- **Instagram:** the Primrose account row exists, read-only, but no access token is stored, so nothing is connected yet.
- **Square:** read-only sync is on. Tech and Ventures locations are mapped; Primrose (Rental) is not mapped yet.
- **Listings:** agents prepare Etsy and itch.io packages. The owner publishes them by hand.
- **Homelab:** real SSH to one host. Read-only commands run automatically; everything else needs approval.
- **Models:** Codex and Claude subscriptions; one local model host (`Precision`, address in `knowledge/systems.md`) is configured but no agent uses it. No model director agent is set. A usage cache tracks headroom.
- **Phone access:** password login over the home VPN. Phones get the Today dashboard (no 3D office).
- **Agent knowledge:** every task prompt carries the project goal, the business profile, a systems summary and relevant memories. Agents use `knowledge.get`, `memory.search` and `memory.add`. Review memories under Team > Knowledge.

---

## 1. Loose ends right now

- [x] **P1** (2026-11-17, committed together with agent knowledge and memory) Commit the phone layout and VPN launcher work Codex finished on 2026-11-16 (bottom tabs, menu drawer, Office hidden on phones, `start-atlas.bat` now runs `pnpm dev`). It is verified but uncommitted.
- [x] **P1** (2026-11-18, Codex, `autonomy-engine.ts` `autonomyTaskUsageBlockReason`: each run checks only the provider it is routed to; planning checks the selected VP. Claude-routed work still needs a valid Claude usage reading.) Claude subscription usage reads as "unauthenticated". Because of that, the autonomy engine blocks every autonomous start ("claude subscription usage is unavailable"). Fix the usage reader or make the gate use whichever providers are actually in use.
- [ ] **P2 YOU** Instagram: connect a token in Settings > Businesses and run Test. The account row exists but no token is stored.
- [] **P2 YOU** Square: map the Primrose (Rental) location too. Only Tech and Ventures are mapped. #Note from Strike: Prirose uses another square account so I need ot be able to enter a second API for square
- [X] **P2 YOU** Review the filled business profiles in Settings > Businesses (prices, hours, voice, rules were copied from `SETUP-INFO-NEEDED.txt` on 2026-11-17). 11/17
- [ ] **P2** Register real projects (website repos) with their business set, so tasks get the right project goal and profile. There are no projects yet.
- [ ] **P2** `tasks/todo.md` still says phases 5 and 6 are uncommitted, but both are committed (ed837fc and e18c0b0). Correct the notes.
- [ ] **P2** Open items still sitting in `tasks/todo.md`: Ctrl+K commands for the emergency controls, Etsy API publishing, itch.io uploads, owner create/edit of listing packages. The Ventures mailbox test that the file still lists as pending has since passed. Keep these items here from now on.

## 2. Agent knowledge and memory (the "no scavenger hunt" foundation)

Built 2026-11-17: agents now get a knowledge block (project goal, business profile, systems summary, relevant memories) in every task prompt, plus `knowledge.get`, `memory.search` and `memory.add` tools. Details: `docs/agent-tools.md`, `docs/README.md`.

- [x] **P1** (2026-11-17, `knowledge/systems.md`, kept out of git by owner decision; template in `knowledge.example/`) Write a **systems registry** at `docs/systems.md`: every system, where it lives, how it is reached and which tool or page controls it. Cover the app, ports, DB, backups, logs, mailboxes, social accounts, Square, GitHub accounts and repos, Vercel projects, domains, homelab hosts and model hosts. Use names and locations only, never secrets.
- [x] **P1** (2026-11-17, `server/modules/agent-knowledge.ts`, injected via `buildTaskExecutionPrompt`) Inject a short version of the registry plus the relevant business profile into every agent prompt, and add an agent tool to read the full registry (`knowledge.get`).
- [x] **P1** (2026-11-17, `server/modules/agent-memory.ts`, review in Team > Knowledge) Add **persistent agent memory**: a table of facts and lessons that agents can write after a task and that is searched before a task. It should support scoping (global, per business, per project), sources and an owner review, so a bad lesson can be removed.
- [x] **P1** (2026-11-17, part of the knowledge block; projects now have a Business field) Inject the project core goal into every task prompt directly. Today it appears only when the delegation step adds it.
- [x] **P2** (2026-11-17, `docs/agent-tools.md`, `docs/api.md`, openapi with its own task-token scheme) Document the agent tool gateway (`/api/agent-tools`) in `docs/api.md` and the OpenAPI file. Today it is described only by one long line inside the prompt.
- [x] **P2** (2026-11-17) Add `docs/README.md` as an index, and mark which docs are current reference and which are dated history (phase docs, `operations-setup-2026-11-12`, `agent-access-review-2026-11-14`).
- [x] **P2** (2026-11-17, filled from `SETUP-INFO-NEEDED.txt`; Ventures named Eduardo Capital; owner review pending in section 1) Fill business profiles (services, prices or pricing rules, hours, service area, brand voice, do and don't) so agents stop guessing. Needs answers from section 14.
- [x] **P3** (2026-11-17, Team > Knowledge > Systems / Checklist) Show this checklist and the systems registry inside ATLAS (read-only page or a Settings tab), so they can be read from the phone.
- [x] **P2** (2026-11-18, `buildReferenceBlock` in `server/modules/agent-knowledge.ts`: project goal, business, matching memories and systems summary, no tools line) Not yet covered by the knowledge block: chat replies, meetings and the think loop (one-shot prompts). Only the planner and VP review got business profiles.
- [x] **P2** (2026-11-18, `server/modules/task-lessons.ts`: each finished task is checked; `LESSON:`/`FACT:` lines in the final output are saved as unreviewed memories when the agent did not call `memory.add`; results in Team > Knowledge) Ask agents for lessons automatically at task end (today they are told to call `memory.add`; nothing checks that they do).
- [x] **P3** (2026-11-18, `server/modules/systems-registry-sync.ts`: ATLAS rewrites a marked "Current setup" section at the end of the file every 10 minutes from its own records (projects, GitHub, Square, mailboxes, social, SSH and model hosts, sign-ins), names and locations only; the owner's text is untouched; off in the browser-test runtime) Keep `knowledge/systems.md` current: update it when hosts, accounts or projects change (agents can read it but not write it).

## 3. Accounts, identities and credentials

- [x] **P1** **Multiple GitHub accounts.** Today GitHub uses a single "top priority" account, and it isn't connected yet (no GitHub account is saved). Support several accounts, each with a label and an owning business (Primrose vs personal), and pick the account by repo or project. Agents should push with the matching account, not the PC's global git login. Answer From strike: 11/18 Claude Finished this
- [x] **P1 YOU** Connect both GitHub accounts once the step above exists (fine-grained tokens or a GitHub App per account, limited to the repos each needs). Answer From strike: 11/18 done
- [ ] **P1** **Worker isolation.** Agents run with permission checks turned off (`--dangerously-skip-permissions`, `--yolo`, `--auto`) as the same Windows user as ATLAS, so they can read `.env` and the database directly. Before agents get more powerful accounts, run them under a separate user or container that has no access to ATLAS secrets.
- [ ] **P2** Scope agent business access by business and department. Today any agent can create, edit or delete records for all three businesses.
- [ ] **P2** One credential area in Settings listing every connected account, its business, its last successful test and its expiry date, plus a warning before tokens expire.
- [ ] **P2** Instagram tokens have no automatic refresh. Add a refresh job before the 60-day expiry.

## 4. Websites and code (GitHub + Vercel)

Nothing exists for this yet.

- [X] **P1 YOU** List each website with its repo, GitHub account, Vercel project, domain and registrar (for the systems registry).
Primrose:
URL - https://primrosevents.com/
Github - https://github.com/primroseevents/primrose-website
Vercel - https://vercel.com/primroseevents-s-projects1/primrose-website
Registrar - Cloudflare
Small Business Tech 
URL - https://smallbusinessestech.com/
Github - https://github.com/Strikeout101/small-business-tech-security
Vercel - https://vercel.com/eddiealba2003-9416s-projects/small-business-tech-security-u9aq
Registrar - Cloudflare
- [ ] **P1** Register website repos as ATLAS projects with absolute paths and the correct GitHub account.
- [ ] **P1** Add a Vercel integration (token per Vercel account or team): list projects, deployments, build logs, environment variable names (not values) and domains.
- [ ] **P1** Website change flow: agent branch, then pull request, then Vercel preview URL, then automatic checks (build, links, a screenshot on phone and desktop), then merge. Small content edits merge automatically once trusted (section 10). Layout or pricing changes go to the owner.
- [ ] **P2** Watch production: uptime checks, failed deployment alerts, SSL and domain expiry.
- [ ] **P2** DNS: read records at the registrar or Cloudflare. Changes always need approval.
- [ ] **P3** Site analytics (Vercel Analytics or similar) feeding goals: visits, contact form leads.
- [ ] **P3** Contact forms on the websites create a contact and a ticket or quote in ATLAS automatically.

## 5. Social media

Today Instagram can be read, and drafts exist as records only. No platform can be posted to.

- [ ] **P1** Instagram publishing through the Graph API (needs a Facebook Page and a Meta app). Include photo, carousel, caption and a scheduled time, all under the approval policy.
- [ ] **P1** Content calendar: planned posts per business with status, date, platform and the assets used.
- [ ] **P2** Facebook Page posting (same Meta app).
- [ ] **P2** Google Business Profile: posts, reviews and replies to reviews. This matters a lot for local service businesses.
- [ ] **P2** Comment and DM inbox: read new comments and messages, draft replies, send under policy.
- [ ] **P2** OAuth login flow for social accounts, so tokens are not pasted by hand.
- [ ] **P3** TikTok (deferred), then others as needed.
- [ ] **P3** Post performance (reach, likes, follows) feeding goals and the next content plan.
- [ ] **P2** Media library: brand assets, logos, photos of rentals and work, with tags agents can search.

## 6. Selling pages and storefronts

- [X] **P1 YOU** Decide which storefronts are in use: Etsy, itch.io, Square Online, Shopify, Gumroad or the businesses' own sites. Answer From strike: All the ones mentioned exept Gumroad
- [ ] **P1** Etsy API publishing (needs an Etsy-approved developer app). Include listing create and update, inventory, prices within limits, and reading orders.
- [ ] **P2** itch.io uploads with the butler tool.
- [ ] **P2** Orders flow: new order, record it, fulfil it (digital delivery or a task), send the customer a message, and mark the deal paid only from verified payment evidence.
- [ ] **P2** Raise the listing fee budget from $0 if you want VPs to approve normal Etsy listings. Today every $0.20 listing goes to the owner.
- [ ] **P3** Square catalog and invoices (read first, then create invoices under the approval policy).

## 7. Communication

- [ ] **P1** Inbox sync (IMAP) for the three mailboxes. New mail becomes a thread linked to a contact. Agents classify it and draft replies.
- [ ] **P1** Owner notifications on the phone: Telegram bot (the code exists, but no token is set) and/or web push. These are for approvals waiting, failures, money and big leads.
- [ ] **P2** Email: support STARTTLS on port 587, CC, attachments (quotes as PDF), HTML with a signature, and threads (reply in the same conversation).
- [ ] **P2** SMS provider (Twilio or similar) for reminders and replies. Draft records already exist.
- [ ] **P2** Install ATLAS on the phone home screen (PWA manifest and icon).
- [ ] **P3** Phone calls and voicemail transcription to a ticket or quote.
- [ ] **P3** A daily and weekly owner digest by email or Telegram: what happened, money in, what is waiting.

## 8. Business operations

### Small Business Tech

- [ ] **P2** Device history per client (devices, serials, past work).
- [ ] **P2** Estimates and invoices (create from a ticket, send under policy). Payment collection stays separate (section 10).
- [ ] **P2** Appointments with a real calendar (Google Calendar or similar), with booking links and reminders.
- [ ] **P2** Client conversation history in one timeline: email, SMS, calls, tickets.

### Primrose Events (rentals)

- [X] **P1 YOU** Provide the rental inventory, pricing rules, delivery and service area rules, and an example quote format. Answer From strike: Has been answered in SETUP-INFO-NEEDED
- [ ] **P2** Inventory and availability by date, so a quote cannot double-book an item.
- [ ] **P2** Pre-event and post-event message schedule: confirmation, delivery reminder, check-out, check-in, review request.
- [ ] **P2** Quote documents (PDF) and acceptance tracking. Today "shared" sends nothing.
- [ ] **P3** Contracts and waivers to sign.

### AI Ventures

- [ ] **P2** A pipeline from idea to product to listing to sale, with results tracked per product.
- [ ] **P3** Asset generation and quality checks before a listing is prepared.

### Shared

- [ ] **P2** A real calendar module across all businesses (today Events only groups quotes by date).
- [ ] **P2** Lead sources for the research schedules (which sites, directories or maps are allowed). The engine never invents leads.
- [ ] **P3** Import existing customers and jobs (from Square, sheets or wherever they live now).

## 9. Homelab

- [X] **P1 YOU** List all hosts (name, address, purpose, OS) and how ATLAS reaches each. Only "Media" is connected now. Answer From strike: Has been answered in SETUP-INFO-NEEDED
- [ ] **P2** Switch from password to SSH key auth, using a dedicated agent login per host with only the sudo it needs.
- [ ] **P2** Turn on `restrict_agents` and grant hosts to the homelab department only.
- [ ] **P2** Proxmox API (read: nodes, VMs, containers, storage, backups). Changes under policy.
- [ ] **P2** Monitoring and alerts: disk, backups, container health, updates waiting.
- [ ] **P3** Routine maintenance schedules (updates, backup checks) that run on their own within the approved command list.
- [ ] **P3** A change log per host that agents write after every change.

## 10. Autonomy and approvals (moving from testing to real running)

Approval rules are settings per business (Settings > Businesses > Approvals and Spending budgets), routed by structured facts. Hard floors stay in code: paid accounts, accepting terms, destructive SSH, spending outside a budget.

- [x] **P1** (2026-11-17/18, Settings > Businesses > Approvals) **Approval policy settings page:** per business and per action, choose owner, VPs, or automatic. Keep hard floors for money movement, new paid accounts, accepting terms and destructive SSH.
- [x] **P1** (2026-11-18, contact form "Client importance"; agents' tier changes always go to the owner; `tier_to_owner` setting) **Client importance:** add a tier on contacts (normal, important, VIP). Important and VIP clients always go to the owner; normal clients follow the policy.
- [x] **P1** (2026-11-18, $1,000 default per business, editable; uses the client's largest open deal or quote; quotes gained a total; other currencies go to the owner) **Deal size thresholds:** deals and quotes above an amount go to the owner; below it, VPs or automatic. Answer From strike: 1K for now
- [x] **P1** (2026-11-18, vp-review.ts uses `describeApprovalRules`) Remove the hard-coded line in the VP review prompt that forces every Tech and Rental customer item to escalate. Read the policy instead.
- [x] **P1** (2026-11-18, `factsFromContent` removed; approval-facts.ts; VPs still escalate messages that commit to money or terms) Fix the free-text keyword check: any message containing words like "pay" or "buy" goes to the owner, which catches normal customer emails. Use structured facts instead.
- [x] **P2** (2026-11-18, trust-ramp.ts; suggestion card in Approvals, owner accepts or snoozes; owner to VPs only, "corrections" counted as denials) **Trust ramp:** after N approved items of a kind with no corrections, offer to move that kind down a level. Record the track record per agent and per action.
- [x] **P2** (2026-11-18, Settings > Businesses > Spending budgets; all $0; listing fees keep their own budget on Listings) Spending tiers: a monthly budget per business and category with a per-item limit. Today every spend request goes to the owner with no threshold, and an approval only records permission; no money moves.
- [ ] **P2** Send paths for social posts and SMS under the same policy (today they cannot be sent at all). Routing is ready (`social_send`, `customer_send` follow `customer_sends`); the send itself lands with Instagram publishing (section 5) and an SMS provider (section 7).
- [ ] **P3** Trust ramp from VPs to no approval (`vp` to `none`) for record changes and code pushes, once there is a track record of VP decisions.
- [~] **P2** Owner override and undo: an audit list of everything done automatically, with a way to flag a mistake that turns into a lesson (section 2). Answer From strike: I do not want to do this until we have most of the autonomy features/logic/etc. configured
- [ ] **P2 YOU** Set up the autonomy engine for real: pick projects, write goals, turn on chosen routines. Answer From strike: I do not want to do this until all/most the autonomy setting/features/logic are in place
- [ ] **P3** Profit goals (needs costs plus verified revenue).
- [ ] **P3** Money movement (refunds, payouts, deposits) stays manual until you decide otherwise.

## 11. Models and workers

Section 11 work by Codex on 2026-11-18, reviewed and committed by Claude the same day. Details: docs/models-and-workers.md and docs/models-workers-verification-2026-11-18.md.

- [x] **P1** (2026-11-18, `scripts/qa/autonomy-real-cycle.ts`, `docs/models-workers-verification-2026-11-18.md`) Real isolated goal → planner → independent Codex/Claude VP approval → Claude worker → result → engine goal progress passed. Final task consensus uses an exact-result oracle; production routines remain disabled.
- [ ] **P2** Investigate an intermittent Codex worker shutdown timeout: one real diagnostic emitted the correct result and `turn.completed` but did not close within 60 seconds. The verified cycle used Claude as worker and both providers as VPs. Evidence and reproduction: `docs/models-workers-verification-2026-11-18.md`.
- [x] **P2** (2026-11-18, `server/modules/workflow/orchestration/review-finalize-tools.ts`; regression tests in the adjacent test file) Failed merges now keep tasks in Review, preserve worktrees/callbacks, and report the actual failure for retry; completion side effects run only after success.
- [ ] **P2** Use the Ollama host. It is configured but no agent uses it. Route cheap and routine work to it. Progress 2026-11-18: task-kind routing to the local host is built (Team > Model Director, off until enabled) and plain chat with `5690-flint` works, but a real local tool worker (OpenCode) timed out three times with no output. On 2026-11-18 the host was up and `5690-flint` returned a correct tool call directly (HTTP 200, about 13 s), so the model and server are fine. Next: OpenCode's provider config or prompt for this model.
- [ ] **P2** Autonomy has no usage or spend cap for providers without a subscription meter (local models, `api`). Free today (only the local host is configured), but add a budget gate before a paid API key is ever connected.
- [x] **P2** (2026-11-18, `server/modules/agent-web.ts`, `docs/agent-tools.md`) Shared `web.search` / `web.read` gateway tools; live public search/read and 45 regressions passed. Public text browsing only; interactive/authenticated pages and PDFs are not supported.
- [x] **P2** (2026-11-18, `server/modules/agent-performance.ts`, Team > Model Director) New worker runs persist exit outcomes, repeat attempts, structured tokens and reported cost per agent/provider/model; summaries feed director prompts. Unknown cost stays unknown; HTTP account overrides and fallback attempts retain actual model attribution.
- [x] **P3** (2026-11-18, `server/modules/model-routing.ts`, Team > Model Director) Separate technical/design selectors and task-kind routing with the existing director as fallback.
- [ ] **P2 YOU** Select live technical/design directors and enable the desired Precision task kinds in Team > Model Director after reviewing verification. Owner explicitly chose to leave these assignments and live routing unchanged (2026-11-18).
- [x] **P3** (2026-11-18, `server/modules/workflow/agents/context-rollover-prompt.ts`) Trimmed local prompt instructions and reserved 15% prompt headroom; initial local tasks retain mandatory instructions or fall back before launch. Basic 4096-token rollover measured 1634 UTF-8 bytes, below the 2262-byte prompt budget.

## 12. Reliability and operations

See docs/operations.md for running, updating, backing up and restoring ATLAS.

- [x] **P1** (2026-11-18, `scripts/atlas-service/`: login task, stable build of the latest commit on port 8800, crash and hang restarts, Update with rollback; Settings > General > Service) Run ATLAS as a Windows service or scheduled task that starts at boot and restarts after a crash. Today it stops when the console window closes.
- [x] **P1** (2026-11-18, Settings > General > Backups: daily, 30 days, newest three always kept, restore test on every copy, optional copy to any folder; `restore-backup.ps1`) Automatic database backups (daily, keep 30 days, plus a copy off the PC such as the homelab or cloud). Include a restore test. Today backups are manual snapshots only.
- [x] **P1** (2026-11-18, `update-auto/upstream-lock.ts`: never checks or applies upstream unless `ATLAS_ALLOW_UPSTREAM_UPDATE=1`; toggle removed from Settings) Turn off or redirect the auto-updater. It points at the upstream claw-empire releases, which would overwrite this fork. It is off now; make sure it stays off.
- [ ] **P2** HTTPS for phone access (Tailscale Serve or a local certificate). Today it is plain HTTP over the VPN.
- [ ] **P2** Health alerts: if the server, a mailbox, a sync or a VP stops working, notify the owner (section 7).
- [x] **P2** (2026-11-18, service writes `logs/server/atlas-YYYY-MM-DD.log`, kept 14 days; task logs in `logs/` are not pruned) Save server logs to files and rotate the logs folder.
- [ ] **P2** Check that CI runs and passes on the fork (`.github/workflows/ci.yml` is inherited from upstream). The GitHub CLI is not installed here, so this needs a look at the Actions tab on GitHub.
- [x] **P1** (2026-11-18, done by Claude on the owner's OK: dev server stopped with no tasks running, login task `ATLAS` installed, service running the latest commit on port 8800 on all addresses) Switch to the ATLAS service.
- [ ] **P2 YOU** Open ATLAS on the phone (home VPN, this PC's address, port 8800) once to confirm it still loads under the service.
- [ ] **P1 YOU** Update the service to the latest commit: Settings > General > Service > **Update to latest commit** (or run `.scriptsatlas-serviceatlas-service.ps1 update` in your own PowerShell). It still runs f0baf01, from before the English-only change. Claude's shell is sandboxed, so its update requests never reach the real service folder. (The 939b919 commit message blames a console window for this; the real cause was the sandbox. Running hidden is still the better setup.)
- [ ] **P2 YOU** Pick a folder off this PC for backup copies (NAS share, external drive or OneDrive) in Settings > General > Backups.
- [ ] **P3** Move the live database out of the repo folder into a data folder.

## 13. Repo and docs cleanup

- [x] **P2** (2026-11-18, owner request: English only) Remove Korean, Japanese and Chinese from the project: UI text, the language picker, agent prompts and replies, chat keyword matching, seeds, tests, AGENTS.md and upstream sample media. Agents always reply in English; translated name columns are cleared on startup (the columns stay so old databases still load).
- [x] **P2** (2026-11-18, `README.md`: what ATLAS is, running it, checks, license; the jp/ko/zh copies were removed) Rewrite `README.md` for ATLAS (it is still entirely the upstream claw-empire README, plus the jp, ko and zh copies).
- [x] **P2** (2026-11-18: removed; still in git history and the `upstream` remote; `docs/README.md` updated) Remove or archive upstream leftovers: `docs/releases`, `docs/plans`, `docs/decision-inbox-checkpoint-2026-02-22.md`, Linux `deploy/`, Docker files if unused, `install.sh` and `install.ps1`, and the old launcher `scripts/run-claw-empire-dev-local.cmd`.
- [x] **P3** (2026-11-18, decided: keep in git. The ATLAS office loads these files at runtime; they take 34 MB of a 38 MB pack and the largest is 7 MB. LFS would need a history rewrite to save anything. Revisit if one file nears 50 MB or the pack passes 1 GB.) `public/models` (53 MB of GLB files) is committed to git. Decide whether to move it to Git LFS or out of the repo (ties into the 3D work later).
- [x] **P3** (2026-11-18: 230 items, 185 MB, sent to the Recycle Bin. Kept: the 3D `.glb` work files and `backup/`, the e2e and vitest runtimes, and the evidence folders cited in `docs/models-workers-verification-2026-11-18.md`. `ollama-real-worker/` is too big for the Recycle Bin and is reused by its script.) Clear `.tmp/` dev leftovers and `test-results/`.
- [x] **P3** (2026-11-18: `public/atlas.svg` favicon; ATLAS in the loading screen, default company name, API docs title, folder picker, log prefix `[ATLAS]`, health `app` field and agent worktree commit identity. Kept on purpose: browser storage keys and file markers named `climpire`, so saved preferences and generated files keep working, and the classroom mascot image in the parked 3D work.) Replace the claw-empire favicon and branding with ATLAS.

## 14. Answers only the owner can give (YOU) 

**Please review I have updated `SETUP-INFO-NEEDED.txt`

Answers in `SETUP-INFO-NEEDED.txt` (now private, out of git) were moved into the business profiles and `knowledge/systems.md` on 2026-11-17. Still open below.

- [x] (2026-11-17, in business profiles) Service areas, business hours and prices or pricing rules for each business.
- [x] (2026-11-17, in business profiles: no unapproved discounts, availability promises, price changes or money handling) Topics, promises, discounts or customer groups agents must avoid.
- [~] Which deals and which clients count as "big" or "important" (amounts and names or rules), for section 10. - Answer From strike: For now anything ove 1K is considered big, this should be a setting honestly
- [~] Monthly spending budget per business and per provider (AI subscriptions, listing fees, ads). Answer From strike: If refering to the AI providers the usage should just be up to the subscription for now, as of now we have 0 budgets for ads, listing etc. Once we have a plan and a product/service/etc I might be willing to invest in ads agents shouldbe able to ask for approval on this
- [~] Posting frequency and the platforms for each business. (Partly answered: agents give ideas and drafts; the owner and partner post videos. Frequency still open.) Answer From strike: I am thinking a minimum of 3 per week but honestly should be more for the venture, and I have been thinking and I do want agent to make videos for veanture but this needs to be discused and applied
- [x] (2026-11-17: reputable public sources) Acceptable sources for lead research.
- [~] Where customers, jobs and quotes live today (the source of truth to import from). (Partly answered: Google Sheets for leads, Square for quotes; ATLAS is the source of truth from now on.) Answer From strike: Like meantioned there is nothing besides the excel if the agents want to make their own or use/suggest a free tool I can connect for them or maybe even one they can make themself in my homelab that would be fine with me but i have nothing 
- [x] (2026-11-17: yes, director-approved) Whether routine model upgrades may be approved by the director without you.
- [x] (2026-11-17, in `knowledge/systems.md`) Hardware available to run workers (main PC, homelab, Precision laptop) and when.

## 15. Later: 3D office and gameplay (parked)

- [ ] The 15 open office and 3D visual items in `tasks/todo.md` (approximately lines 143, 148, 207-213, 255-256, 349-350, 363 and 408). Move them here when that work resumes.

---

## Done

- 2026-11-16: Phone layout with dashboard only (no 3D office on phones) and password-protected access over the home VPN. Committed 2026-11-17.
- 2026-11-17: First full feature review and this checklist.
- 2026-11-18: Section 12 reliability: ATLAS service with crash restarts and safe updates, automatic restore-tested backups, upstream updater locked, server log rotation.
- 2026-11-18: Section 10 approvals: client importance, deal-size limit, structured routing facts, policy-driven VP prompt, trust-ramp suggestions, spending budgets.
- 2026-11-17: Agent knowledge and memory (section 2): systems registry, filled business profiles, knowledge block in task prompts, persistent memory with owner review, `knowledge.get` / `memory.*` tools, Team > Knowledge page, docs index. `SETUP-INFO-NEEDED.txt` moved out of git.
- [X] **P1 YOU** Open ATLAS on the phone over the home VPN and confirm the login page loads at the PC's LAN address on port 8800. ## 11/17 Cofirmed 
- [x] **P1 YOU** Square: press Test in Settings > Businesses > Square, map a real location to each business, then turn sync on. The token is already saved. - 11/17 Thsi si done functionality still needs to be tested through the agents 
