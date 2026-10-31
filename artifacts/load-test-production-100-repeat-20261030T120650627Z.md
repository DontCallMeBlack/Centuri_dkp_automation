# Repeat production load test: 100 clients

- Started: 2026-10-30T12:06:50.627Z
- Target: https://centuri-dkp-automation.vercel.app
- Clients: 100; planned request-start window: 15 seconds; full run from login through cleanup: 22.3 seconds; peak in flight: 100
- Requests: 378 started during the 15-second window (about 25.2 request starts/sec); failures: 7 client-side timeouts
- Overall latency: p50 3026 ms; p95 12894 ms; max 15011 ms
- Session cleanup: HTTP 200

| Route | Requests | Failures | p50 ms | p95 ms | Max ms | Response bytes |
|---|---:|---:|---:|---:|---:|---:|
| page-dashboard-boss-history | 65 | 0 | 1380 | 2096 | 2115 | 2084420 |
| page-dashboard-items | 20 | 0 | 1556 | 2130 | 2212 | 557720 |
| page-admin-requests | 20 | 0 | 1460 | 2084 | 2091 | 486180 |
| auth-session | 114 | 1 | 2640 | 12809 | 15011 | 14351 |
| page-admin-toons | 9 | 0 | 1331 | 2105 | 2105 | 218781 |
| dkp-dashboard | 77 | 4 | 7038 | 15001 | 15010 | 2036843 |
| admin-requests | 18 | 2 | 5980 | 15003 | 15003 | 600160 |
| boss-history-data | 32 | 0 | 5078 | 12012 | 13052 | 1217248 |
| admin-toons | 5 | 0 | 7078 | 9960 | 9960 | 72785 |
| auction-catalog | 9 | 0 | 4996 | 11077 | 11077 | 2709 |
| admin-archives | 6 | 0 | 8009 | 11991 | 11991 | 7392 |
| auction-item-image | 3 | 0 | 5301 | 6276 | 6276 | 150672 |

- Scope: dashboard, session, DKP, boss history, catalog/images, admin requests/archives, and toon roster GETs.
- Auction-list and role-change GETs are excluded because they can trigger settlement or scheduled changes.
- Clients share one Chief account; this is not a 100-distinct-account test.
- The planned request window completed; the runner did not stop immediately after the first timeout. No further production load was sent after this run.
