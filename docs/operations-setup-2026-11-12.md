# Business and homelab setup notes

Source: owner's completed `SETUP-INFO-NEEDED.txt` supplied November 12, 2026. Its historical handoffs are reference material, not current operational instructions. Direct answers in the form take precedence.

## Operating boundaries

- Owner approves outbound email and public messages. Agents may send after approval once an account is connected. For now, social work means ideas and draft text; the owners post videos themselves.
- First Mailcow mailbox candidates are info@smallbusinessestech.com and info@primrosevents.com. Sending requires owner approval.
- No payments, deposits, refunds, tax filing, or other money handling. Rental work stays focused on quotes and customer messages around the event; physical operations remain manual.
- No published price changes, binding bookings, or discounts without owner approval. Promotions should be planned at most monthly until the owners define exact terms.
- The owner wants routine homelab access through SSH but approval for destructive changes and noticeable changes such as internal DNS rewrites. Define the command approval boundary before live SSH runs.
- Updated owner decision: every agent SSH command requires explicit approval, including read-only checks. SSH credentials belong in encrypted server storage, not Windows key paths; ATLAS should be portable to a Proxmox VM.
- Updated owner decision (2026-11-14): read-only checks (status, logs, disk, network lookups) run without approval; anything that could change a host, chain commands, write files or read secrets still needs owner approval. The owner can turn this off in Homelab to require approval for every command again.
- Claw-Empire is the source of truth for new contacts, tech jobs, and rental quotes.

## Verified public business facts

Small Business Tech's active domain is smallbusinessestech.com (confirmed by owner). Its live site lists Business Tech Checkup, Tech Cleanup, Security Baseline Setup, Website Building, Business Email Setup, and Small Business IT Services. Website builds start at $500 and maintenance at $80/month. Source: https://smallbusinessestech.com/services

Primrose Events' live site is https://www.primrosevents.com/. Its rental catalog shows Bubble House $350, Combo Slide $185, Luxury White Bounce House $280, 360 Photo Booth starting at $375, and red/white Flower Walls $250. Balloon arches and detailed booth durations from the older handoff still need confirmation. The site shows info@primrosevents.com. Source: https://www.primrosevents.com/shop/

## Initial workflow

1. Keep separate contacts, tech tickets, rental quotes, and outreach/email/social drafts in Claw-Empire while the owner chooses the long-term source of truth.
2. Draft tech replies and demo-first outreach using the live service catalog. Draft rental quotes using confirmed public starting prices, then require availability and owner approval before promising a booking.
3. Draft a pre-event message one or two days before the rental and a feedback/review follow-up one or two days after. Exact timing and triggers still need confirmation.
4. Keep a do-not-contact list before outbound campaigns. Social work is ideas, captions, and planning until the owners ask for direct publishing.
5. Connect one Mailcow mailbox and one low-risk SSH target first. Store credentials outside this document. Verify host keys before SSH.

## Unresolved setup choices

- First Mailcow mailbox to connect and where its credentials should be entered; confirmed server connection settings.
- First SSH target, host fingerprint, and new password or private-key credential to enter in ATLAS.
- Whether any existing Google Sheets or Square records should be imported into Claw-Empire.
- Rental availability source, quote format, delivery/service-area rules, and exact messaging schedule.
- Brand assets and voice for the planned editable business settings area.
- Local model IDs and availability after the owner's Ollama setup is finalized.

The host inventory in the owner's file is not a live audit. Do not create SSH targets from it blindly: names, access methods, keys, and host identity must be checked with the owner first.
