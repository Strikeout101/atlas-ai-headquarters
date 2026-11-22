# Etsy and the Ventures money loop

How the first income stream (Ventures Etsy digital products) runs, and what the owner sets up once. Built 2026-11-18. The Etsy connection was built from Etsy's own API specification but has not been tested against live Etsy yet, because the developer app is not approved. Verify it the day the key arrives.

## Owner setup (once)

1. **Etsy shop.** Create or confirm the Ventures shop on Etsy (shop name, billing, payout account).
2. **Developer app.** At etsy.com/developers, create an app. Etsy reviews it; until then nothing below works.
   - Register a redirect address. It must be **https** and match exactly. Suggested: `https://localhost/atlas-etsy`. That address does not need to load; ATLAS reads the code from it.
   - ATLAS asks for these permissions: `listings_r listings_w shops_r shops_w transactions_r`.
3. **In ATLAS: Settings > Businesses > Etsy.**
   - Enter the app's keystring, shared secret and the same redirect address, then **Save app details**.
   - Press **Connect**, approve on Etsy, then copy the whole address the browser lands on (it shows an error page) and paste it under **Finish connecting**. It must be done within 15 minutes of pressing Connect.
   - **Test** should show the shop name.
4. **Listing fees.** Each published Etsy listing costs USD 0.20. Set a monthly listing-fee budget on the Ventures listings panel so the VPs can approve listings within it; without one, every listing waits for you.
5. **Web search (optional).** Claude and Codex agents search the web with their own built-in search. A key in Settings > Businesses > Web search for agents (Serper gives Google results) only makes ATLAS's own `web.search` reliable, for agents without built-in search.
6. **Images.** Nothing to set up. The free mockup renderer works as soon as Chrome or Edge is installed, and Codex agents make AI images with their own image generation, recorded with `media.register`. The image service in Settings > Businesses > Image studio is optional, for agents that cannot generate images.
7. **Costs.** Add your monthly costs (AI subscriptions) on Revenue > Profit, then tick "My monthly costs are complete" so profit goals are measured.
8. **Start.** Set a Ventures goal (for example 2,000 USD of verified revenue a month) and keep ATLAS running. The work engine runs a research phase for the goal, then asks you to approve the strategy and pick which ideas to build. A weekly research schedule (Autonomy > Playbooks) is optional, for extra idea-finding on top.

## How the loop runs

| Step            | Who                                | What happens                                                                                                                                                         |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research        | Planning (Codex and Claude)        | Five parallel angles (market, competitors, pricing, buyer problems, production effort), each with 10+ dated sources in `research/<angle>.md`                         |
| Strategy        | Planning lead                      | Merges the angles into a plan with the arithmetic (`strategy.save`) and 6 to 10 scored ideas (`initiative.propose`)                                                  |
| Approve         | You                                | Approve the strategy (or ask for a redo with a note), then pick the ideas to build, up to the goal's slots; the VPs set each plan (playbook, daily cap, budget) once |
| Shop setup      | Design (once per shop)             | Brand, banner, story and sections (`etsy.shop_propose`); listing steps wait for it                                                                                   |
| Build           | Design                             | Makes the product files in the initiative's folder; every later step gets the earlier steps' hand-offs                                                               |
| Mockups         | Design                             | Makes preview images with `studio.mockup`, plus its own generated images (`media.register`)                                                                          |
| Listing         | Planning                           | Builds the Etsy package (`etsy.taxonomy` for the category) and submits it                                                                                            |
| Approve         | VPs (within the fee budget) or you | The usual listing approval                                                                                                                                           |
| Draft           | ATLAS                              | When Etsy is connected, the approved package is pushed as a private Etsy draft                                                                                       |
| Publish         | You, or auto-publish               | Publishing makes it public; Etsy charges the fee                                                                                                                     |
| Measure         | ATLAS (every 30 minutes)           | Paid orders become verified revenue; fees and refunds become costs; favorites are recorded                                                                           |
| Improve or stop | VP planner and stop rules          | Variants (title, price, images, tags) are tried one at a time; initiatives that use their budget, time or task limit with no sale are stopped                        |
| Revise          | Planning, then VPs or you          | A change to a live listing is a revision (`listings.revise`), approved like any package, then applied to the same Etsy listing                                       |
| Take down       | ATLAS                              | When an initiative stops, its live Etsy listings are set inactive (never listings you brought in)                                                                    |

Each step is a task the work engine starts on its own (no vote per task), within the daily start cap (research doesn't count), usage limits, the initiative's daily cap and budget, and the emergency buttons. After the listing step the initiative waits at **awaiting publish**. A step that fails is retried by the same agent, then by an agent on the other model, then the VPs decide, and only then you.

## After a listing is live (added 2026-11-21)

- **Revisions.** Agents never edit a live listing directly. `listings.revise` makes a draft copy with the change; it is submitted and approved like any package (no listing fee, so the VPs can approve it, except a price move of more than 50% either way, which goes to you). ATLAS then applies it to the same Etsy listing: title, description and tags through Etsy's listing update, price through the listing's inventory (Etsy's listing update does not take a price), and images or files by uploading the new ones and removing the old ones without ever leaving the listing empty. Experiment variants tied to the revision are measured from that moment. A listing whose price varies by option on Etsy is refused, so its prices are not flattened; change those on Etsy.
- **Stopped initiatives.** Their live Etsy listings are set inactive on the next sync, and a line is written to the autonomy ledger. Restarting the initiative does not reactivate the listing; do that on Etsy. Nothing new is pushed for a stopped initiative.
- **The whole shop.** Every sync reads every listing in the shop (active, inactive, draft, expired, sold out), including ones ATLAS did not create. Settings > Businesses > Etsy > **Show shop listings** lists them. **Bring into ATLAS** turns one into a published package (optionally tied to an initiative), so its sales count there and agents can propose revisions of it. A listing you brought in is never taken down automatically. Agents can read the shop with `etsy.listings`.
- **Changes made on Etsy.** If you edit a listing's title, description, tags or price on Etsy, ATLAS's copy follows it (unless an approved revision is still waiting). An approved draft you publish on Etsy becomes published in ATLAS. A listing deleted on Etsy is marked removed.
- **Request limits.** The app allows 10 requests a second and 10,000 a day (confirmed 2026-11-21). ATLAS spaces its calls at least 125 ms apart (8 a second) and waits when Etsy answers 429. Etsy reports the daily allowance on every call; the Etsy card shows what is left, and background sync pauses when less than 2% (200 requests) remains and resumes as it refills. Your own button presses still go through. A normal sync uses about 7 requests, so 48 syncs a day use about 350.
- **Half-pushed drafts.** If pushing a draft fails part way, pressing it again uploads only the images and files that are still missing.

## The shop itself (added 2026-11-22)

Etsy's API can change the shop title (headline), announcement, sale messages (including the one sent with digital orders), additional policy text and sections. It cannot upload the logo or banner, set the About story, rename the shop or edit FAQs. ATLAS reads the shop on every sync, including whether a logo and banner exist.

- Once a goal has a strategy, a new or unfinished shop gets one **shop setup** task (design team, VP-approved). The agent makes the logo and banner, writes the title, announcement, About story, digital-order message and sections to match the strategy, and proposes it with `etsy.shop_propose`.
- The proposal is approved like a listing (the VPs for Ventures; Today shows it as "Etsy shop setup"). ATLAS then applies the text and sections on Etsy.
- The logo, banner and story appear under Settings > Businesses > Etsy > Shop setup as your part: upload them on Etsy (Shop Manager > Edit shop), then press **Uploaded on Etsy**.
- Applying changes needs the `shops_w` permission: reconnect Etsy once (Connect, approve, paste the address).
- Listing views: every sync records each listing's lifetime views with its favorites, so agents can compare views, favorites and sales per product and per experiment.

## How orders and payment records are read (fixed 2026-11-21)

Etsy refuses a payment-ledger request whose `min_created` to `max_created` span is more than 31 days (2,678,400 seconds). The first sync used to ask for 90 days at once and failed.

- **Windows.** Orders (by last-modified time) and payment-ledger entries (by created time) are read in consecutive windows of at most 30 days, each window starting where the last ended. Every page of each window is read. A window with more than 2,000 records is split in half until it fits, so nothing is cut off.
- **Checkpoints.** After each completed window ATLAS saves how far it got (`receipts_after`, `ledger_after`). The next sync starts one hour before that checkpoint, to catch records Etsy shows a little late, and runs up to now. If a sync fails part way, the next one resumes at the last completed window. A checkpoint never moves back.
- **No duplicates.** Each order and ledger entry is stored under Etsy's own id (`receipt_id`, `entry_id`), so the overlap, window edges and repeated syncs update the same Revenue row instead of adding one.
- **First sync** reads the last 90 days. **Re-read history** on the Etsy card (up to 1,095 days) reads further back on demand, in the same windows, without adding duplicates or moving the checkpoint back.
- Verified live 2026-11-21 (read-only, on a copy of the database): 11 requests, all 200, largest window 30 days; a repeat sync added no rows.

## What counts as money

- Revenue: Etsy receipts that are paid (subtotal, so tax and shipping are excluded). Canceled orders count as zero.
- Costs: Etsy payment-account entries that take money out (fees, refunds). Payouts to the bank are transfers and are skipped. Image generation is recorded at the cost per image you set (marked unverified, since it is ATLAS's estimate).
- The listing fee for API-published listings arrives with Etsy's fee records, so it is not recorded twice.
- **To verify once live:** how Etsy labels fee entries (`ledger_type`); the mapping in `classifyLedgerEntry` (`server/modules/etsy.ts`) is a best guess until real entries are seen. First real entries (2026-11-21): `seller_onboarding_fee` (money out, recorded as a fee) and `seller_onboarding_fee_payment` (money in, skipped, since revenue comes from orders). Listing, transaction and payment-processing fee labels are not seen yet.

## Not confirmed by Etsy's documentation (check on the first live draft)

- **Tags.** Etsy's spec calls tags "a comma-separated list" but types them as an array. ATLAS sends the comma form, reads back what Etsy saved, and if any tag is missing sends each tag as its own field and checks again. A listing where neither works fails with `etsy_tags_not_saved`.
- **Image alt text** is sent as `alt_text` with each image (title plus "image N of M").
- **Inventory price units.** Etsy's examples send the price as a decimal (5.00), which ATLAS does; one sentence in its tutorial mentions pennies.
- **Webhooks** (order paid, listing updated) exist but need a public https address registered in Etsy's developer portal. ATLAS polls every 30 minutes instead.
- **Not in Etsy's API at all:** customer messages and shop statistics (visits, views).

## Files

- `server/modules/etsy.ts`: connection, drafts, publishing, sync.
- `server/modules/studio.ts`, `media-library.ts`: image studio and media library.
- `server/modules/experiments.ts`: budgets, variants, stop rules.
- `server/modules/playbooks.ts`: the editable playbook and its steps.
- `server/modules/profit.ts`: monthly costs and profit.
