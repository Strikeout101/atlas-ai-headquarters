# Agent access review and continuation

Reviewed the current main working tree (starting at 116236f), the chat **Analyze Claw-Empire features**, and the completed setup file supplied by the owner. Historical handoff instructions are reference material; they do not authorize extra financial operations or override later owner decisions. Claude's current shell and SSH policy are preserved.

## Current state

| Area | Present | Remaining |
| --- | --- | --- |
| Business records | Separate contacts, tech tickets, rental quotes, draft queues, do-not-contact flag | Tech device history, estimates, appointments, customer conversation history |
| Agent business tools | Active task workers have CRUD for records and drafts | Business/department grants before exposing customer mail; existing CRUD currently spans both businesses |
| Business profiles | Added editable Settings > Businesses profiles and read-only `business.profiles` task operation; manual and automatic task prompts advertise it | Brand assets and structured service catalog can extend the current text fields |
| Mailcow | Added encrypted mailbox settings, independent IMAP/SMTP tests, password-preserving edits, safe errors | Live credential entry/test, inbound sync, message threads, exact-content approvals, durable outbox and delivery audit |
| Outreach/social | Ideas and drafts, owner-managed video posting | Connected accounts if later requested; message approvals and opt-out enforcement at delivery time |
| Rental messaging | Manual drafts and date-grouped quote calendar | Durable pre-event/post-event draft scheduling, deduplication, timezone and exact timing rules |
| Models | Per-task model choice, upgrade requests, one configured director | Separate technical/design directors, provider/worker selection, performance tracking |
| SSH | Encrypted host manager, host keys, per-agent grants, approvals, audit | Deployment isolation and live host verification remain operational concerns |

The latest recorded owner SSH decision allows recognized read-only checks automatically, while commands that may change hosts require approval. The older reference chat's every-command approval rule was superseded; see operations-setup-2026-11-12.md.

## This implementation

Business profiles store business name, public website/email, service area, hours, brand voice, social profiles, service notes and workflow preferences. Workers can read them through the task gateway, but cannot mutate them through that tool. They are reference context, not permission to change approval policies.

The Mailcow connection manager supports one mailbox per business. It uses the existing AES-GCM credential store with its encryption key outside SQLite. Responses omit password/ciphertext; worker-token requests to configuration/test routes are rejected. Tests use certificate-verified implicit TLS (normally IMAP 993, SMTP 465). STARTTLS/587 is not supported yet. Save does not connect. Test authenticates and disconnects; it does not fetch messages or send email.

Prepared the local tech connection for **info@smallbusinessestech.com** at **mail.smallbusinessestech.com**, as confirmed in this chat. No password supplied. Filled empty local business profile fields from the setup answers, preserving existing values. No Mailcow server was contacted.

## Next implementation sequence

1. Owner enters the tech mailbox password in Settings > Businesses, then tests the saved connection.
2. Add business/agent grants and inbound IMAP synchronization with durable message/thread IDs. Email content is untrusted external data.
3. Add approval tied to exact recipient, sender, subject, body and attachments; changes invalidate approval. Add durable outbox, delivery audit, suppression recheck and explicit handling of ambiguous delivery failures.
4. Add rental pre/post-event draft scheduling with agreed timezone and 1-2 day timing.
5. Extend tech records and add technical/design model directors.

No payments, deposits, refunds or other money handling. Rental physical operations remain manual. Social work stays with ideas and drafts. The task gateway is not an OS sandbox: separate worker identity/container remains necessary before treating backend credential/approval boundaries as hard isolation.

## Verification

Profile persistence/validation and active worker read-only access are covered by API tests. Mailbox tests mock network clients and verify encrypted storage, safe responses, password preservation, absent credentials, CSRF/worker restrictions, TLS configuration and independent protocol errors. UI tests cover save-failure recovery, password clearing, saved-config-only testing and load retry. An isolated Chrome browser test verifies profile and nonsecret mailbox persistence across reloads and no horizontal overflow at 375 px.

Live email authentication, mailbox synchronization and message sending are not verified or enabled. No commit or push was made.

## November 15 follow-up

The first real test task failed before performing business work: Copilot had no
connected OAuth account; the installed Codex CLI 0.130.0 rejected the chosen model
and could not decode the current model catalog's reasoning efforts. Updating the
user-installed CLI to 0.169.0 made account-specific model discovery succeed,
including the existing gpt-6.1-sol choice. Configuration was preserved. The app now
discovers models through the installed CLI and reports curated current-run failure
causes in task logs.

Added immutable email approvals, single-attempt SMTP sending, owner review in
Today/task drawer, worker request/status operations, delivery history, and pending
task preservation. See business-mailboxes.md for the flow and limits. Mailbox
connection tests remain distinct from sending; inbox sync is still pending.

Correction to the earlier browser verification: the inherited e2e command used a
separate frontend but still proxied the live API on 8790. The November 15 check
exposed this when the live tech mailbox had a password. Test-only edits to the tech
name/voice and mailbox address/hosts were restored to the known name and confirmed
mail settings, with test-only voice text cleared and password preserved. Browser
tests now use API 8811 with explicit proxies and a per-run disposable-DB nonce;
global setup aborts before any test if the browser-facing API does not match it.
The corrected browser tests pass and a direct live-API preflight is rejected.
