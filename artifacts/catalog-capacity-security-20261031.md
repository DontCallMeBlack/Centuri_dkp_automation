# Items tab capacity and security checks

Tested locally on 2026-10-31 against a Next.js production build.

## Result

Opening a catalog of 1,000 items passed the browser fixture checks without a timeout or browser errors. The catalog API returns metadata only; image files are fetched separately. Added pagination to render 50 cards at a time while keeping search across the entire catalog. Each card loads only the first image lazily; the other seven possible images are not downloaded when opening the tab.

This supports handling 1,000 items in the browser. It does **not** establish a production timeout or concurrent-user capacity: MongoDB/session lookups and production hosting were not load-tested.

## Browser measurements

The repeatable [browser script](../scripts/catalog-capacity-smoke.cjs) used 1,000 item records with eight images declared per item. Image responses used a real textured 320×320 WebP of 61,912 bytes. Chromium used a 4× CPU slowdown; network configuration was 10 Mbps with 100 ms latency. Fixture APIs added 250 ms per request. Intercepted responses may not receive all browser network throttling, so these timings are not production bandwidth benchmarks.

| Check | Observed |
| --- | --- |
| Click Items to 50 rendered cards | 455 ms |
| Search across all 1,000 records | 506 ms |
| Metadata fixture payload | 122,057 bytes |
| Initial image requests | 18, all for the first image only |
| Cards/images mounted per page | 50 |
| Next/previous page | Passed |
| Search finds item outside first page | Passed |
| No-match and cleared-search states | Passed |
| Executable-looking item name rendered as text | Passed |
| Mobile horizontal overflow at 390 px | None |
| Reload with each fixture API delayed 3 seconds | Recovered in 9,602 ms with visible loading state |
| Browser errors | None |

The image bytes above describe each requested fixture image, not 8,000 images downloaded. The tested browser initially requested approximately 1.1 MB of images.

## Security verification

Added 11 [automated tests](../tests/catalog-security.test.mjs) that execute real catalog/image handlers and validators with isolated authentication and database boundaries:

- Missing authentication blocks catalog reads, image reads and catalog writes before item storage is accessed.
- Members and unknown roles cannot read or modify the manager catalog; Chief, General and Guardian can read it.
- POST, PATCH and DELETE reject hostile origins before decoding uploaded bodies.
- A 1,000-item response selects metadata fields and excludes stored image bytes and internal creator information. Handler serialization measured about 113 KB for this separate fixture; database latency is excluded.
- Query-shaped or malformed item IDs and invalid image indexes are rejected before querying item storage.
- Image queries select one array slot. Responses have private caching, Cookie variation, nosniff and a sandbox policy. A conditional response cannot bypass authentication.
- Missing items and missing image slots return 404.
- Create/edit reject SVG content, forged MIME types, corrupt rasters, excess file counts and oversized multipart bodies.
- Delete rejects query-shaped and non-scalar IDs.
- A compressed 6,400×6,400 PNG fits inside the upload byte limit but exceeds 40 million pixels and is rejected by the image decoder.

Also checked the running local production server over HTTP without session cookies: both read endpoints returned 401, and cross-origin POST/PATCH/DELETE returned 403. No authorized inventory, account or financial writes were sent.

All **186** automated regression tests passed. TypeScript checking and the production build passed.

## Remaining capacity limits

- Catalog metadata still loads in one request. Pagination bounds browser cards and image elements, not the database result size. Reassess server pagination if the catalog grows substantially beyond this scale.
- Image reads authenticate and access MongoDB. The current ETag is computed after reading image bytes, so a 304 response saves transfer bandwidth but still incurs database work.
- Catalog/image GET handlers have no explicit per-member read rate limit. This check does not establish resilience to an authenticated request flood; hosting limits and a separate controlled concurrency test would be needed to measure that.
- No live MongoDB timing, production cold-start, multi-user load, or exhaustive penetration test was performed. The security passes establish the listed behaviors, not the absence of every vulnerability.

## Reproduce

Run `npm test`, `npm run typecheck` and `npm run build`. Start the resulting production build locally. Install Playwright separately if needed, then set `PLAYWRIGHT_MODULE` to that module's directory and `PERF_ORIGIN` to the local server before running `node scripts/catalog-capacity-smoke.cjs`. `BROWSER_PATH` can override the Chrome executable. All browser API requests are intercepted fixtures, and unexpected API writes fail the script.
