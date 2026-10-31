# Production load test report

- Started: 2026-10-30T10:22:54.463Z
- Target: https://centuri-dkp-automation.vercel.app/api/dkp
- Method: authenticated GET only
- Workload: 1, 5, 10, 20 concurrent clients; 15s per level; one request per client every 2s
- Dashboard payload counts: {"rosterCount":68,"clanMemberCount":22,"bossActivityCount":97}
- Session cleanup: HTTP 200

| Concurrent clients | Requests | Requests/s | Failed | p50 ms | p95 ms | Max ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 6 | 0.4 | 0 | 486 | 554 | 554 |
| 5 | 31 | 1.97 | 0 | 434 | 3097 | 3916 |
| 10 | 66 | 4.4 | 0 | 355 | 692 | 4056 |
| 20 | 105 | 6.73 | 0 | 448 | 4352 | 7102 |

- Stop reason: All planned levels completed.
- Scope: read-only dashboard route; no DKP, boss, roster, or auction write routes were called.
- Data source: the dashboard reads MongoDB and may refresh the roster cache from its configured Google Sheet when stale; no Google Sheet write was performed.
- Interpretation: the measured endpoint and workload do not establish a universal maximum number of users; user behavior and MongoDB/Vercel quotas affect capacity.
