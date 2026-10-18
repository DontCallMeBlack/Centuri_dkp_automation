# Security and UI review

This review covers the application source, API authorization, DKP calculations, Google Sheets journal/recovery, auction reservations/settlement, uploads, authentication, and client data handling. Verification results below identify earlier checks separately from the latest fix pass.

## Security and correctness changes

| Original finding | Impact | Implemented change |
|---|---|---|
| First public registration could claim Chief; simultaneous registrations could both claim it | Administrative takeover on a fresh installation | Private one-time setup token and serialized bootstrap claim. Ordinary registration cannot initialize an administrator. |
| Known JWT fallback and ineffective JavaScript logout | Forged sessions when misconfigured; logout did not revoke access | Random 256-bit opaque sessions, hashed persistence, explicit expiry, HttpOnly/Secure/SameSite Strict cookies, server revocation. JWT code/dependencies removed. |
| Generic cookie name on a shared parent domain | A compromised sibling subdomain could inject a session cookie | Production uses a browser-enforced `__Host-` cookie with Secure, Path `/` and no Domain. |
| Boss awards and attendance reversals could be repeated after interrupted responses | Duplicate grants or deductions | UUID request IDs, request fingerprints, deterministic grant identity, persisted pending changes, replay-safe journal, deletion tombstones, Resume controls. |
| Bid affordability could race DKP debits | Points promised beyond the true balance | Shared renewable ledger lock for financial writes and bid reservation planning. |
| Reservations identified only by Sheet row | Row reuse/moves could misattribute money | Bind holds to owner/toon identity, verify all outstanding bid totals, reject moved/ambiguous/corrupt reservations. |
| Role/link state checked before a later mutation | Concurrent demotion/unlink could use stale authority; final-Chief write skew | Administration transaction fence, live actor/target checks, serialized Chief count, bid/financial-plan coordination. |
| Unlinking/removing users with financial tasks | Detached reservations, wins or delivery tasks | Follow stable identities and old/current rows across Sheet moves, block orphan-reservation adoption and affected link removal/member deletion, revoke removed users’ sessions. |
| Recovery could overwrite later Sheet changes | Stale absolute writes could corrupt balances | Every point operation stores exact before/after cells and identities. Recovery recognizes already-applied work and pauses on mixed/unexpected state. |
| Historical corrections and missed rollover periods handled activity inconsistently | Incorrect five-week eligibility/activity | Correct retained history buckets and elapsed calendar weeks, including DST. Preserve the serialized activity field. |
| Formatted numeric reads/unchecked overflow | Locale rounding or unsafe values could alter accounting | Unformatted Google reads, RAW numeric writes, finite/safe-range checks and hold-floor validation. |
| Auction ownership trusted recycled nicknames | A different account could inherit old ownership | Stable creator user IDs; guarded manager handling for legacy records. |
| Removal claims and no-bid completion raced other changes | Stranded removals or accepted bid overwritten | Atomic removal/release transaction, stale removal recovery, no-bid high-bid comparison. |
| Unbounded request decoding and query-shaped credentials | Resource exhaustion and unsafe query input | Bounded streaming JSON/multipart readers, type validation, image signature/decoder/dimension/size checks, authentication throttles. |
| Missing explicit mutation-origin policy and raw provider errors | CSRF exposure and backend detail disclosure | Exact-origin checks, strict cookies, safe client errors, standard response security headers. |
| Hydrated bid objects were spread into API responses | Internal document fields/response failures | Explicit bid response fields. |
| Private client state or in-flight results could survive account changes | Stale balances, permissions or another account’s state | Scoped memory caches, generation/version guards, cross-tab logout, stale-response rejection and fresh financial checks. |
| Old failed settlements could monopolize sweeps | Healthy expiries delayed | Backoff, paused integrity failures, unresolved-record inclusion, safe manager retry for tracked operations. |

## UI and performance changes

- New responsive dark sidebar/header shell, redesigned sign-in/sign-up, Overview, auction controls, compact catalog, members, and history.
- Rank icons: Crown for Chief, Swords for General, Shield for Guardian, User for Clansman; distinct game-class icons for the roster.
- Shared shell and fast identity lookup render independently of Sheets. Demand-loaded workspace views retain mounted content, filters and drafts; cached snapshots stay visible during deduplicated background refresh.
- Navigation uses the sidebar/mobile drawer, active destination markers, section-specific headers, keyboard links, a skip link, and real logout. The duplicate horizontal workspace bar is removed. Roster summaries appear only on Roster, alongside individual toon DKP cards.
- Refresh buttons are removed. Visible views refresh automatically with per-view request exclusion, deduplication, jitter, offline/hidden-view suspension, wake throttling and exponential retry backoff. Roster/history/members use a two-minute base interval; catalog/full auction snapshots use three minutes. Compact auction checks continue every 30–35 seconds.
- Native dialogs provide focus trapping, Escape/backdrop handling and focus restoration; crop controls support keyboard movement and reduced motion.
- Image requests use native lazy loading, private cache headers and ETags. Catalog editors render on demand rather than one large form per item.
- Expired auction settlement runs in bounded background work after API responses. The UI displays Finalizing until the server confirms completion; protected balances remain checked before every write.
- Freshness, failed refresh, retry and recoverable financial operation states remain explicit. Cached content is never proof that a new bid is affordable.

## Deployment and compatibility

1. Use MongoDB Atlas/a replica set with transaction support and ensure unique/TTL indexes can be created. New collections store sessions, auth rate limits and the administration fence; existing Sheet/auction data is retained.
2. Existing users keep their roles and password hashes. They must sign in again because old JWT sessions are intentionally invalidated. New accounts use bcrypt work factor 12 and bounded normalized credentials.
3. Only a fresh installation needs `CLAN_BOOTSTRAP_TOKEN` (a private random value of at least 32 characters). Set it on the server; the owner enters it when first-Chief setup is requested. The claim cannot repeat after initialization. Never expose it in a public environment variable.
4. `JWT_SECRET` is no longer used. Service configuration remains `MONGODB_URI`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`.
5. Set `APP_ORIGIN` to the exact public HTTPS origin when a reverse proxy changes the origin seen by Next. Vercel supplies trusted client IP headers automatically. Other production hosts require `TRUST_PROXY=true` and a proxy that replaces forwarded IP headers; authentication fails closed when a valid trusted IP is unavailable.
6. Ambiguous legacy pending writes/reservations intentionally pause. Verify the Sheet and stored records before reconciliation; forcing a retry without confirming prior charges can corrupt balances.
7. Existing catalog databases need `node scripts/migrate-catalog-name-index.cjs --apply` in the configured deployment environment. Without `--apply`, the script only reports readiness and indexes. It normalizes legacy listed flags, installs the case-insensitive `listed_item_name_unique` index for `isListed: true`, then removes the old global name index. It stops on duplicate listed names and preserves item IDs, archived records, images, and auction history. Deploy the matching model before applying the migration.

## Verification

The latest fix pass passed TypeScript and the production build. No new automated tests, browser checks, or live financial mutations were performed in this pass. The regression and smoke results below describe earlier work and do not validate every latest change.

- Production build and `npm run typecheck` passed.
- All **159 automated regression tests passed**, including unused-template formula errors, exact invalid-cell reporting, legitimate numeric placeholders, late-bid deadline boundaries and legacy boss-type compatibility, plus the accounting, replay/recovery, activity/DST, hold identity, administration, image and session regressions.
- **Eight isolated DKP/auction integration checks passed** against production route handlers, a local replica set and a local Sheets transport fixture. Verified actual award writes/replay, 24-hour posting, legacy Prime items, early/late bid deadlines, correct hold totals, and actionable invalid-cell errors. No live Google requests or production writes occurred in these checks. Results: `artifacts/ui-review/dkp-auction-integration-results.json`.
- Browser smoke checks passed against the production build, using mocked accounts/roster/auctions: individual toon cards, summaries appearing only on Roster, removed workspace/refresh buttons, sidebar/back navigation preserving drafts, timed automatic refresh, hidden-tab suspension and visible-return recovery, and recovery after a temporary failure with retry backoff. Earlier login, award retry/field locking, bidding, catalog, administration/history, mobile overflow, dialog focus, logout and Clansman controls also passed. Screenshots are under `artifacts/ui-review/` (ignored local review artifacts).
- All **15 HTTP security smoke checks passed**: unauthenticated rejection, old/forged JWT rejection, cross-origin mutation rejection, malformed/query-shaped/oversize credentials, response headers and host-bound server cookie expiration without database access.
- The earlier authentication/admin pass had **16 isolated database integration checks passing** against a production build and a temporary local MongoDB 8.2.6 replica set. They verified private/bootstrap concurrency, pending and duplicate accounts, hashed opaque sessions/cookie flags, live role lookup, forged/expired/revoked session rejection, CSRF, General authority limits, concurrent Chief demotions retaining a Chief, blocked removal with an outstanding auction, and clean removal with session revocation. The test server and database stopped; temporary database files were removed. Results are in `artifacts/ui-review/auth-integration-results.json`.
- npm’s advisory registry reported zero known vulnerabilities for the audited dependency set. This is an advisory check, not a guarantee that no vulnerabilities exist.
- Test services use isolated fixtures; no live Google Sheets balance changes or production account writes were performed.

## Remaining limits

- Google Sheets and MongoDB cannot share one atomic transaction. Direct manual Sheet writes bypass app locks; recovery stops on detectable identity/value drift, but operators should restrict direct edit access.
- Unknown legacy charge state requires verified reconciliation. There is no general reconciliation UI or full historical bid timeline.
- Distinct staff request IDs cannot prove two submissions refer to different real-world boss kills.
- Settlement runs after application requests, with a daily authenticated cron fallback at 05:05 UTC. Vercel Hobby has a flexible one-hour scheduling window; this does not guarantee prompt settlement without traffic. A more frequent worker is needed for a strict deadline.
- First loads still depend on database/Sheets latency. The refresh improves navigation and rendering behavior; no production response-time benchmark or uptime guarantee is asserted.
- MFA, password recovery, and formal penetration/accessibility certification are outside this implemented pass.

## Latest fix pass

- Overview has one kill-recording entry button. Boss grants, attendance changes and auction posting retain opaque retry IDs in account-scoped browser session storage across reloads. Retrying requires the same selected inputs; closing the tab can lose that browser receipt.
- Auction creation stores a permanent server receipt inside its transaction and reads catalog details there. Existing auctions retain their original pictures when catalog images change.
- Authentication quotas apply per trusted source and source/account pair, preventing an attacker on another IP from exhausting a nickname-only or global quota. Authenticated auction, catalog and boss writes also have per-member limits.
- Preview deployments cannot access the shared database or Sheet. Process startup no longer starts financial schedules; hosting cron owns scheduled work.
- Boss-history calculations keep the previously applied participants counted during an interrupted attendance edit. History APIs use cursor pagination in batches of 50, and loaded history refreshes without retaining deleted records.
- Session row metadata resolves from the cached roster rather than exposing stale stored row assignments. Financial endpoints still resolve against their required roster state.
- Pages use a fresh script nonce and dynamically rendered content security policy; inline script allowances are removed. Existing inline styles remain allowed.
- `DKP_WRITES_PAUSED=true` pauses financial Sheet operations for coordinated maintenance. Deploy the pause and wait for in-flight work to finish before editing directly. Google Sheets edits still cannot participate atomically in MongoDB transactions.

Security design references: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Framework behavior was checked against this repository’s bundled Next.js guides before implementation.
