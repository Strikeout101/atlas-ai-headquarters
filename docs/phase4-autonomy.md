# Phase 4: goals, opportunities and scheduled work

The Autonomy workspace at /autonomy manages business goals, estimated opportunities, recurring routines, operating limits and a durable activity ledger. Installing phase 4 creates no goals or enabled routines and starts no new business work by itself. Existing phase 2/3 changes are preserved.

## Setup and operating limits

Choose an existing project with an explicit absolute path for every goal, opportunity and routine. No project directories are guessed or created. Goals define a business, metric, target and date window. Actual progress is counted from project completed tasks or business contacts/drafts; the displayed scope distinguishes these. Financial/custom metrics remain unavailable until their evidence source exists. A completed task is never inferred to be a launched product, delivery, paid order or verified income.

Defaults are six new autonomous task starts per America/New_York calendar day, subscription usage below 80% in every Codex and Claude window, schedule pause after three consecutive genuine run failures, and a six-hour planning interval per goal. The owner can change the limits in Autonomy. Owner authentication and the emergency controls remain required; limits never relax approval floors. Usage data must be valid, available and no older than ten minutes. Unknown usage fails closed.

## Planning and approval

The bounded VP planning beat compares one active unmet goal with observed results and the opportunity queue. Its no-tools reply can estimate up to three opportunities and suggest up to two tasks for existing team leaders. Demand and revenue scores are favorable when high; cost, difficulty and time-to-launch scores are unfavorable when high. Scores and budgets are estimates. A budget is never authority to spend.

Planning advances its durable per-goal timestamp before invoking the model to prevent repeated calls after failures/restarts. Edited goals, stopped autonomy, revoked security readiness and changed headroom discard late results. Duplicate tasks and out-of-scope projects/departments are rejected. Invalid replies queue no work.

Generated work enters the existing proposal feed for independent VP reviews. Only an attributed approved proposal can produce an eligible planned task. The engine checks the reviewed content, project, team-leader assignment and source again before admitting a start, and again after model routing awaits. Only linked work created by this engine is automatically picked up; arbitrary owner tasks and older suggestions are not swept into the planner.

Ventures preparation/implementation may start after review. Tech and rental routines prepare research, qualified contacts, demos and drafts. Outgoing email and other customer-facing actions continue through their existing owner approval gateways. Spending, paid accounts, contracts, destructive SSH and default-department dissolution keep phase 3's owner floors. Planning cannot approve its own tasks.

## Schedule and task reliability

A due routine atomically advances to now plus its interval before queueing work. Missed intervals never create a catch-up burst. A pending or running prior occurrence causes the new occurrence to be skipped and recorded. No task or model is launched directly by a schedule; the occurrence creates a reviewable proposal first.

The daily cap is reserved in the same transaction as admission, before launch. Ambiguous launches and pending recovery are held rather than automatically replayed. Owner pauses and intentional context continuation do not count as failures. Genuine failed runs count once. The third consecutive failure pauses the routine; a completed task resets the streak. Explicitly re-enabling a paused routine resets its streak and records the owner's retry. Failed tasks and their worktrees remain available for manual recovery.

Disabling/changing a routine, stopping an opportunity, changing a reviewed proposal or reassigning its task blocks the pending automatic start. Resuming the global control mode does not replay held running work. Autonomous origin propagates to delegated child tasks so emergency and usage guards continue down the delegation chain; new child task starts also share the daily cap. Context continuation of the same task reuses its admission.

## Lead routines and Today

The routine form offers preparation-only lead-research presets for Tech Services and Events/Rentals. Select a project and team-leader department, review the description and explicitly enable the routine. No lead source is fabricated: the assigned workers research public sources and store evidence with contacts and drafts using existing business tools.

Today shows one While you were away digest with starts, completions, waits, skips, declines and configuration activity. Fetching does not acknowledge it. Mark read saves an explicit browser cursor. Full counts cover all matching events even when only the latest 200 can be returned and six are previewed. The Autonomy workspace exposes the recent ledger.

## Boundaries and verification

Phase 4 does not implement payment sync, financial ledgers, verified revenue, Etsy publishing or itch.io publishing; these remain phases 5 and 6. HTTP approval restrictions do not isolate unrestricted agents from the owner's operating-system account/filesystem.

Before schema edits a consistent backup was saved to backups/claw-empire.before-phase4-1794821111925.sqlite. The migration was checked on a disposable copy of that backup, including a second startup: existing counts and business rows preserved, clean integrity and foreign-key checks, and no enabled schedules seeded. Tests use stand-in models/workers; no real autonomous worker, email delivery or paid action is started as a verification step. Browser tests must verify the disposable database marker before mutation, and model review/planning/engine beats are disabled in that runtime.
