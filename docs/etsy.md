# Etsy and the Ventures money loop

How the first income stream (Ventures Etsy digital products) runs, and what the owner sets up once. Built 2026-11-18. The Etsy connection was built from Etsy's own API specification but has not been tested against live Etsy yet, because the developer app is not approved. Verify it the day the key arrives.

## Owner setup (once)

1. **Etsy shop.** Create or confirm the Ventures shop on Etsy (shop name, billing, payout account).
2. **Developer app.** At etsy.com/developers, create an app. Etsy reviews it; until then nothing below works.
   - Register a redirect address. It must be **https** and match exactly. Suggested: `https://localhost/atlas-etsy`. That address does not need to load; ATLAS reads the code from it.
   - ATLAS asks for these permissions: `listings_r listings_w shops_r transactions_r`.
3. **In ATLAS: Settings > Businesses > Etsy.**
   - Enter the app's keystring, shared secret and the same redirect address, then **Save app details**.
   - Press **Connect**, approve on Etsy, then copy the whole address the browser lands on (it shows an error page) and paste it under **Finish connecting**. It must be done within 15 minutes of pressing Connect.
   - **Test** should show the shop name.
4. **Listing fees.** Each published Etsy listing costs USD 0.20. Set a monthly listing-fee budget on the Ventures listings panel so the VPs can approve listings within it; without one, every listing waits for you.
5. **Images.** The free mockup renderer works as soon as Chrome or Edge is installed. AI images stay off until you set a service and a monthly cap in Settings > Businesses > Image studio.
6. **Costs.** Add your monthly costs (AI subscriptions) on Revenue > Profit, then tick "My monthly costs are complete" so profit goals are measured.
7. **Start.** On Autonomy > Playbooks, pick the Ventures project and **Add weekly research schedule (off)**, then switch the schedule on and set a Ventures goal when you are ready.

## How the loop runs

| Step            | Who                                | What happens                                                                                                                                    |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Research        | Planning (schedule)                | Finds niches with evidence, records each with `opportunity.propose` as an idea                                                                  |
| Pick            | VP planner                         | Scores ideas against the goal; queuing work for one starts its playbook                                                                         |
| Build           | Design                             | Makes the product files in the project folder                                                                                                   |
| Mockups         | Design                             | Makes preview images with `studio.mockup` (and `studio.generate` if enabled)                                                                    |
| Listing         | Planning                           | Builds the Etsy package (`etsy.taxonomy` for the category) and submits it                                                                       |
| Approve         | VPs (within the fee budget) or you | The usual listing approval                                                                                                                      |
| Draft           | ATLAS                              | When Etsy is connected, the approved package is pushed as a private Etsy draft                                                                  |
| Publish         | You, or auto-publish               | Publishing makes it public; Etsy charges the fee                                                                                                |
| Measure         | ATLAS (every 30 minutes)           | Paid orders become verified revenue; fees and refunds become costs; favorites are recorded                                                      |
| Improve or stop | VP planner and stop rules          | Variants (title, price, images, tags) are tried one at a time; opportunities that use their budget, time or task limit with no sale are stopped |

Every step is ordinary autonomy work, so the daily start cap, usage limits, VP approval of each task, the opportunity's budget and the emergency buttons all apply.

## What counts as money

- Revenue: Etsy receipts that are paid (subtotal, so tax and shipping are excluded). Canceled orders count as zero.
- Costs: Etsy payment-account entries that take money out (fees, refunds). Payouts to the bank are transfers and are skipped. Image generation is recorded at the cost per image you set (marked unverified, since it is ATLAS's estimate).
- The listing fee for API-published listings arrives with Etsy's fee records, so it is not recorded twice.
- **To verify once live:** how Etsy labels fee entries (`ledger_type`); the mapping in `classifyLedgerEntry` (`server/modules/etsy.ts`) is a best guess until real entries are seen.

## Files

- `server/modules/etsy.ts`: connection, drafts, publishing, sync.
- `server/modules/studio.ts`, `media-library.ts`: image studio and media library.
- `server/modules/experiments.ts`: budgets, variants, stop rules.
- `server/modules/playbooks.ts`: the editable playbook and its steps.
- `server/modules/profit.ts`: monthly costs and profit.
