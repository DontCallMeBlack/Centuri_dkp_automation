# Application performance review — 31 October 2026

The production build passes and the application is running locally at http://localhost:3101. Live backend verification remains blocked: this checkout has no `GOOGLE_SHEET_ID`, and its configured MongoDB connection failed with `MongooseServerSelectionError`. No deployment or live financial writes were performed.

## Application logic reviewed

The application uses opaque MongoDB sessions and role checks to protect member, Guardian, General, and Chief capabilities. Google Sheets holds roster balances; MongoDB holds accounts, reservations, auction state, attendance, role schedules, archives, and recoverable mutation ledgers. Financial mutations use fresh reads, identity checks, transactions, idempotency keys, and ledger locks. Dashboard sections retain visited panels in browser memory; administration and role changes are separate routes. Uploads already crop and compress images in the browser before server validation and encoding.

Reviewed the login/signup flow, session lifecycle, roster and award picker, attendance/history editing, auction catalog and image loading, bids and settlement, role changes, administration, roster cache, database connection reuse, navigation, and loading states. Performance changes preserve the financial mutation paths and authoritative API authorization.

## Changes

- Removed the sign-in burst of requests for every section and administrative archive. Hover/focus intent now warms only the destination, with a short delay; data-saving and very slow connections skip speculative API/module downloads.
- Added opt-in 15-second browser cache reuse for initial navigation. Explicit refreshes and mutation follow-ups still fetch. Stale snapshots render immediately and revalidate on remount. Private data remains bounded to tab memory and is cleared on session changes/logout.
- Expanded DKP invalidation to related administration, toon, and role-change snapshots.
- Added visibility-aware roster refresh with retry backoff. Hidden/inactive views do not poll the roster.
- Memoized roster rankings and separated deferred filtering. Initially render 50 rows, with local “Show more toons” controls; search still covers all downloaded records.
- Isolated auction countdown updates into small subscribers using one shared timer. The auction list updates at expiration instead of every second; the timer stops when no countdowns are mounted.
- Added pending navigation feedback, removed vertical movement during page entry, and aligned dashboard/history loading titles with their destination headings.
- Imported only the Sheets API instead of the full Google API SDK.
- Replaced routine roster-cache upserts with reads and shared concurrent display reads within a server instance. Explicit fresh reads remain separate, and invalidation drops the in-flight reference.
- Moved the full attendance aggregation out of ordinary roster reads. It runs when a manager opens the award picker with `fresh=1`, where suggestions are needed.
- Combined session and approved-user lookup into one MongoDB aggregation round trip. The query checks expiry, revocation, and current approved-user permissions every time; it does not cache authorization.
- Reduced the session endpoint's roster projection to identity and row fields.

## Validation

- `npm run build`: passed, including Next.js TypeScript checks.
- `npm test`: 175 passed, including seven new cache tests for freshness, expiration, concurrent consumers, mutation races, logout, error recovery, and dependent-view invalidation.
- `git diff --check`: passed.
- Production browser smoke test: passed across roster, auctions, history, catalog, role changes, administration, mobile menu, browser back/forward, legacy history URL, signup view, roster pagination/search, and live-to-finalizing auction expiry. No uncaught browser errors.

### Browser measurements

Chrome headless against a local production build; 20 Mbps download/upload, 100 ms emulated network latency, 4× CPU slowdown, 200 fixture roster records, and 250 ms artificial API delay. API fixtures replace live MongoDB/Google Sheets calls; these measurements establish frontend behavior, not deployed API latency. Navigation follows 450 ms of hover to exercise destination prefetch. Browser automation actionability waits are included in navigation/search timings.

| Measurement | Observed |
| --- | ---: |
| Initial roster ready | 2,192 ms |
| Initial resource transfer entries, excluding the document | 298,766 bytes |
| Initial API requests | 2: session and DKP |
| Auction navigation | 513 ms |
| History navigation | 418 ms |
| Catalog navigation | 416 ms |
| Role changes navigation | 515 ms |
| Administration navigation | 444 ms |
| Return to roster | 515 ms |
| Search after expanding to 100 displayed rows | 373 ms |

These are single-run observations, not latency guarantees or a before/after benchmark. Repeat against deployment with working services to establish production medians and tail latency.

### Google SDK import measurement

Separate fresh local Node processes, one run per import:

| Import | Load time | Loaded modules | Process RSS |
| --- | ---: | ---: | ---: |
| Full `googleapis` | 1,347 ms | 1,080 | 166 MB |
| Sheets entry point | 172 ms | 133 | 58 MB |

This measures module loading and whole-process memory locally, not hosted cold-start latency.

## Repeat the browser test

The [smoke runner](../scripts/performance-smoke.cjs) uses Playwright independently of application dependencies. On this Windows machine, Chrome is available at its standard location. Use `BROWSER_PATH` for another executable; `PERF_ORIGIN` defaults to `http://localhost:3101`.

```powershell
npm run build
npm start -- --port 3101
```

In a second terminal:

```powershell
npm install --prefix "$env:TEMP/centuri-performance-tools" --no-audit --no-fund playwright
$env:PLAYWRIGHT_MODULE = "$env:TEMP/centuri-performance-tools/node_modules/playwright"
node scripts/performance-smoke.cjs
```

## Remaining live verification

Supply a reachable MongoDB configuration and Google Sheets credentials/ID through the server environment, then verify login and authenticated pages against actual services. After deployment, repeat representative multi-user reads and measure median/p95 API latency, database query timing, and Google Sheets refresh time. The previous 100-client production report showed substantial backend tail latency; the fixture test cannot establish that those production timeouts are resolved.
