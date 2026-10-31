# Populated management-page checks — 31 October 2026

Application source, functionality, permissions, and live records were not changed in this follow-up. Added only the [browser test runner](../scripts/management-smoke.cjs) and this report.

The earlier performance smoke test used a Chief session with mostly empty management fixtures. This follow-up exercises populated pages separately for Guardian, General, Chief, and Clansman sessions.

## Results

| Check | Guardian | General | Chief | Clansman |
| --- | --- | --- | --- | --- |
| Populated catalog and search | Passed | Passed | Passed | Access blocked |
| Edit name/boss, unchanged-save disabled | Passed | Passed | Passed | — |
| Two-subrole limit and exclusive Everyone selection | Passed | Passed | Passed | — |
| Browser image crop and WebP compression | Passed | Passed | Passed | — |
| Create/edit/remove request and UI flows | Passed | Passed | Passed | — |
| Auction posting form and item search | Passed | Passed | Passed | — |
| Attendance editor, attendee search, cancel, comments | Passed | Passed | Passed | — |
| Role-request approval controls | Hidden | Visible | Visible | — |
| Own pending role-request cancellation control | Visible | — | — | — |
| Member administration | Access blocked | Four sections checked | Four sections checked | Access blocked |
| Mobile item editor: no horizontal overflow | Passed | Passed | Passed | — |
| Uncaught browser errors | 0 | 0 | 0 | 0 |

Administration checks covered populated pending sign-ups, member search, opening/closing toon-link and rank dialogs, populated clan toons and the add-toon dialog, and the activity log with on-demand archives. Financial/account actions were not submitted. Catalog create/edit/remove submissions were intercepted and applied only to in-memory test data; each management-role run emitted exactly the expected PATCH, POST, and DELETE requests.

Source review also confirmed existing server permission checks: all three management roles manage catalog items and kill history; Chief and General manage members/toons and approve role-change requests. Fixture-backed browser checks do not substitute for live authorization or database persistence tests.

## Performance conditions

Local production build at `http://localhost:3101`, headless Chrome, 20 Mbps upload/download, 100 ms emulated network latency, 4× CPU slowdown, and 200 ms artificial API delay. Fixtures contained 120 catalog items with valid raster images, 30 roster records, an attendance record with a comment, a pending role request, pending/member accounts, and an audit event.

The populated catalog became ready in 2,299 ms for Guardian, 2,331 ms for General, and 2,329 ms for Chief in this run. These are local fixture observations, not deployed API latency guarantees.

`npm test`: **175 passed**. `node --check scripts/management-smoke.cjs`: passed.

## Reproduce

Use the Playwright installation described in the [performance review](./performance-review-20261031.md), start the production server, then run:

```powershell
$env:PLAYWRIGHT_MODULE = "$env:TEMP/centuri-performance-tools/node_modules/playwright"
node scripts/management-smoke.cjs
```

Every API request is intercepted. The runner never forwards account or financial mutations to the live backend. The shared browser tab stays at the real login screen; isolated browser contexts supply fixture sessions and are closed after testing.

Live MongoDB/Google Sheets verification remains unavailable with this checkout's current server configuration.
