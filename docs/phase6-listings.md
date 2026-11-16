# Phase 6: storefront listing packages (Etsy, itch.io)

Agents prepare complete listing packages. ATLAS publishes nothing itself in this phase: an approved package is published by the owner from a checklist, and the owner records the live address. Storefront API publishing can later replace only that last manual step.

## Flow

1. A worker creates a draft with `listings.create` (title, description, up to 13 tags, price, files, mockups, notes), edits it with `listings.update`, and requests approval with `listings.submit`. A draft needs a description, a price above zero and at least one file. Submitted packages are frozen, so what was reviewed is what gets published.
2. The package appears as "Listing to publish" in the approval queue.
3. Once approved it shows under Ventures > Listings > Ready to publish, with copy buttons for each field. The owner publishes it on the platform, pastes the `https://` listing address and presses Mark published.
4. Marking published records the platform fee as a manual, unverified expense in Revenue. No income is ever inferred from a listing.

Files and mockups are path names inside the project. ATLAS never reads, serves or uploads them, and paths that leave the project are refused.

## Who approves

- Tech Services and Events/Rentals listings always go to the owner.
- Ventures listings can be approved by the two VPs, except when the platform fee does not fit the monthly listing-fee budget. Then the package goes to the owner.
- Etsy charges USD 0.20 per listing; itch.io is free. The fee is fixed by the server from the platform; a worker cannot set or change it.
- The budget defaults to 0, so every paid listing needs the owner until a budget is set in Ventures > Listings. It is a monthly allowance (America/New_York calendar month) counted over approved and published listings; withdrawing an approved package frees its share.
- The budget is re-checked in the same transaction that records a VP approval, and the VP review is bound to the exact package content.
- Product copy is not scanned for words like "buy" or "payment" when routing a listing: those describe the product. The only spend a listing causes is the platform fee, which the server computes.

## Limits

- Only the signed-in owner (password session, CSRF) can set the budget, decide from the app, mark published or withdraw. Workers cannot approve, publish, change the budget, set protected fields or touch another worker's package.
- A package stays "approved" until the owner records the live address; ATLAS does not check the platform.
- No Etsy or itch.io credentials are stored and no storefront API is called. Etsy API publishing needs an Etsy-approved developer app; itch.io uploads need the butler tool and an API key. Both are follow-ups.
- Listing content quality, originality and platform rules are judged by the reviewing VPs or the owner; nothing checks them automatically.

## Verification

Server suite (listing lifecycle, routing, budget, publishing, owner routes, worker tools), panel and Today-row tests, and a browser spec in the isolated runtime. No real listing was created and no model call was made. A consistent backup was taken before the schema was added: `backups/claw-empire.before-phase6-2026-11-16.sqlite`.
