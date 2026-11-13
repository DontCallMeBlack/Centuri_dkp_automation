# Fluid Active CPU optimization — 8 November 2026

The optimization code is complete and live. The requested **4–5 CPU minutes per day has not been verified**. Moving from the reported 14 minutes to that range requires approximately 64–71% less total CPU under comparable traffic; individual benchmarks cannot establish that result.

## Production state

- First optimization deployment: commit `c689fdfe7c2cde0e4df2e1923618af47638e2f81` (`performance update`), deployed by the user while this session was interrupted, deployment `dpl_BEggoiiKpcQBrasKPx9RcHePDkdU`.
- Final production deployment: **`dpl_7i4VfWu2MPZhj3ZsgPmFxFyQhsjK`**, READY and aliased on 8 November at approximately **15:02 UTC**. This includes the additional lightweight Sheet read transport and two-minute display cache. These follow-up changes remain uncommitted locally.
- Production alias: https://centuri-dkp-automation.vercel.app.
- Read-only production smoke: login returned 200; session, live auction and image requests without a session returned 401.
- No live bids, DKP adjustments, item edits, or load tests were performed for this optimization.

## Implemented changes

| Area | Change | Expected source of savings |
| --- | --- | --- |
| Auction/catalog images | Added stable image revisions to metadata, URLs, new uploads, replacements, and archived snapshots. Matching revision URLs use private, one-year immutable browser caching. Legacy unversioned clients retain their short cache. | Repeat visits and reloads can avoid the image function entirely. |
| Image origin requests | Added a bounded cache of exact image revisions: 16 MB, 256 entries, ten-minute expiry. Session authorization still runs before every origin cache lookup. | Avoid repeated image reads, BSON decoding, byte copying and hashing. |
| Image replacement | New bytes get a new UUID revision; archived auction images retain their prior revision. Uncached stale versions return a no-store 404. | Long browser caching remains compatible with catalog edits and auction history. |
| Live auction GET | Deferred full-view and mutation-only models/helpers until their request paths need them. | Unchanged live polls avoid unnecessary module initialization. |
| Auction expiry | Targeted reads probe for globally due work before importing the worker. Eligibility checks share worker retry/lease rules. | Skip idle worker startup during active leases, retry delays and manual review. |
| Settlement | Load the Sheet mutation module only when a winning bid actually needs charging. | Idle and no-bid sweeps avoid the financial SDK/code dependency graph. |
| Auction metadata | Query listed catalog items plus item IDs referenced by displayed auctions. | Old archived snapshots no longer increase every initial catalog metadata read. |
| Roster display reads | Extracted a lightweight snapshot reader; load mutation and SDK code only after a refresh lease is acquired. Project only display fields rather than financial journals and activity history. | Reduce cold initialization and BSON decoding for cached roster reads. |
| External roster refreshes | Extracted [googleSheetsRead.ts](../lib/googleSheetsRead.ts) so even a stale display refresh avoids financial models. Reuse the shared display snapshot for up to two minutes instead of 30 seconds. App mutations still invalidate it; explicit fresh reads and financial locks bypass it. | At continuous read traffic, external refreshes can fall from about 120 to about 30 per hour. Exact calls depend on traffic and invalidations; this is not a measured CPU reduction. |
| Google Sheets SDK | Initialize the Sheets-only SDK lazily at actual external I/O. | Cached display responses avoid SDK initialization. |
| DKP/toon account links | Added a per-request indexed resolver preserving normalized identities, stale-row fallback, duplicate handling, account order and access boundaries. | Replace repeated full-roster identity scans. |
| Catalog metadata | Load the native image processor only for a valid upload. | Ordinary catalog reads avoid native image-processing startup. |

Main implementation references: [auction route](../app/api/auction/route.ts), [image route](../app/api/auction/image/route.ts), [snapshot reader](../lib/sheetRosterSnapshot.ts), [link resolver](../lib/sheetRecordLinks.ts), [expiry eligibility](../lib/auctionExpiryWork.ts), [settlement worker](../lib/auctionSettlementWorker.ts).

## Whole-app audit decisions

- Auction discovery already runs hourly. Final-window checks run once per minute only for relevant auctions; hidden/offline views skip work. Slowing these further was not the strongest lead and would change freshness.
- Roster, catalog, history and administration panels already use manual/local-mutation refreshes. The generic auto-refresh hook is unused. Session checks are event-driven and throttled.
- MongoDB connections are reused. Hosting cron owns the two daily jobs. App startup initializes no financial background scheduler.
- Bid validation, current permissions, DKP locks, reservation binding, idempotent settlement and financial recovery were preserved.
- An edit made directly in Google Sheets can take up to two minutes to appear in an ordinary cached display. In-app writes invalidate the shared snapshot, and financial actions still validate against a fresh ledger.
- Strict CSP uses per-request nonces and dynamic HTML. Removing that requirement to make pages static needs a separately validated CSP design; it was not weakened for this optimization.

## Measured evidence

These are local, isolated measurements, not Vercel daily totals.

### Browser image requests

The local fixture wraps the real image GET handler with in-memory auth/storage boundaries. There is no Playwright request interception in the cache experiment.

- Initial versioned image: one origin request, one authorization check and one item read.
- Navigate away, return to the same image, and reload: no additional origin image requests.
- Replace the fixture image: the new revision URL requested and displayed new bytes.
- Legacy control: three visits produced three origin requests, including two conditional 304s. Only the fixture shortened the legacy TTL from 60 seconds to one second to make the experiment quick.
- A new uncached image request without an approved session returned 401.
- Previously downloaded images can remain visible in that browser after a cookie change or sign-out. Private browser caching does not erase downloaded content. Every new origin request still requires current authorization; Vary Cookie must not be described as guaranteed Chromium memory-cache invalidation.

Reproduce using [the localhost browser fixture](../scripts/image-cache-browser-smoke.mjs). Its replacement/session controls change only in-memory test data.

### CPU microbenchmarks

- Roster links, 750 toons / 250 accounts: modern links approximately **32.0 → 0.30 ms** CPU per complete link-resolution pass; legacy owner links **3.75 → 0.094 ms**; mixed links **24.2 → 0.45 ms**. Outputs were compared with the prior implementation. This measures the resolver, not an entire endpoint.
- Cold roster display module import, five fresh Node processes per variant: approximately **863 → 500 ms** mean process CPU. The old module loaded the Google SDK; the new snapshot module did not. Other runs were noisy. Node TypeScript loading and local startup differ from bundled Vercel execution.
- Cold auction route import: approximately **803 → 643 ms** mean process CPU across five processes per variant, also noisy.
- Cold settlement worker import: approximately **856 → 484 ms** mean process CPU across five processes per variant, also noisy.

Reproduce the roster benchmarks with [benchmark-roster-links.mjs](../scripts/benchmark-roster-links.mjs) and [server-cpu-benchmark.mjs](../scripts/server-cpu-benchmark.mjs). Pass baseline ref `8e7d9f231c3d97d1ffe024bdfaa374934694db17` to the server benchmark; HEAD now contains the optimization.

## Validation

- Full final suite: **360 tests passed**. The earlier 354-test suite also passed against the first deployed commit.
- Type checking: passed for both optimization stages.
- Final local production build and Vercel production build: passed.
- Independent review: no new runtime, accounting, authorization or revision-cache blockers found; 41 focused tests passed separately.
- Regression coverage includes hydrated outbid reservations, rollback, stale row identities, image archival/replacements, cache bounds/auth, retry leases, snapshot concurrency, forced fresh reads, preview restrictions and generation fencing.
- Production-build browser smoke: passed with 1,000 roster records, 100 ms network latency, 250 ms fixture API latency, and 4x CPU throttling. Verified roster, auction house, history, catalog, role changes, administration, search, browser history, mobile navigation, signup view and auction expiry; no uncaught browser errors. All API requests used intercepted fixtures.
- Fixed the smoke script's obsolete assertion for a removed LIVE badge; it now checks the active card/countdown and transition to FINALIZING. This was a test-script issue, not an application expiry failure.

## Remaining measurement

The user signed in and the native Vercel dashboard became accessible. The custom CPU analytics API remains unavailable on this plan: Vercel rejected that query with **402: Observability Plus required**. No upgrade was purchased.

### Live observation before the final follow-up deployment

At approximately 15:00 UTC, the production route table for Last hour showed these rounded cumulative CPU values. This window ran the first optimization deployment, before the final lightweight-source/two-minute-cache follow-up:

| Route | Invocations | Active CPU |
| --- | ---: | ---: |
| /api/auction | 65 | 8 s |
| /api/auth | 8 | 2.77 s |
| /api/dkp | 10 | 2.03 s |
| /api/auth/session | 38 | 1.43 s |
| /dashboard | 45 | 1.14 s |
| /api/auction/image | 59 | 1.03 s |
| / | 31 | 0.94 s |
| /api/auction/items | 32 | 0.78 s |
| /login | 21 | 0.61 s |
| /api/admin/boss-history | 2 | 0.23 s |
| /_not-found | 16 | 0.20 s |
| /admin/role-changes | 3 | 0.075 s |
| /admin/requests | 2 | 0.05 s |

The route values sum to approximately **19.3 seconds in that displayed hour**, equivalent to about **7.7 minutes per day only if the identical hourly workload continued for 24 hours**. This is neither a daily measurement nor a matched before/after comparison. The live chart and route table refresh independently; chart totals were not combined with the route table. Auction reads remained the largest contributor, which motivated the last follow-up.

At approximately 15:08 UTC, the final deployment's Last 5 min route table summed to about **4.8 seconds** across a small number of requests, including the production health checks. Session and auction reads accounted for most of that short sample. This does **not** demonstrate the 4–5-minute daily target, and it is too short to assess steady traffic or attribute a regression; first-use module initialization can affect a new deployment. The next required measurement is a complete, representative post-deployment day. Further speculative changes were not used to claim an unmeasured target.

### Later observation and clan capacity

At approximately **19:06 UTC**, the refreshed production Last hour table listed 112 invocations across its rows and about **11.56 seconds** of Active CPU. The largest were session reads (31 / 3.98 s), auction reads (12 / 2.41 s), authentication (3 / 1.53 s), and images (24 / 1.05 s). Other displayed routes together accounted for the remaining 2.59 s. The linear equivalent is approximately **4.6 CPU minutes per day if that identical workload persisted**.

This was a quieter workload than the earlier hour (112 versus 332 listed invocations). It cannot establish the percentage saved by the code or show that a crowded auction will stay within the same budget. Normal per-user reads still grow with activity.

Remaining scaling opportunities, not implemented as part of this later inspection:

- Coalesce concurrent reads of common auction versions/catalog metadata within an instance; continue fresh per-request authorization and user-specific serialization. Avoid retaining permission results or using display caches during bids.
- Cache completed-week display totals with explicit invalidation for award edits, resets and owner/lifecycle changes. Financial calculations must bypass display caches.
- Reduce duplicate UI-only session checks or reuse identity from a fresh authorized response. API authorization must remain current; a longer UI refresh interval would delay sidebar/role display changes.
- Consider push notifications on actual auction mutations for a busy clan, with authenticated subscriptions, shared state across instances and reconnect recovery. Native Vercel WebSockets are now supported; CPU, connection memory, and shared-message infrastructure must be measured together rather than assuming this is free. See [official WebSocket documentation](https://vercel.com/docs/functions/websockets).

The [previous report](./performance-and-auction-cards-20261107.md) recorded rounded all-environment figures of about two CPU minutes for auction images and two for auctions over twelve hours. Those historical figures identify contributors; they are not a matched baseline for today's deployment.

For confirmation, compare a complete post-deployment day of normal traffic with a comparable earlier day in [Vercel CPU usage](https://vercel.com/dcmbs-projects/~/usage/vercel-functions-fluid-cpu-duration?view=Projects), with the project and production environment selected. Inspect [function usage by route](https://vercel.com/dcmbs-projects/centuri-dkp-automation/observability/vercel-functions?environment=production) for remaining contributors. Compare invocation counts alongside CPU totals; exclude deliberate testing and deployment warmups. Continue profiling the measured remaining contributors if total CPU stays above the requested range.

Vercel defines Active CPU as actual code execution; waiting for remote I/O is a different metric. Lower endpoint latency alone does not prove lower CPU billing. See [Vercel's Fluid compute pricing documentation](https://vercel.com/docs/functions/usage-and-pricing).
