# Application UI/UX review — 31 October 2026

Reviewed all application pages and dashboard views against WCAG 2.2 A/AA checks, keyboard operation, responsive reflow, consistent navigation, visible feedback, and recovery from empty results.

## Improvements by area

| Area | Changes |
| --- | --- |
| Shared layout | Descriptive browser titles and section announcements, one main landmark, offline feedback, scrollable desktop sidebar, mobile safe-area spacing, and consistent selected states. |
| Mobile controls | 44px button targets, 16px text-entry fields to avoid iOS focus zoom, clearer placeholders, wrapping controls and dialog footers. |
| Sign in / request access | Visible primary heading on mobile, named form and busy status, accessible password toggle state, and reset success/password-visibility state when switching modes. |
| Roster / toon balances | Mobile table column proportions and fully readable class names, descriptive table caption, and distinct empty-roster versus empty-search guidance with a reset action. Shared typography and spacing also apply to individual toon cards. |
| Auction house | Clear page name, bid range and whole-point guidance attached to each input, correct button-group semantics for view filters, clear-search recovery, and noninteractive picker thumbnails to prevent nested buttons when items have multiple images. |
| Item catalog | Clear page name, matching-result counts, correct heading hierarchy, and actionable empty/search states. |
| Kill history, including the legacy URL | Consistent page/loading names, search across loaded boss names, attendees and recorders, matching counts, and search recovery. The search explicitly describes its loaded-record scope; active attendance edits remain visible. |
| Role changes | Toon/owner/subrole search, an explanation of approval and cutoff behavior, actionable load-error retry, and helpful empty states. |
| Members and access | Clear page title, consistent selected-section styling, empty member-search recovery, and shared mobile control improvements throughout sign-up requests, members, clan toons and activity. |
| Clan toons | Helpful empty/search states with a reset action. |
| Loading, errors and missing pages | Responsive loading cards, shared error-page control styling, and a custom 404 with a route back to the roster. |

## Verification

- Production build and TypeScript: passed.
- Existing automated tests: 175 passed.
- Production browser performance/navigation smoke: passed, including browser history, mobile navigation, signup and live auction expiry.
- New [UI/UX browser regression runner](../scripts/ui-ux-smoke.cjs): nine routes, at 320, 390, 768 and 1440px; no page-level horizontal overflow or uncaught browser errors.
- axe-core checks using WCAG 2 A/AA, 2.1 AA and 2.2 AA tags: no detected violations in the tested page states. Additional scans cover signup, record-kill dialog, mobile navigation, auction picker, catalog creation and administration sections.
- Browser interactions: search reset in roster/catalog/history/role changes/auctions, mobile menu Escape and focus restoration, view title updates, browser Back, offline notice, multi-image auction picker structure, and catalog form layout.
- Existing management browser runner: Chief, General, Guardian and Clansman flows passed, including catalog creation/edit/removal with browser image cropping, history editing/comments, role approval visibility, and management access restrictions. All mutations were intercepted fixtures.
- Visually inspected mobile screenshots of roster, auction house, history, role changes and administration.

Browser checks intercepted application APIs with fixture data. They validate frontend behavior, not live MongoDB/Google Sheets availability or real financial writes. Automated accessibility checks do not establish full WCAG conformance or replace assistive-technology testing. No deployment was performed.

## Repeat the new checks

Install `playwright` and `@axe-core/playwright` into an external tools directory. Set `PLAYWRIGHT_MODULE` and `AXE_MODULE` to those module paths. Start the app, set `PERF_ORIGIN` to its local URL, and run `node scripts/ui-ux-smoke.cjs`. `BROWSER_PATH` overrides the default Chrome executable. Optional `UI_SCREENSHOTS_DIR` saves desktop/mobile screenshots.
