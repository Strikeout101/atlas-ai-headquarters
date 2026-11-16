# Phase 5: pipeline and verified money

The Revenue workspace at /revenue combines internal sales records with separately sourced payment evidence. This phase tracks records and reads Square. It cannot charge, refund, transfer funds, create an account or location, buy anything, or publish a listing.

## Owner setup

Sign in with your password under Settings > Security (or use a direct trusted-network owner session). In Settings > Businesses > Square payments:

1. Choose production or sandbox and enter the token yourself. Prefer PAYMENTS_READ and MERCHANT_PROFILE_READ access. Saving encrypts it with the existing secret store; neither saved plaintext nor ciphertext is returned to the app or workers. Blank input preserves the token; clearing is explicit.
2. Test the saved connection to load locations using GET /v2/locations. Create the Ventures location in Square yourself if it does not exist; ATLAS has no create-location operation.
3. Map distinct locations to Tech Services, Events/Rentals and Ventures. A location cannot be assigned to two businesses or moved to a different business after evidence has been imported.
4. Explicitly enable sync, or run an owner-requested read-only sync. Token/environment changes disable it and clear stale discovery/mappings while retaining historical evidence.

The initial history window is fixed at one year before connection creation and is visible/editable in Settings. It does not move forward with time. Expanding coverage resets the watermark. Narrowing coverage past imported receipts is refused so future refunds on those receipts continue to be observed. Use Revenue's date filters for reporting instead. Earlier history must be selected explicitly; the initial window is not a claim to cover the entire business lifetime.

## Square evidence

The implementation pins Square API version 2026-09-16 and supports only GET /v2/locations and GET /v2/payments at fixed production/sandbox origins, with redirects refused. It stages all pages before one atomic import and advances the watermark only after full success. Incremental requests overlap updates by five minutes and keep the fixed created-at coverage range. Invalid responses, missing pages, repeated cursors, page caps or changed credentials/mappings import no partial batch.

A provider ID plus environment identifies each receipt, preventing repeated sync from duplicating revenue or fees. Older provider updates cannot overwrite newer evidence. Production COMPLETED payments from supported Square-processed types (CARD, BANK_ACCOUNT, WALLET, BUY_NOW_PAY_LATER, SQUARE_ACCOUNT) can be verified. Sandbox, cash, external and unsupported/unknown sources remain unverified. A later noncompleted status invalidates prior verification. Cash/external entries in Square are records, not proof that Square processed their funds.

Net receipts equal payment total less recorded refunds. This is provider-recorded receipts, potentially including taxes and tips, not a complete accounting revenue or tax calculation. Processing fees are separate costs. Missing fees, or unsupported negative aggregate fee adjustments, remain unknown/unverified rather than being invented as a verified zero. Updates preserve owner attribution links. A refund that removes sufficient payment evidence reconciles a paid deal back to won.

The optional background sync runs every 15 minutes after the owner enables it, only while global autonomy is running. Manual owner reads are available independently. Disposable browser runtimes never invoke the background sync. No live Square call was used for implementation verification.

## Pipeline, milestones and attribution

Deals follow lead > qualified > proposal > won > paid, or lost. These are internal records, not email sends or customer-facing actions. Product generated, listing published and order received have separate recorded timestamps; recording one never establishes payment. The UI labels paid only after sufficient same-business/currency verified net receipts are linked. For a zero-value expected deal, positive verified evidence is still required. A complete accounting profit is never inferred from deal stage.

The owner links imported receipts to a deal and/or opportunity. Scope checks prevent cross-business, cross-currency and conflicting project attribution. Matching Square fees are linked with their payment so per-opportunity costs stay consistent. Amounts, source, external IDs and verification cannot be edited through this attribution action. Nullable references preserve financial records when an existing contact, project, task or agent is removed.

## Money, targets and reporting

All money is stored as safe integer minor units, using each currency's exponent (JPY zero, USD two, KWD three). Sums use bounded integer arithmetic and fail closed on overflow. Currencies are never converted or combined. Clients cannot create verified/source-labelled evidence: manual revenue and expense entries always remain unverified, including owner-entered records.

Revenue displays verified net receipts, verified costs, recorded surplus, unverified revenue and unverified costs separately. Surplus subtracts verified costs only; total costs remain incomplete and surplus is not guaranteed profit. Each opportunity has its own attributed currency groups. Date filters apply to ledger evidence; deals remain business-scoped and goals retain their own date windows.

Autonomy can now create currency-aware verified_revenue goals (revenue is an alias). Progress uses only matching business/currency verified net receipts inside the goal window, shown in major units. Profit goals remain unavailable because complete cost evidence is not established. The VP planner sees those distinctions; an artifact, listing or order does not become verified money.

## Spending permissions and worker tools

Spending requests always appear for the owner in Today and Revenue. VPs, API bearer tokens, passwordless local sessions and task tokens cannot decide them. Financial owner mutations also require CSRF protection. Approving records permission only: it does not initiate a purchase, generate an expense or move funds. Duplicate pending task-scoped worker requests are reused rather than flooding Today.

Workers can use finance.read, finance.deals.create/update and finance.request_spend through an active task token. The gateway binds requester/task IDs itself and rejects attempts to forge paid/publication state, edit/import ledger evidence, read Square credentials, sync Square or approve spending. Existing business send, legal, destructive SSH and spending approval floors remain in force. HTTP restrictions do not isolate unrestricted workers from the owner's OS account/filesystem.

## Verification and remaining limits

Existing phase 2-4 work was committed as 7cb0afe before phase 5 began. A consistent pre-phase5 backup is backups/claw-empire.before-phase5-1794848784191.sqlite. Schema/repeat-startup checks on a disposable copy preserve existing counts and business records, with clean integrity and foreign-key checks. New financial records are never seeded and Square remains disabled/unconfigured by default.

Automated Square tests use mocked fetch, and browser fixtures use only the disposable marker-verified database. A real token, location mapping, production sync and reconciliation against the owner's statements remain unverified until owner setup. This phase stays uncommitted for review. Phase 6 publishing is not implemented.

Official API references used: [List payments](https://developer.squareup.com/reference/square/payments/ListPayments), [Payment object](https://developer.squareup.com/reference/square/objects/Payment), [List locations](https://developer.squareup.com/reference/square/locations/list-locations), and [OAuth permission scopes](https://developer.squareup.com/docs/oauth-api/square-permissions).
