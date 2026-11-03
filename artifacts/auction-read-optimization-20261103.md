# Auction read optimization and production load test — 3 November 2026

## Outcome

Deployed to https://centuri-dkp-automation.vercel.app.
Final deployment: dpl_2c9Z1JVmWbKPqWbEeqrjkRuPbtt1.
Previous deployment used for the baseline: dpl_D6rL2rx183V4FYNK8mSKYu5CRvxg.

Full auction responses were 43.2% smaller and median full-load latency was 19.9% lower in the bounded comparison. The measured active CPU **did not decrease**: 2.895 seconds before versus 3.536 seconds after, approximately 22.1% higher for the same 61 requests. This small, one-pass experiment does not establish a CPU improvement or a reliable regression: deployment startup, instance allocation and request concurrency affect results. It does not justify claiming a large saving on the four-hour CPU allowance.

## Implementation

- Initial auction reads select active/removing/settling/failed-settlement records and outstanding delivery/no-bid tasks, rather than repeatedly loading recent closed auctions and multiple overlapping winner queries.
- Closed history and personal wins load only when requested, 50 records per cursor page. Those requests do not rebuild the roster, DKP balances, eligibility, reservations or full posting catalog.
- Live reads select outstanding work plus the caller's known IDs, preserving completion, delivery and deletion updates without scanning the most recent 100 closed records.
- Live responses serialize only changed auctions. No-change responses remain small.
- Browsing history once no longer makes subsequent live-view full refreshes reload every previously visited history page.
- Bid validation, permissions, financial writes, settlement and the daily jobs retain server authority. Pending work remains visible.
- The live empty state now distinguishes no live auctions from no historical records. Personal wins do not display an authoritative zero before loading.

Relevant files: [auction route](../app/api/auction/route.ts), [read scope](../lib/auctionReadScope.ts), [auction panel](../components/AuctionHousePanel.tsx), [read regression tests](../tests/auction-display-reads.test.mjs).

## Workload and limits

Each phase used one authenticated account and five concurrent browser fetch workers:
one full-load seed, 30 full GET requests, then 30 no-change live polls.
Each request had a 20-second timeout and non-success responses stopped the test.
A separate request warmed the new deployment before the after measurement.
Requests used the existing production account without exporting its session token.

Baseline: 2026-11-03T13:55:39.719Z to 2026-11-03T13:55:54.077Z.
After: 2026-11-03T14:08:26.934Z to 2026-11-03T14:08:39.553Z.

The production dataset contained **two completed auctions, four catalog items, and no live auctions**.
The optimized initial response contained zero auction records; history returned both completed records when opened.
This validates the empty-live/closed-history workload, not a busy multi-user auction or a large archive.
No auction, bid, delivery or DKP POST operations were used. Normal GET requests can schedule the existing expiry sweep and update read-rate counters.

## Browser measurements

| Metric | Before | After |
| --- | ---: | ---: |
| Full-load requests | 30 | 30 |
| Full-load median | 621.0 ms | 497.4 ms |
| Full-load p95 | 6427.0 ms | 4993.7 ms |
| Full-load mean | 1495.9 ms | 1188.1 ms |
| Full-load uncompressed JSON | 2962 bytes | 1681 bytes |
| Live-check requests | 30 | 30 |
| Live-check median | 322.4 ms | 311.2 ms |
| Live-check p95 | 2287.4 ms | 381.0 ms |
| No-change live JSON | 17 bytes | 17 bytes |
| Failed test requests | 0 | 0 |

Latency includes network and database waits and is **not CPU time**. These are individual runs, not repeated statistical benchmarks.

## Vercel CPU observations

Read through the signed-in, standard Functions Observability dashboard; direct custom API queries were rejected on Hobby. The dashboard's native route summary supplied cumulative invocation and CPU values.

| Snapshot for /api/auction | Invocations | Active CPU |
| --- | ---: | ---: |
| Before baseline batch | 3 | 1,650 ms |
| After baseline batch | 64 | 4,545 ms |
| Before optimized batch, after warmup and smoke checks | 68 | 7,335 ms |
| After optimized batch | 129 | 10,870.769 ms |

Baseline delta: 61 invocations, 2,895 ms CPU (47.46 ms per invocation).
Optimized delta: 61 invocations, 3,535.769 ms CPU (57.96 ms per invocation).
Both batches have the same request count and mix. The cumulative totals include warmup/smoke work, which is excluded through subtraction. The snapshots used different preset time ranges, all covering the same relevant auction activity since 13:45 UTC; invocation deltas match the test batches exactly. The CPU figures include the platform's attribution of shared concurrent work and are not per-process profiling.

The small sample and different deployment/instance startup states prevent attributing the difference solely to the code. The CPU result is inconclusive for longer-term savings and does not support a large CPU-reduction claim.

## Validation

- Full suite: 225 passing tests.
- Type checking: passed.
- Local production build and final Vercel production build: passed.
- Whitespace/diff checks: passed.
- New route tests cover preserved settlement/delivery/no-bid workflows, more than 100 active records, history paging without duplicates, account-scoped wins, changed-only polling, delivery transitions, deletion, unauthenticated access and invalid cursors.
- Production browser smoke: initial live data loaded without history; requesting history returned two closed auctions without roster/balance payloads; requesting personal wins returned the current account's result.
- An older shared browser tab stayed on its loading screen; a fresh tab loaded normally and passed the smoke checks. One navigation in the older context also reported offline networking.

## Next step

Retain the history separation to avoid archive-related growth in repeated reads. For a larger CPU reduction, profile and optimize repeated shared roster/eligibility calculations and session/SDK startup separately, then use matched warmed deployments and representative live-auction data. Do not extrapolate this empty-live test to full clan capacity.

