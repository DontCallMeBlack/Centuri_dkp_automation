# Centuri architecture

Application structure, accounting rules, and operational guidance. Last reviewed 8 November 2026.

## App map

- Single-clan Celtic Heroes DKP and loot-auction app. There is no guild/tenant discriminator.
- Next.js 16.3.8 App Router, React 19.3, TypeScript 7.0.2, Mongoose 9.10.4, Google Sheets, Vercel. Version-matched framework documentation is available in `node_modules/next/dist/docs/`.
- [Dashboard](./app/dashboard/page.tsx) provides DKP, auction, item catalog, boss history, and clan-toon panels. Visited panels stay mounted to preserve drafts. [AppShell](./components/AppShell.tsx) uses the lightweight session endpoint.
- [Authentication](./app/api/auth/route.ts), [session reads](./app/api/auth/session/route.ts), and [session implementation](./lib/auth/session.ts) use approved users and seven-day opaque tokens. Only token hashes are stored in MongoDB; legacy JWTs are invalid.
- Roles are chief, general, guardian, and clansman. Chief/general manage clan accounts and toons; chief/general/guardian can manage the catalog, post auctions, and award boss DKP. Check individual action permissions instead of assuming a role grants every management action.
- [Clan accounts](./app/api/admin/requests/route.ts), [clan toons](./app/api/admin/toons/route.ts), [boss history](./app/api/admin/boss-history/route.ts), and [role changes](./app/api/role-changes/route.ts) have separate authorization and audit paths.

## Identity and accounting

- [Google Sheets integration](./lib/googleSheets.ts) reads roster tab `DKP_Sheet_automated`, rows 3-1000. Columns A-I are owner, toon/account, subclass, weekly earned, weekly spent, lifetime earned, lifetime spent, available, and five-week activity.
- Stable toon identity is [getSheetRecordKey](./lib/sheetRecordLinks.ts): JSON of trimmed, lowercase owner/account. `rowIndex` is a physical location and cannot establish identity by itself. Links also support legacy owner-name fallback.
- [Roster parsing](./lib/sheetRoster.ts) preserves invalid/missing numeric cells as issues instead of silently treating them as zero. Bid validation requires valid weekly-spent, spent, and available values.
- Boss awards update the current week and activity. Sunday rollover in America/New_York moves weekly earnings into lifetime earned/available and resets weekly earned/spent; see [cycle rules](./lib/dkpCycle.ts).
- Auction weekly activity uses the previous completed week's recorded boss participation, lifecycle/reset cutoffs, and [weekly calculation](./lib/dkpWeeklyEarned.ts), rather than today's Sheet weekly-earned cell. The current [minimum](./lib/auctionRules.ts) is 0.
- The SheetRosterCache ledger lease serializes financial writes, bid reservations, resets, and roster changes. [DkpSheetMutation](./lib/models/DkpSheetMutation.ts) journals exact before/after identities and values for safe replay. Ambiguous external edits must fail for review.
- [Clan administration transactions](./lib/auth/administration.ts) use a shared revision fence to prevent role/link/bid races. Pending roster mutations block ordinary transactions until recovery through Clan toons.
- Owner transfers, roster compaction, and restores must preserve/remap audit and lifecycle identities. Removing links or changing toons is blocked when unresolved reservations or undelivered wins exist; deliberate DKP wipes/transfers withdraw bids and can promote eligible history through [withdrawal logic](./lib/auctionBidWithdrawal.ts).

## Auction flow

- [AuctionHousePanel](./components/AuctionHousePanel.tsx) sends actions to [the auction route](./app/api/auction/route.ts): create-auction, bid, close-auction, remove-auction, resolve-no-bid, retry-settlement, and mark-delivered. Catalog/images have separate routes.
- Bid sequence: fresh Sheet ledger lock, clan transaction, fresh approved actor and active auction, higher amount, linked toon, weekly eligibility, effective role, valid/unique roster identity, and affordability; then transfer reservations, append history, update highBid/end time/version, and commit.
- [AuctionHold](./lib/models/AuctionHold.ts) aggregates a toon's leading bids across active, removing, settling, and settlement-failed auctions. [Hold binding](./lib/auctionHold.ts) proves reservation identity before modifying balances.
- Bidding reserves DKP without spending it in Sheets. An outbid releases only the old leading amount and reserves the new amount, retaining each toon's unrelated holds. A same-toon raise reserves only the increase. All changes roll back together if the replacement is rejected.
- Current [rules](./lib/auctionRules.ts): 24-hour auction, positive whole-number bids strictly above the current high, one or two required subroles or Everyone. Bids in the final five minutes reset the end to five minutes after the bid. Catalog Base/Prime boss values normalize to Prot.
- [Settlement worker](./lib/auctionSettlementWorker.ts) uses leases and the idempotent `auction-settlement:<auctionId>` Sheet journal. It records the charge before atomically releasing the hold and setting the winning auction to completed/pending delivery. Never retry an ambiguous legacy charge without proof, double-charge, or release an unresolved reservation.
- Initial auction reads include active work and outstanding follow-up, while history loads 20 rows per explicit page. Live polls use compact version checks and load details only for changed auctions. A change to the current user's leading bid triggers a balance refresh.

## Verified outbid failure and fix

The 8 November defect rejected replacement bids with HTTP 409 and the message about an inconsistent or moved auction reservation. First bids and same-toon raises worked. The old bidder's `currentAuction.highBid` was a hydrated Mongoose subdocument; `{ ...identity, rowIndex }` copied Mongoose internals but dropped owner/account, causing the hold binder to reject the old reservation and roll back the transaction.

The route now passes `{ rowIndex: holdRow, owner: identity.owner, account: identity.account }` explicitly. Keep the identity checks and financial locks intact. [Bid serialization](./lib/auctionSecurity.ts) already uses explicit fields for the same reason.

[Outbid regression tests](./tests/auction-outbid.test.mjs) execute the real POST handler, real hydrated Auction/AuctionHold schemas, and the real hold validator with isolated persistence/Sheet fixtures. They cover cross-user and repeated outbids, unrelated reservations, history, legacy holds, rollback on insufficient funds, first bids, same-toon raises, removed old toons, and closed auctions. Replaying the old spread expression failed the outbid cases with the same 409. Pure accounting tests and plain-object mocks alone cannot detect this defect.

## Live removal refresh corrections

The follow-up auction review found two client issues: a removed leading auction did not refresh personal held DKP, and truncating version tokens to the newest 100 auctions left older deleted cards untracked. [Live update helpers](./lib/client/auctionLiveUpdates.ts) now check personal removals as well as changed bids and send every scoped auction in batches of at most 100 versions/IDs. Discovery remains one unscoped request plus targeted overflow batches; normal small polls remain one request. Failed batches reject the whole poll, and removal wins if discovery and a targeted read race.

[Client regressions](./tests/auction-live-updates.test.mjs) exercise request bounds, overflow deletion, deduplication, failures, personal balance changes, and the actual component polling callback. [Route read regressions](./tests/auction-display-reads.test.mjs) also run the batched client against the real GET handler with isolated storage fixtures and confirm deletion reconciliation across 205 loaded auctions without rebuilding Sheet balances.

## Operations and validation

- Production: https://centuri-dkp-automation.vercel.app; linked Vercel project `dcmbs-projects/centuri-dkp-automation`.
- Preview deployments deliberately reject Mongo and Sheet access. `DKP_WRITES_PAUSED=true` pauses financial mutations; never remove these protections to make a preview work.
- [Cron configuration](./vercel.json): DKP at 05:00 UTC and auctions at 05:05 UTC, requiring Bearer CRON_SECRET. [Instrumentation](./instrumentation.ts) deliberately starts no background scheduler. Auction reads use bounded Next `after()` expiry recovery.
- Mutations require the configured same origin, bounded JSON/form input, and request rate limits. Keep secrets and request bodies out of logs and project notes.
- Useful Vercel CLI commands: `vercel list --environment production`, `vercel logs --environment production --no-branch --since 24h --status-code 409 --expand`, and `vercel inspect <deployment-url>`.
- Expected validation failures use handled 4xx responses without console stacks. Check HTTP status codes as well as error-level runtime logs when investigating rejected bids; request logs do not include response bodies.
- Verify behavioral changes with `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`. Browser smoke scripts in [scripts](./scripts) use intercepted fixtures; never run uncontrolled financial writes against live player auctions for testing.
- [Website requirements](./WEBSITE_REQUIREMENTS.md) and [past reports](./artifacts) provide background, but dated constants or deployment statements may drift; prefer current code.
