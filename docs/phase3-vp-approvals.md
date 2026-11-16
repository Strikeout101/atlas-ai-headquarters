# Phase 3: vice presidents and approval rules

ATLAS has two fixed VP identities: Codex VP and Claude VP. They have no department. Their provider, role and department cannot be edited or reassigned by automatic provider selection. Existing team leaders keep their roles.

## Approval behavior

Owner approval is always required for spending, new paid accounts, accepting terms/contracts, destructive SSH, customer-facing sends for Tech Services and Events/Rentals, and dissolving one of the six default departments. Unknown action kinds also stay with the owner. Free-text requests receive conservative spending/terms checks; each VP is additionally instructed to escalate these consequences. This is an approval boundary for supported actions, not an operating-system sandbox for unrestricted CLI agents.

Ventures email, agent task suggestions, local-to-CLI model upgrades and ordinary organization requests go to independent VP reviews. Reviews use no tools and strict JSON. Neither VP receives the other's verdict. Both approve executes; both deny denies; disagreement, escalation or invalid review goes to Today. Reasons appear on Today and Team > VP decisions.

A VP at 90% or more in an unexpired cached subscription window, or reporting a provider usage limit, is skipped. Usage-limit responses apply a 15-minute retry cooldown. The available VP may decide alone. Both limited VPs leave the item waiting and visible on Today. Busy or signed-out VPs cause a wait, rather than granting the other solo authority. Cached usage refreshes every five minutes while autonomy is enabled. The queue rotates past waiting requests.

Reviews bind to the exact action snapshot, including the target model provider. Changed requests require fresh reviews. Pending status, snapshot and owner floors are rechecked before execution. Durable review and event tables retain decisions and waits across restarts, including superseded snapshots. Emails reuse exact-content, one-time sending with uncertain delivery never retried automatically.

The review tick runs once per minute, handles one request at a time, and is gated by both emergency modes. It requires an owner password to be configured before unattended review is enabled. Disposable e2e runtimes never invoke the VP model tick. Suggested tasks become planned tasks tagged origin=autonomy; phase 3 does not start them automatically. Approved model upgrades apply to the next task resume. Phase 4's goal/planning loop is not included.

## Owner sign-in and local workers

Settings > Security lets the owner set a password and sign in with it. Approve endpoints accept password sessions or direct trusted-network sessions. Passwordless local sessions and API tokens cannot approve. Once a password is configured, a new loopback request cannot bootstrap an owner session, even using forged proxy headers. Changing an existing password requires the current password. Spawned CLI environments omit owner credentials and carry an agent marker.

This protects the HTTP approval boundary. Processes with unrestricted access to the same OS account, database and filesystem still need separate OS isolation to prevent direct credential/data access. No HTTP change can provide that isolation by itself.

## Organization and worker models

Team leaders can use org.request_hire with a workload reason for their own department. VPs can use org.request_department for create/convert/dissolve requests when assigned planning work. Requests are reviewed through the same approval system. Limits are 40 total agents and eight per department. Dissolution refuses running work and requires an explicit reassign/remove plan. Execution and decision attribution are atomic.

API/Ollama workers can select a Codex or Claude fallback in Edit agent. model.request_upgrade can include provider, model and reasoning_level. VP approval records the target provider in the task route; resuming uses that provider without changing the worker's normal configuration.

GET /api/vp-decisions exposes recent review events. GET /api/org-requests lists organization requests; POST /api/org-requests/:id/decide is the owner override. GET /api/approvals shows owner-routed items and VP waits/escalations.

## Verification limits

Automated checks use disposable/in-memory databases and stubbed provider/SMTP calls. Browser checks verify the isolated runtime marker before mutation and cover desktop and 375px width. No test sends real mail, starts a real CLI worker, or changes a real department. A consistent database backup was made before any phase 3 schema edit: backups/claw-empire.before-phase3-1794819509627.sqlite.
