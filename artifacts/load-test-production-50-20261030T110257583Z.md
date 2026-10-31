# Production load test report: 50 virtual clients

- Started: 2026-10-30T11:02:57.583Z
- Target: https://centuri-dkp-automation.vercel.app
- Workload: ramp 10 to 25 to 50 concurrent virtual clients; 20 seconds per stage.
- Each client makes sequential page and data GET requests, then waits 1200 ms before repeating. Peak simultaneous HTTP requests are recorded per stage.
- Scenario assignment: 25% of clients per flow (boss history, catalog, admin requests, toon management); request totals vary because flows make different numbers of API calls.
- Session cleanup: HTTP 200
- Auction image route included: yes

## Stage summary

| Virtual clients | Requests | Requests/s | Failures | Peak in-flight | p50 ms | p95 ms | Max ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 209 | 10.28 | 0 | 10 | 306 | 2648 | 6126 |
| 25 | 558 | 25.94 | 0 | 25 | 447 | 1841 | 6038 |
| 50 | 783 | 33.41 | 0 | 50 | 1051 | 2114 | 7239 |

## Route details

### 10 clients

| Route | Requests | Failures | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|---:|
| page-dashboard-items | 15 | 0 | 236 | 1687 | 1687 |
| page-admin-requests | 11 | 0 | 222 | 1683 | 1683 |
| page-dashboard-boss-history | 17 | 0 | 232 | 1734 | 1734 |
| page-admin-toons | 11 | 0 | 231 | 1844 | 1844 |
| auth-session | 53 | 0 | 273 | 2493 | 2681 |
| dkp-dashboard | 30 | 0 | 343 | 5284 | 5326 |
| admin-requests | 10 | 0 | 352 | 6079 | 6079 |
| auction-catalog | 13 | 0 | 275 | 2709 | 2709 |
| admin-archives | 10 | 0 | 275 | 1991 | 1991 |
| boss-history-data | 15 | 0 | 324 | 2933 | 2933 |
| auction-item-image | 13 | 0 | 499 | 1239 | 1239 |
| admin-toons | 11 | 0 | 389 | 6126 | 6126 |

### 25 clients

| Route | Requests | Failures | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|---:|
| page-admin-toons | 41 | 0 | 218 | 400 | 443 |
| page-admin-requests | 35 | 0 | 230 | 399 | 401 |
| page-dashboard-boss-history | 42 | 0 | 225 | 379 | 483 |
| page-dashboard-items | 29 | 0 | 237 | 397 | 411 |
| auth-session | 146 | 0 | 450 | 1037 | 2235 |
| admin-requests | 33 | 0 | 974 | 1902 | 1958 |
| admin-toons | 40 | 0 | 973 | 2073 | 6038 |
| dkp-dashboard | 68 | 0 | 1000 | 1945 | 5142 |
| auction-catalog | 27 | 0 | 693 | 1021 | 2169 |
| admin-archives | 33 | 0 | 890 | 2099 | 3076 |
| boss-history-data | 38 | 0 | 945 | 1854 | 2246 |
| auction-item-image | 26 | 0 | 796 | 1270 | 1442 |

### 50 clients

| Route | Requests | Failures | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|---:|
| page-dashboard-items | 41 | 0 | 216 | 437 | 1006 |
| page-admin-toons | 65 | 0 | 217 | 437 | 930 |
| page-dashboard-boss-history | 52 | 0 | 229 | 760 | 910 |
| page-admin-requests | 48 | 0 | 227 | 749 | 984 |
| auth-session | 205 | 0 | 549 | 1586 | 2140 |
| dkp-dashboard | 92 | 0 | 1965 | 2960 | 3058 |
| admin-requests | 47 | 0 | 1979 | 2998 | 3262 |
| admin-toons | 65 | 0 | 2008 | 4186 | 7239 |
| admin-archives | 42 | 0 | 1054 | 2002 | 2008 |
| boss-history-data | 49 | 0 | 1103 | 2044 | 2055 |
| auction-catalog | 39 | 0 | 1082 | 2012 | 2039 |
| auction-item-image | 38 | 0 | 1257 | 2252 | 2266 |

## Scope and limits

- Read-only route coverage: dashboard page, boss history, auction item catalog/images, admin requests/archives, toon roster, session, and DKP dashboard data.
- The auction list API was excluded because its GET schedules auction settlement. The role-changes API was excluded because its GET can expire or apply scheduled changes.
- Roster reads may refresh a cached roster from the configured Google Sheet if stale. No Google Sheet writes or business-data mutation routes were called.
- Fifty simulated clients share one Chief account. This exercises the app and database under concurrent reads but does not model 50 separate identities.
- Stop reason: All planned stages completed.
- This result describes the tested workload and time window; it does not establish a universal maximum user count or a long-duration soak limit.
