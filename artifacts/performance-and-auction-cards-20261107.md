# Auction cards and performance review — 7 November 2026

Changes are local and have not been deployed. Existing bidding, DKP, permissions, settlement, response formats, cache lifetimes and polling schedules are preserved.

## Changes

- Auction images now fill their frame without the 256px mobile cap or surrounding horizontal padding. Images remain square and use `contain` so item screenshots remain fully visible. Cards have refined borders, headers, shadows and detail spacing. Image controls and action handlers are preserved.
- [Weekly DKP calculation](../lib/weeklyDkpEarned.ts) indexes normalized roster identities once instead of scanning and normalizing every roster record for every award participant. Matching, duplicate identities, row preference, per-award deduplication and result order remain equivalent. An empty-awards fast path avoids building an unused index.
- [Admin toon reads](../app/api/admin/toons/route.ts) resolve each approved account's roster links once per request and collect names by row. Existing identity resolution, account order, permissions and fresh reads are retained. Mutation code is untouched.
- [Settlement retry refresh](../components/AuctionHousePanel.tsx) invalidates dependent data before starting its refresh. Both existing refresh consumers can now share one fresh request. The previous ordering started two concurrent requests, and the invalidated first request could retry again when completed.

## Current Vercel usage

Read through the signed-in Vercel dashboard around 18:46–18:50 UTC on 7 November. These are existing deployed usage figures, not a measurement of this change.

| Dashboard scope | Displayed period | Metric | Value |
| --- | --- | --- | --- |
| Centuri project | Last 30 Days, Oct 8, 11am–Nov 7, 11am as displayed | Fluid Active CPU | 1h 28m |
| Entire team | Same 30-day overview | Fluid Active CPU / allowance | 1h 29m / 4h, approximately 37.5% |
| Centuri project | Same 30-day usage period | Fast Data Transfer | 527.62 MB |
| Entire team | Same 30-day overview | Fast Origin Transfer | 439.18 MB |
| Centuri Functions, all environments | Last 12 hours | Invocations | 5.4K |
| Centuri Functions, all environments | Last 12 hours | Active CPU P75 | 134ms |

The recent all-environment function summary listed approximately 2m CPU for `/api/auction` (840 invocations), 2m for `/api/auction/image` (3K), 32s for `/api/auth/session` (426), and 26s for `/api/dkp` (149). These rounded, changing dashboard figures identify contributors; they do not establish savings from the local changes. The route detail duration chart was explicitly labelled **Demo Data** and was excluded from the measurements.

The historical all-environment auction summary also displayed errors, with different percentages in its table and detail panel. Their cause and deployment attribution were not established. They are not evidence of a regression introduced by these undeployed changes.

[Fluid CPU usage](https://vercel.com/dcmbs-projects/~/usage/vercel-functions-fluid-cpu-duration?view=Projects) · [Function observability](https://vercel.com/dcmbs-projects/centuri-dkp-automation/observability/vercel-functions?environment=all) · [Data transfer](https://vercel.com/dcmbs-projects/~/usage/networking-fast-data-transfer?view=Projects)

## Verified local savings

- A synthetic weekly calculation with 200 roster records, 50 awards and 200 participants per award produced identical results. Average elapsed time was approximately **521ms before → 2.4ms after**; process CPU was approximately **505ms → 2.2ms**. The old implementation used three measured calls and the new implementation used 100. This is a pure-function microbenchmark, not a Vercel or endpoint benchmark, and its ratio must not be extrapolated to total application CPU.
- Executing the actual settlement retry handler with the real browser cache module and stubbed transport showed **two concurrent refresh GETs before → one after**. Existing notifications and both refresh consumers still run. Failed retries still surface the error without announcing a successful mutation.
- Admin read tests verify one account-link resolution per approved user, independent of the number of roster rows, with JSON output equivalent to the original calculation.

## Network review

The app already has gzip compression, lazy image requests, compressed WebP uploads, private authenticated image caching with ETags, request deduplication, changed-only live auction responses, and visibility/offline-aware polling. Additional cache lifetimes or slower polling would change freshness. Those settings were retained. Authenticated auction images were kept on the existing image route; the installed Next.js image documentation says its default optimizer does not forward authentication headers.

## Validation

- Full suite: **270 tests passed**.
- Type checking, production build and `git diff --check`: passed.
- Differential weekly calculation tests compare 150 deterministic mixed histories with the original algorithm, plus explicit matching and accounting edge cases.
- Admin read tests cover legacy links, stale row references, duplicate identities, permissions, account order, pending-operation shape and fresh subsequent reads.
- Production-build browser checks used intercepted fixture APIs, with no live API mutations. Widths: **320, 390, 639, 640, 768 and 1440px**. Images stayed square, filled their visual frames, aligned to the card edge and produced no horizontal page overflow.
- Browser checks passed for image navigation, bid limits, search reset, posting dialog, completed delivery text and settlement-retry visibility, with no uncaught browser errors. Desktop and mobile card screenshots were visually inspected.

Actual deployed CPU and latency savings require a matched before/after comparison after deployment with representative live auctions and roster history. No production deployment, application data edits or load test was performed in this session.
