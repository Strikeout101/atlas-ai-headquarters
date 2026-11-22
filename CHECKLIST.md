# ATLAS master checklist

The one place for everything that is pending: features to build, accounts to connect, decisions to make and loose ends.
Anything pending goes here, not in chat, not only in `tasks/todo.md` and not in a phase doc.

**Goal:** agents run the businesses (Small Business Tech, Primrose Events, AI Ventures), the homelab and whatever comes next on their own.
Today the owner approves almost everything because the system is being tested. That is temporary.
In the end the owner approves only big deals, important clients, money and anything irreversible.

**Start with section E** (the business engine, which is the point of the redesign). **Not in scope for now:** the 3D office and gameplay. The foundation is in place and it is parked until after this list (see section 15).

Last full review: 2026-11-18 (added section E after checking the checklist against the original Starnet-based plan).

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
- **Approvals:** two VPs review proposals, model upgrades, org changes and Ventures email or listings. Per-business approval levels, deal-size and client limits, spending budgets and a trust ramp are owner settings. Customer-facing work for Tech and Primrose and all spending go to the owner. Emergency pause and stop are available.
- **Autonomy engine:** goals, scored opportunities, research schedules, a daily start cap and a usage-headroom gate. Nothing is configured yet and every routine is off.
- **Businesses:** contacts, tickets (Tech), quotes (Rental), drafts, a deals pipeline, a ledger and spend requests. These are records only.
- **Email:** three business mailboxes are connected and tested. Sending works after owner approval, one recipient, plain text. Nothing reads the inbox.
- **Instagram:** the Primrose account row exists, read-only, but no access token is stored, so nothing is connected yet.
- **Square:** read-only sync is on. Several Square accounts are supported; Tech and Ventures are mapped, Primrose (its own Square account) is not connected yet.
- **Listings:** agents prepare Etsy and itch.io packages. The owner publishes them by hand.
- **Homelab:** real SSH to one host. Read-only commands run automatically; everything else needs approval.
- **Models:** Codex and Claude subscriptions with a per-provider usage gate. Routing routine work to the local `Precision` host is built but off (its tool worker is not verified yet).
- **Running:** a login service runs the latest committed build on port 8800 with crash restarts, updates with rollback and daily restore-tested backups. Phones use it over the home VPN with a password (Today dashboard, no 3D office). English only.
- **Agent knowledge:** task prompts, meetings, chat replies and the think loop carry the project goal, business profile, systems summary and relevant memories. Lessons are checked at task end. Review memories under Team > Knowledge.

---

## E. Business engine: the Starnet integration (the main goal)

**Why this section exists.** The redesign set out to turn ATLAS from a team that finishes assigned tasks into an engine that finds opportunities, makes products, sells them, gets paid and learns what works. It is based on the 10 features in the original plan, with `androoAGI/starnet` as the reference for autonomy logic and capabilities (nothing copied). The sections below this one are either inputs to the engine (accounts, channels, integrations) or polish. **When choosing work, items here come first.**

**First income stream to run end to end: Ventures Etsy digital products** (owner decision 2026-11-18). Then reuse the same engine for Small Business Tech sites and dashboards, game assets and Primrose.

### The 10 features: where they stand (reviewed 2026-11-18)

| #   | Feature                                               | Status             | What is missing                                                                                                                                                                                |
| --- | ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Goal engine (work toward targets like $X a month)     | Built, not running | No goals set yet (owner waits for the engine to be complete). Money goals count only verified ledger income. Goals have no milestones.                                                         |
| 2   | Opportunity discovery (research, score, queue)        | Built              | Scored queue, VP planner, research schedules, and `opportunity.propose` for research agents (2026-11-18).                                                                                      |
| 3   | Business tools (do real work in real systems)         | Partial            | Web, email, GitHub, Square, SSH, listing packages, image studio (free mockups; AI images off until set up), Etsy API (built, not yet tested live). Missing: video.                             |
| 4   | Persistent work and schedules                         | Built              | Interval schedules, auto-pause after repeated failures, daily start cap, usage gate. Missing: time-of-day schedules.                                                                           |
| 5   | Business project manager (one view per income stream) | Partial            | Projects belong to businesses; deals and ledger link to opportunities. Missing: one page per stream with goal, products, spend and results.                                                    |
| 6   | Product creation pipeline                             | Built, not running | Etsy playbook (research → build → mockups → listing → approval → Etsy draft/publish), editable in Autonomy > Playbooks (2026-11-18). Starts once a research schedule and goal are switched on. |
| 7   | Customer acquisition                                  | Partial            | Contacts, drafts, lead research schedules. For Etsy, traffic comes from search and social; social posting is not possible yet (section 5).                                                     |
| 8   | Sales and fulfillment                                 | Partial            | Quotes and approved email. For Etsy: orders and customer messages are not read; Etsy delivers digital files itself.                                                                            |
| 9   | Revenue and profit                                    | Built              | Ledger with verified Square and Etsy money, fees and refunds; monthly costs; profit per business and opportunity (2026-11-18). Etsy mapping verified once live.                                |
| 10  | Experiments and optimization                          | Built              | Budgets, task and time limits enforced; variants measured from sales and favorites; owner stop rules; planner keeps, changes or stops (2026-11-18).                                            |

Starnet mechanisms already in ATLAS: emergency stop and pause, owner and VP approvals (ATLAS's version of Starnet's consent rules), daily start cap, a ledger that records skips, the "while you were away" digest on Today, schedules that auto-pause, the trust ramp and the usage gate. Not yet: soft money budgets per run and per day with a one-click resume (see section 11), time-of-day schedules, protection against instructions hidden in content agents read, and goal milestones the owner confirms.

### Build: Etsy first

- [x] **P1** (2026-11-18, `server/modules/playbooks.ts`; Autonomy > Playbooks; steps run as ordinary autonomy work through every gate) **Etsy playbook.** One routine for Ventures:
  - Research niches.
  - Score each idea as an opportunity, with a budget and time limit.
  - Make the product files, then mockups and preview images (studio).
  - Build the listing package and send it for VP review.
  - Publish through the API, or hand it to the owner while the API is not approved.
  - Track views and sales.
  - Build it on the existing opportunities, schedules, listing packages and approvals. Each step's result is recorded, so a generated product, a published listing, an order and a payout stay separate states.
- [x] **P1** (2026-11-18, `server/modules/studio.ts` and `media-library.ts`; Settings > Businesses > Image studio; Team > Knowledge > Media. Free mockups work now; AI images off until the owner sets a service and cap) **Image studio.** An agent tool that makes images (mockups, previews, social images, later game assets and video):
  - The provider is a setting: a paid service or a model on the homelab or Precision.
  - Each use is recorded as a cost and counted against a monthly cap set by the owner.
  - Outputs go to the media library (section 5) with what made them and their license terms.
- [x] **P1** (2026-11-18, built: `server/modules/etsy.ts`, Settings > Businesses > Etsy, `docs/etsy.md`. Tested against Etsy's spec and fakes; **verify live once the developer app is approved**) **Etsy API** (details in section 6): create and update listings as drafts, read orders, payments and fees into the ledger as verified income and costs.
- [x] **P1** (2026-11-18, `server/modules/experiments.ts`; stop rules in Autonomy) **Experiments and auto-stop:**
  - Enforce each opportunity's money and agent-time budget.
  - Let agents try variants (titles, prices, images) and record the results.
  - Have the planner keep, change or stop an opportunity by rules the owner can edit.
  - Record every stop in the ledger with its reason.
- [x] **P1** (2026-11-18, `server/modules/profit.ts`; Revenue > Profit. Owner enters monthly costs and confirms they are complete) **Costs and profit:**
  - Count AI subscriptions as monthly costs, and per-use costs (studio, listing fees, ads) as expenses.
  - Show profit per opportunity, per stream and per business.
  - Profit goals (section 10) depend on this.
- [x] **P1** (2026-11-21, `server/modules/etsy.ts`, `listings.ts` (`createRevision`), Settings > Businesses > Etsy > Show shop listings, `docs/etsy.md` "After a listing is live". Tested against fakes; verify live with the item below) **Etsy after launch:**
  - Experiment changes reach Etsy: `listings.revise` makes an approved revision that ATLAS applies to the live listing (title, description, tags; price through inventory; images and files replaced without leaving the listing empty). Price moves over 50% need the owner.
  - Listings of stopped opportunities are set inactive on Etsy (never ones the owner brought in).
  - Every shop listing is mirrored, including ones ATLAS did not create; the owner can bring one into ATLAS; agents read them with `etsy.listings`.
  - Edits, publishing and deletion done on Etsy are read back into ATLAS.
  - Tags read back after saving (falls back to one field per tag), image alt text, half-pushed drafts finish on retry.
  - Etsy's daily request allowance is tracked; background sync pauses near the limit.
- [x] **P1** (2026-11-21, `syncEtsy` in `server/modules/etsy.ts`, `docs/etsy.md` "How orders and payment records are read"; verified read-only against the live shop) **Etsy sync date windows:** Sync failed with "min_created and max_created must be no more than 31 days". Orders and ledger entries are now read in 30-day windows with every page, per-window checkpoints, a one-hour overlap and dedupe by Etsy id; **Re-read history** imports older records. Requests are spaced for the 10 per second / 10,000 per day limit.
- [ ] **P1** Verify the Etsy connection live once the developer app is approved: connect, push one real draft, check its images (with alt text), file and all 13 tags, publish, then confirm one order and its fees land in Revenue. Adjust `classifyLedgerEntry` in `server/modules/etsy.ts` to Etsy's real fee labels. Also check once: a revision that changes the price (inventory update), one that replaces images, a stopped opportunity's listing going inactive, a shop sync that reads existing listings, and the "requests left today" line on the Etsy card.
- [ ] **P3** Etsy webhooks (order paid/canceled, listing updated) instead of the 30-minute poll. Needs a public https address (tunnel) and the endpoint registered in Etsy's developer portal (**YOU**), plus signature checking (Standard Webhooks HMAC). Only worth it if 30 minutes proves too slow.
- [ ] **P3** Read Etsy shop reviews for agents (Etsy has a reviews API), through `guardValue` and `recordUntrustedContent` like other outside text. Customer messages and shop statistics are not in Etsy's API.
- [ ] **P2** Run the real-model playbook check when a subscription is under the 80% usage limit: `pnpm exec tsx scripts/qa/etsy-playbook-planner.ts --run` (blocked on 2026-11-18: Claude 7-day at 94%, Codex also over the limit).
- [ ] **P2** Owner create and edit of listing packages from the Listings panel (agents create them today; the owner can only approve, publish and withdraw).
- [x] **P2** (2026-11-19, Revenue > Income streams, `server/modules/streams.ts`, `GET /api/streams`) **Income stream page:** per stream, the goal against verified revenue, the products and opportunities with their status, spend, results and what the engine plans next.
- [x] **P2** (2026-11-19, `server/modules/schedule-time.ts`, Autonomy > Schedules "Time of day"; daylight-saving safe, unreadable rules refused) **Time-of-day schedules** ("weekdays at 9", with a time zone). Refuse schedules that cannot be read exactly instead of guessing.
- [x] **P2** (2026-11-19, `server/modules/content-guard.ts`; covers `web.search`/`web.read` today, approvals from a flagged task or its delegated tasks go to the owner with a red badge) **Content guard:**
  - Mark web pages, emails, listings and reviews that agents read as untrusted.
  - Strip or flag text that tries to give instructions.
  - Never let flagged content trigger a send, publish or spend without the owner.
  - This matters once inbox sync (section 7) and Etsy messages are read.
- [ ] **P2** When inbox sync (section 7), Etsy messages or reviews are given to agents, pass them through `guardValue` and `recordUntrustedContent` in `content-guard.ts`, the same way the web tools do.
- [x] **P2** (2026-11-19, `server/modules/goal-milestones.ts`, under each goal in Autonomy, shown on the stream page and to the planner) **Goal milestones:** steps under each goal, done only when verified data or the owner confirms them, not when a task says so.
- [ ] **P3** Browser automation (agents filling in web forms). Not chosen on 2026-11-18; revisit if Etsy refuses the API app.
- [ ] **P3** Connector catalog (one-click plug-in tools such as Canva or Google Sheets, each with its own permission). Not chosen on 2026-11-18; later.

### Owner steps for the Etsy path

- [x] **P1 YOU** (2026-11-21: shop and developer app set up, connected in Settings, sync verified live) Create or confirm the Ventures Etsy shop (billing, payout account, shop name), and apply for an Etsy developer app at etsy.com/developers. Enter the key in Settings once it is approved. Until then, agents prepare listings and you publish them.
- [ ] **P1 YOU** Sign Claude in again for ATLAS: run `claude` once in a terminal (or sign in from Settings). The saved Claude login expired on 2026-11-19, so the usage check reports Claude as unavailable, which blocks all autonomy work and leaves the Claude VP unable to review (both VPs must be signed in). Found 2026-11-21.
- [ ] **P1 YOU** Create the Ventures Etsy project (Projects > New: business Ventures, a folder for product files, for example `C:\Users\Strikeout\Projects\ventures-etsy`). There is no Ventures project yet, and the playbook's research schedule and every step need one.
- [ ] **P1 YOU** Switch ATLAS from Stopped to Running (emergency controls on Today). It has been Stopped since 2026-11-19.
- [ ] **P1 YOU** Decide auto-publish: it is ON, so a listing you approve is published at once (USD 0.20 each). Turn it off to check each Etsy draft before publishing.
- [x] **P1** (2026-11-21, `goal-strategy.ts`, `autonomy-planner.ts`; strategy shown under each goal in Autonomy) **A goal is enough to start.** A goal with no current strategy gets a strategy task (VP-approved): the agent chooses how to research, saves a plan with the arithmetic (`strategy.save`) and proposes ideas tied to the goal and playbook; the planner then plans within that strategy. Refreshed every 14 days, or after 3 days with no ideas left. No research schedule or research instructions needed from the owner.
- [x] **P1** (2026-11-21, `searchEtsyListings` in `etsy.ts`, agent tool `etsy.search`; research step rewritten around it) Etsy market research for agents through Etsy's public listing search. General web search below is still open.
- [x] **P1** (2026-11-21, `ETSY_TAG_MAX` in `listings.ts`) Etsy tags are checked to 20 characters when a package or revision is written.
- [x] **P1** (2026-11-21, `web-search.ts`, Settings > Businesses > Web search for agents) **General web search for agents.** `web.search` uses the owner's search service (Serper for Google results, Brave Search API or Tavily) with a monthly cap; without a key, a slow cached DuckDuckGo search replaces the broken Bing RSS feed (it refuses after a few searches).
- [~] **P1** (2026-11-22, `scripts/atlas-service/supervisor.mjs`: hard deadline on the health check, step tracing, 30-minute heartbeat, a stalled pass is logged and the loop carries on) The service supervisor stopped picking up requests twice (2026-11-21 07:50 and 2026-11-22 01:04 UTC), both times right after a "restart" request followed an update; the server stayed healthy. Root cause not confirmed; if it happens again, supervisor.log now names the step it was stuck on.
- [ ] **P3 YOU** (optional since 2026-11-21: Codex and Claude agents use their built-in web search) Add a web search key in Settings > Businesses > Web search for agents (Serper for Google results) if agents without built-in search (local models) need reliable search.
- [x] **P1** (2026-11-21, `skill-installer.ts`, `org-requests.ts` kind `install_skill`) **Skills for agents.** 21 reviewed skills install once at startup for every provider the agents use (Anthropic documents and design, marketing research, pricing, copy, launch, SEO, Etsy SEO). Agents find more with `skills.search` and ask with `skills.request`; both VPs review with the skill's own description; approval installs it. Library installs now go to the global skill folders (they used to land in ATLAS's release folder, which agents never read and each update replaced) and install only the chosen skill.
- [x] **P2** (2026-11-22, Decision Inbox, `review-round-items.ts`, `meetings/minutes.ts`, `one-shot-runner.ts`, `agent-knowledge.ts` `TEAM_VOICE`) **Decisions readable, agents casual.** Review options were cut at 220 characters and each team lead appeared twice; now one option per lead (latest stance), kept whole, and older cut notes are restored from the meeting transcript. The decision message no longer repeats the options. One-shot replies (meeting turns) are no longer cut at 420 characters. The planning lead's suggestion gets everything up front and 90 seconds (it used to time out after one sentence). Agents write plainly and casually to the owner (customer-facing text keeps the brand voice).
- [x] **P1** (2026-11-22, `etsy-shop.ts`; Settings > Businesses > Etsy > Shop setup; Today "Etsy shop setup") **Agents set up and manage the Etsy shop.** A new shop gets a shop setup task once the goal has a strategy (logo, banner, title, announcement, About story, digital-order message, sections); the proposal is VP-approved; ATLAS applies text and sections through the API; the owner uploads logo, banner and story (Etsy's API cannot). Listing views are now recorded with favorites. Free-time agent ideas no longer go to projects that have a goal.
- [ ] **P1 YOU** Reconnect Etsy once (Settings > Businesses > Etsy: Connect, approve, paste the address) so ATLAS can apply approved shop changes (new permission `shops_w`).
- [x] **P1** (2026-11-21, `cli-tools.ts` `--search`, `studio.ts` `registerImage`) **Agents use their own web search and image generation.** Codex workers now start with its built-in web search (it was off), so web research needs no key. Codex-generated images go into the project's `atlas-media/` and the media library through `media.register`. Note: built-in search is not screened by the content guard the way `web.search` is.
- [x] **P2** (2026-11-21, `org-requests.ts`, `autonomy-engine.ts`) **Hiring fixes.** A hire with no provider named gets its department leader's provider (it used to get "api" with no provider and could not run). A leader's new task says when 3 or more tasks are waiting in the department and points to `org.request_hire`.
- [ ] **P2** Run the real-model playbook check (`scripts/qa/etsy-playbook-planner.ts --run`) once Claude is signed in and usage is under 80%, before switching the research schedule on.
- [x] **P1 YOU** (2026-11-21: not needed. Codex agents generate images with their built-in image generation and record them with `media.register`; the image API stays optional for providers without it) Choose how images are made (a paid image service with a monthly cap, or a free model on the homelab or Precision) and set the monthly cap.
- [ ] **P1 YOU** Set the Etsy listing-fee budget. Today it is $0, so every $0.20 listing waits for you (also in section 6).
- [ ] **P2 YOU** When the playbook is ready, set the first Ventures goal (for example, verified revenue per month) and turn on its routines (see section 10).
- [ ] **P3 YOU** Ventures videos: talk through the approach (free tools, a paid service, or you film and agents edit). Decided on 2026-11-18 to leave this until the first stream works.

---

## 1. Loose ends right now

- [x] **P1** (2026-11-17, committed together with agent knowledge and memory) Commit the phone layout and VPN launcher work Codex finished on 2026-11-16 (bottom tabs, menu drawer, Office hidden on phones, `start-atlas.bat` now runs `pnpm dev`). It is verified but uncommitted.
- [x] **P1** (2026-11-18, Codex, `autonomy-engine.ts` `autonomyTaskUsageBlockReason`: each run checks only the provider it is routed to; planning checks the selected VP. Claude-routed work still needs a valid Claude usage reading.) Claude subscription usage reads as "unauthenticated". Because of that, the autonomy engine blocks every autonomous start ("claude subscription usage is unavailable"). Fix the usage reader or make the gate use whichever providers are actually in use.
- [ ] **P2 YOU** Instagram: connect a token in Settings > Businesses and run Test. The account row exists but no token is stored.
- [ ] **P2 YOU** Square for Primrose: add Primrose's own Square account in Settings > Businesses > Square (several accounts are supported since 2026-11-17), press Test, map its location to Primrose and turn sync on.
- [x] **P2 YOU** Review the filled business profiles in Settings > Businesses (prices, hours, voice, rules were copied from `SETUP-INFO-NEEDED.txt` on 2026-11-17). 11/17
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
- [ ] **P1 YOU** For worker isolation (next item): create a separate Windows user for agent workers when Claude or Codex is ready to build it. Only you can set its password.
- [ ] **P1** **Worker isolation.** Agents run with permission checks turned off (`--dangerously-skip-permissions`, `--yolo`, `--auto`) as the same Windows user as ATLAS, so they can read `.env` and the database directly. Before agents get more powerful accounts, run them under a separate user or container that has no access to ATLAS secrets.
- [ ] **P2** Scope agent business access by business and department. Today any agent can create, edit or delete records for all three businesses.
- [ ] **P2** One credential area in Settings listing every connected account, its business, its last successful test and its expiry date, plus a warning before tokens expire.
- [ ] **P2** Instagram tokens have no automatic refresh. Add a refresh job before the 60-day expiry.

## 4. Websites and code (GitHub + Vercel)

Nothing exists for this yet.

- [x] **P1 YOU** List each website with its repo, GitHub account, Vercel project, domain and registrar (for the systems registry).
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
- [ ] **P2 YOU** Create a Vercel access token for each Vercel account (Primrose and Small Business Tech) and enter them in Settings once the integration exists.
- [ ] **P1** Add a Vercel integration (token per Vercel account or team): list projects, deployments, build logs, environment variable names (not values) and domains.
- [ ] **P1** Website change flow: agent branch, then pull request, then Vercel preview URL, then automatic checks (build, links, a screenshot on phone and desktop), then merge. Small content edits merge automatically once trusted (section 10). Layout or pricing changes go to the owner.
- [ ] **P2** Watch production: uptime checks, failed deployment alerts, SSL and domain expiry.
- [ ] **P2** DNS: read records at the registrar or Cloudflare. Changes always need approval.
- [ ] **P3** Site analytics (Vercel Analytics or similar) feeding goals: visits, contact form leads.
- [ ] **P3** Contact forms on the websites create a contact and a ticket or quote in ATLAS automatically.

## 5. Social media

Today Instagram can be read, and drafts exist as records only. No platform can be posted to.

- [ ] **P2 YOU** For Instagram and Facebook publishing: create a Facebook Page for each business that posts, and a Meta developer app. Agents cannot do this for you.
- [ ] **P1** Instagram publishing through the Graph API (needs a Facebook Page and a Meta app). Include photo, carousel, caption and a scheduled time, all under the approval policy.
- [ ] **P1** Content calendar: planned posts per business with status, date, platform and the assets used.
- [ ] **P2** Facebook Page posting (same Meta app).
- [ ] **P2** Google Business Profile: posts, reviews and replies to reviews. This matters a lot for local service businesses.
- [ ] **P2** Comment and DM inbox: read new comments and messages, draft replies, send under policy.
- [ ] **P2** OAuth login flow for social accounts, so tokens are not pasted by hand.
- [ ] **P3** TikTok (deferred), then others as needed.
- [ ] **P3** Post performance (reach, likes, follows) feeding goals and the next content plan.
- [~] **P1** (2026-11-18: built for studio images, `server/modules/media-library.ts`, Team > Knowledge > Media; owner uploads of brand assets and photos still to do) Media library: brand assets, logos, photos of rentals and work, generated images with their source and license, with tags agents can search.

## 6. Selling pages and storefronts

- [x] **P1 YOU** Decide which storefronts are in use: Etsy, itch.io, Square Online, Shopify, Gumroad or the businesses' own sites. Answer From strike: All the ones mentioned exept Gumroad
- [~] **P1** (2026-11-18: built in section E, verify live once the app is approved) Etsy API publishing (needs an Etsy-approved developer app; owner step in section E). Include listing create and update, inventory, prices within limits, and reading orders.
- [ ] **P2** itch.io uploads with the butler tool.
- [ ] **P2** Orders flow: new order, record it, fulfil it (digital delivery or a task), send the customer a message, and mark the deal paid only from verified payment evidence.
- [ ] **P1 YOU** Raise the listing fee budget from $0 if you want VPs to approve normal Etsy listings. Today every $0.20 listing goes to the owner (also in section E).
- [ ] **P3** Square catalog and invoices (read first, then create invoices under the approval policy).

## 7. Communication

- [ ] **P1** Inbox sync (IMAP) for the three mailboxes. New mail becomes a thread linked to a contact. Agents classify it and draft replies.
- [ ] **P1 YOU** Create a Telegram bot with @BotFather and enter its token in Settings (needed for phone notifications, next item).
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

- [x] **P1 YOU** Provide the rental inventory, pricing rules, delivery and service area rules, and an example quote format. Answer From strike: Has been answered in SETUP-INFO-NEEDED
- [ ] **P2** Inventory and availability by date, so a quote cannot double-book an item.
- [ ] **P2** Pre-event and post-event message schedule: confirmation, delivery reminder, check-out, check-in, review request.
- [ ] **P2** Quote documents (PDF) and acceptance tracking. Today "shared" sends nothing.
- [ ] **P3** Contracts and waivers to sign.

### AI Ventures

- [ ] **P2** (now the section E Etsy playbook) A pipeline from idea to product to listing to sale, with results tracked per product.
- [ ] **P3** Asset generation and quality checks before a listing is prepared.

### Shared

- [ ] **P2** A real calendar module across all businesses (today Events only groups quotes by date).
- [ ] **P2** Lead sources for the research schedules (which sites, directories or maps are allowed). The engine never invents leads.
- [ ] **P3** Import existing customers and jobs (from Square, sheets or wherever they live now).

## 9. Homelab

- [x] **P1 YOU** List all hosts (name, address, purpose, OS) and how ATLAS reaches each. Only "Media" is connected now. Answer From strike: Has been answered in SETUP-INFO-NEEDED
- [ ] **P2 YOU** On each homelab host, create a dedicated agent login with only the sudo it needs (Claude can give you the exact commands).
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
- [ ] **P2 YOU** (after section E's Etsy playbook) Set up the autonomy engine for real: pick projects, write goals, turn on chosen routines. Answer From strike: I do not want to do this until all/most the autonomy setting/features/logic are in place
- [ ] **P3** Profit goals (needs costs plus verified revenue; costs are a section E item).
- [ ] **P3** Money movement (refunds, payouts, deposits) stays manual until you decide otherwise.

## 11. Models and workers

Section 11 work by Codex on 2026-11-18, reviewed and committed by Claude the same day. Details: docs/models-and-workers.md and docs/models-workers-verification-2026-11-18.md.

- [x] **P2** (2026-11-19, `server/modules/workflow/core/gemini-command.ts`, CLI runtime, Settings) Gemini agent slot now detects and launches Antigravity CLI (`agy`) with its headless stream protocol, lists its models, and retains the legacy Gemini CLI fallback. `agy.exe` was found at the official Windows install location and detection reports installed/authenticated (v1.5.12); a real headless stream run returned `ATLAS_OK`. Focused tests, typecheck, and scoped lint pass.
- [ ] **P2** Update the running ATLAS service after the Antigravity CLI integration is committed. The service on port 8800 runs a stable build of the latest commit, so the source change is not live yet.

- [x] **P1** (2026-11-18, `scripts/qa/autonomy-real-cycle.ts`, `docs/models-workers-verification-2026-11-18.md`) Real isolated goal → planner → independent Codex/Claude VP approval → Claude worker → result → engine goal progress passed. Final task consensus uses an exact-result oracle; production routines remain disabled.
- [x] **P2** (2026-11-19, `workflow/agents/providers/codex-completion-drain.ts`, adjacent tests and `workflow/core/one-shot-runner.test.ts`) Codex shutdown now requires successful OS exit plus its structured terminal event before releasing inherited pipes; final JSON without a newline is supported. Fourteen lifecycle tests and a real no-tools probe passed (5.3 s); evidence in `docs/models-workers-verification-2026-11-18.md`.
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
- [x] **P3** (2026-11-21: removed; still in git history) Second cleanup pass: generated `docs/architecture/` and `scripts/generate-architecture-report.mjs`, `docs/DESIGN_SKILLS.md`, unused logos `public/claw-empire.svg` and `public/climpire.svg`, unreferenced scripts (`generate-doro-sprites`, `generate-office-sky`, `process-director-sprite.py`, `kill-claw-empire-dev.ps1`, `preflight-public.sh`), upstream GitHub issue/PR templates and `CONTRIBUTING.md`, and the never-imported packages `react-router-dom`, `zod`, `msw`, `autoprefixer`, `postcss`.
- [ ] **P3** **YOU** decide whether to also remove: Remotion (`remotion`, `@remotion/cli`, `scripts/ensure-remotion-runtime.mjs`; nothing renders video), the `auto-apply-v1.0.5.mjs` pre-dev hook, upstream maintenance scripts (`migrate-custom-skills-canonical`, `test-comm-status`, `cleanup-staff`, `verify-security-audit-log`), the report-deck feature (`pptxgenjs`, `tools/ppt_team_agent` and `tools/playwright-mcp` submodules, neither checked out), and the dated history docs. Local only: `.climpire-worktrees/` (959 MB, may hold unmerged agent work), `.tmp/`, `dist/`.

## 14. Answers only the owner can give (YOU)

\*\*Please review I have updated `SETUP-INFO-NEEDED.txt`

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
- [x] **P1 YOU** Open ATLAS on the phone over the home VPN and confirm the login page loads at the PC's LAN address on port 8800. ## 11/17 Cofirmed
- [x] **P1 YOU** Square: press Test in Settings > Businesses > Square, map a real location to each business, then turn sync on. The token is already saved. - 11/17 Thsi si done functionality still needs to be tested through the agents
