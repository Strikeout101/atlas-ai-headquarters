# Mailcow mailbox connections

Configure each business under Settings > Business profiles > Mailcow connections.
Nonsecret server settings can be saved before entering a mailbox password. Test
saved connection is available after a password has been stored. Leaving the
password blank on later saves preserves it.

This first version supports **implicit TLS only**, normally IMAP port 993 and SMTP
port 465. Custom ports must also accept TLS immediately. STARTTLS (including the
usual SMTP port 587) is not supported yet. Certificate verification is mandatory;
self-signed, expired, or mismatched certificates fail the connection test.

Save stores settings without contacting a mail server. Test signs in to IMAP and
verifies SMTP authentication, then closes both connections. It does not fetch
messages or send a test email. Inbox synchronization remains pending.

## Approved email sending (November 15, 2026)

An active task worker creates a contact and email draft using the business tool,
then requests approval with `business.email.request` and `draft_id`. The recipient
comes from the linked contact and the sender from that business's saved mailbox.
The worker can read `business.email.status` with `approval_id`; it cannot send mail.

The owner reviews From, To, subject, and full plain-text body in Today or the task
drawer. **Approve and send** sends that immutable message once. Deny sends nothing.
Changes to the draft, contact, suppression flag, or mailbox invalidate the request.
The same message snapshot on the same draft is deduplicated, including retries.
Requests for a different task cannot reuse another task's approval.

Email delivery history appears below Communications for the selected business.
`sent` means the configured SMTP server accepted the recipient; it does not prove
inbox delivery. `sending` and `unknown` require care: a disconnected response or
server crash may occur after acceptance. These messages are never retried
automatically. Inspect the mail server before preparing another message.

The first send implementation supports one recipient and plain text only, with no
attachments or CC/BCC. It rechecks normalized-email do-not-contact flags across
contacts at approval time. Tasks stay pending while email approval/delivery needs
attention, with their worktrees preserved. After approval, resume the task to let
the worker confirm each result and finish.

Example request file (recommended on Windows to avoid shell JSON quoting issues):

```json
{ "operation": "business.email.request", "draft_id": "your-saved-draft-id" }
```

Run it with `node scripts/atlas-agent-tool.mjs --file request.json` inside the active
task process. Credentials are managed by the server; workers must not use SMTP
directly or read server credential files.

Passwords use the existing AES-GCM server credential store. Preserve the local
`OAUTH_ENCRYPTION_SECRET` (or configured `SESSION_SECRET` fallback) separately from
the SQLite database when moving ATLAS. Saved passwords and ciphertext are never
returned by this API. Task workers have no mailbox configuration or test tool.

Implementation references: [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/)
and [Nodemailer SMTP transport](https://nodemailer.com/smtp).

## Multiple mailboxes per business (November 15)

Settings > Businesses > Mailcow connections now groups compact account rows by
business. Expand an account to edit/test it, or choose Add mailbox to add another
address. New accounts reuse server host/port suggestions from the default account,
but never copy its password. Each address can use its own permitted Mailcow login.

Use as default sender determines the account used when a task does not select one.
Workers discover safe IDs/addresses using business.email.mailboxes and can specify
mailbox_id in business.email.request. The selected sender is part of the immutable
approval and remains pinned even if the default later changes.

The migration preserves the original info@ account IDs, encrypted passwords,
connection-test history and queued approvals. Existing default-account routes are
kept for compatibility; new account creation/edit/testing uses account IDs. No
additional mailboxes are connected until their settings are entered by the owner.
