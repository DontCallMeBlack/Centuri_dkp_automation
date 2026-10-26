# Centuri DKP Website — Detailed Requirements

## 1. Document scope and evidence

This document describes the behavior present in the Centuri DKP website code in this repository, including the security and UI refresh. It is an implementation-based specification rather than a separately approved product brief. Section 15 records remaining limits and policy gaps. See `SECURITY_AND_UX_REVIEW.md` for the changes, verification, deployment notes, and review limitations.

The application is a private clan tool for the Celtic Heroes game. It manages clan accounts, links those accounts to character rows (“toons”) in a Google Sheet, records DKP awards, and runs a timed item auction.

## 2. Product, users, and terminology

### 2.1 User types

The account roles, in descending authority, are:

1. **Chief**
2. **General**
3. **Guardian**
4. **Clansman**

Accounts have one of two statuses: **pending** or **approved**. Only approved accounts can establish a session. New accounts after the initial bootstrap account start as pending Clansmen.

### 2.2 Terms

- **Nickname**: the account name entered at sign-up and sign-in; it is intended to be the player’s in-game nickname.
- **Toon**: a character/roster row read from the Google Sheet. The account column may be empty; the owner is then used as the displayed fallback name.
- **Owner**: Google Sheet column A.
- **Account / toon name**: Google Sheet column B.
- **Subclass / role**: Google Sheet column C.
- **DKP**: points recorded in the roster sheet and used for boss attendance rewards and auction spending.
- **Linked toon**: a roster row assigned to an approved app account by a Chief or General.
- **Roster row index**: the Google Sheet row number, starting at row 3.

## 3. Routes and navigation

### 3.1 Web pages

| Route | Behavior and access |
|---|---|
| `/` | Immediately redirects to `/login`. |
| `/login` | Public sign-in and sign-up screen. It remains reachable when signed in. |
| `/dashboard` | Main authenticated application. Its data API redirects unauthenticated users to `/login`. |
| `/admin/requests` | Clan administration page; Chief and General only. |
| `/admin/role-changes` | Members request subclass changes for their linked toons; Generals review all roster requests and activity. |
| `/admin/boss-history` | Standalone boss history page; any approved clan account can view it, while Chief, General, and Guardian can edit/delete awards. |

The desktop sidebar and mobile drawer are the workspace navigation: **Roster**, **Auction house**, **Kill history**, **Item catalog** for staff, **My role changes** for members, **Role request review** for Generals, and **Members & access** for Chiefs/Generals. The duplicate horizontal workspace button bar is removed. The header names the current section and the active link exposes `aria-current`. Views use `/dashboard?view=auction|items|boss-history`; Roster uses `/dashboard`. The older `/admin/boss-history` address remains supported. Sidebar history uses the embedded view so switching sections preserves visited views and drafts.

### 3.2 HTTP API routes

| Route | Methods and purpose |
|---|---|
| `/api/auth` | `POST` sign-up or sign-in. |
| `/api/auth/session` | `GET` current session identity and stored linked row IDs, without loading Google Sheets. |
| `/api/auth/logout` | `POST` revoke the current server session and expire its HttpOnly cookie. |
| `/api/dkp` | `GET` roster, linked approved members, user role, and sheet sync status; `POST` records a boss attendance award and changes DKP. |
| `/api/admin/requests` | `GET` administration data; `POST` approve, deny, link, unlink, remove, or change a role. Chief/General only. |
| `/api/admin/toons` | `GET` clan roster and pending change; `POST` create/remove a toon or finish an interrupted change. Chief/General only. |
| `/api/role-changes` | `GET` visible requests, schedules, and recent activity; `POST` request, approve, deny, or cancel a subclass change. All approved members may request/cancel their own; Generals may review or cancel any. |
| `/api/admin/boss-history` | `GET` awards; `PATCH` edit attendance; `DELETE` a boss award. Reads require a session; mutations require Chief/General/Guardian. |
| `/api/auction` | `GET` auction data, `GET ?live=1` lightweight auction updates, `GET ?includeArchive=1` full history, and `POST` auction actions. Any approved account may read/bid; individual actions have role and ownership checks. |
| `/api/auction/items` | `GET`, `POST`, `PATCH`, `DELETE` the saved-item catalog. Chief/General/Guardian only. |
| `/api/auction/image` | Authenticated image retrieval by item ID and image index. |

There is no password-reset API, profile-edit page, or public marketing page in the current route set.

## 4. Authentication and account lifecycle

### 4.1 Sign-up

- The login screen switches between sign-in and sign-up without navigating away.
- New nicknames are trimmed and Unicode NFKC-normalized, must contain 2–40 characters, and cannot contain control characters. A normalized lowercase key prevents new case/space/compatibility variants from duplicating existing identities, including legacy names.
- New passwords require at least eight characters, at most 72 UTF-8 bytes, and no null character. Passwords are hashed with bcrypt at work factor 12. Existing password hashes and short legacy passwords remain usable for sign-in.
- A fresh installation can create its first approved **Chief** only by proving knowledge of a configured private `CLAN_BOOTSTRAP_TOKEN` of at least 32 characters. Public sign-up alone cannot claim this role. The login screen reveals a First Chief setup code field only when the server requests setup. Bootstrap is serialized and recorded as claimed, so concurrent or later registrations cannot repeat it.
- Later accounts receive **Clansman** role and **pending** status. The user sees an approval message and the form switches back to sign-in without creating a session.
- A duplicate nickname returns an error. A pending account cannot sign in and receives a pending-approval message.
- Exact legacy nicknames retain their original lookup behavior; new nickname keys have a separate sparse unique MongoDB index.
- Durable counters throttle authentication across server instances per trusted source and source/account pair. Per 15-minute bucket, sign-in permits 120 attempts per source and 15 per source/account; sign-up permits eight per source and five per source/account. Vercel supplies trusted IP headers; other production hosts require a replacing proxy and `TRUST_PROXY=true`. Missing trusted IP configuration fails closed. Authentication throttling returns 429 with `Retry-After`.

### 4.2 Sign-in and session

- Sign-in looks up the nickname, compares the supplied password to the stored bcrypt hash, and rejects invalid credentials with a generic invalid-nickname-or-password message.
- Successful sign-in creates a cryptographically random 256-bit opaque session token. MongoDB stores its SHA-256 hash, user ID and seven-day expiry; a stolen database record does not itself provide the cookie token.
- The session cookie is HttpOnly, SameSite Strict, path `/`, priority High and has a seven-day max age. Production uses `__Host-centuri-session` with Secure and no Domain attribute to prevent sibling-subdomain cookie injection; local development uses `centuri-session`. There is no fallback JWT secret; old JWT cookies are deliberately invalidated by this upgrade.
- Protected APIs verify that the hashed server session exists and has not expired, then read the current approved user and role from MongoDB. Token possession alone never supplies authorization claims. Signing in rotates the current browser session.
- Sign Out calls the server, revokes that session, expires the cookie, clears private client caches, and signals other browser tabs. A failed sign-out displays an error instead of pretending the session ended. Removing an account revokes all its stored sessions.
- Missing/invalid/expired tokens and unapproved accounts are treated as unauthenticated. The dashboard and protected panels send the user to `/login` after a 401 response.
- Sign-up, sign-in, pending status, unauthorized status, permission denial, and server errors are surfaced in the relevant screens.
- The submit button and inputs disable while a request runs and display a signing-in/creating-account state. Password visibility can be toggled. Inputs use username/current-password/new-password autocomplete; sign-in preserves exact legacy nicknames up to 100 characters. After successful sign-in the client navigates to `/dashboard`; after successful sign-up it displays the message, clears the password/setup code, and switches to sign-in.

## 5. Roster source, linking, and synchronization

### 5.1 Source sheet and schema

The roster is read from the Google Sheets tab `DKP_Sheet_automated`, range `A3:I1000`. Rows without an owner in column A are omitted. The application maps the columns as follows:

| Sheet column | Meaning | Website use |
|---|---|---|
| A | Owner | Toon identity and display fallback. |
| B | Account / toon name | Toon identity and primary display name. |
| C | Subclass / role | Leaderboard grouping, item eligibility, and auction bid eligibility. |
| D | Weekly earned | Weekly DKP balance on the roster sheet. |
| E | Weekly spent | Weekly spending balance on the roster sheet. |
| F | Lifetime earned | All-time DKP earned. |
| G | Lifetime spent | All-time DKP spent. |
| H | Available | DKP available to the toon; used in the leaderboard and bidding limits. |
| I | Five-week activity | Rolling activity total maintained by the weekly reset process. |

Google Sheets reads request `UNFORMATTED_VALUE`, so display rounding and spreadsheet locale cannot change the balances used for accounting. Returned values are normalized to strings at the integration boundary. Rows without a nonblank owner are excluded before numeric parsing, so formula errors in unused template rows cannot block awards or posting. Physical Sheet row numbers are retained. Blank cells and standalone hyphen/en-dash/em-dash placeholders count as zero. Numeric text permits decimals, scientific notation, valid thousands separators, and a leading Unicode minus. Nonnumeric, nonfinite, malformed or unsafe balances on real toon rows reject the operation and identify the exact cell, such as `H15`; they never silently become zero. Existing fractional DKP values remain supported.

### 5.2 Toon/account links

- An approved account may be linked to one or more distinct sheet rows, or may have no linked rows.
- A sheet row can be linked to at most one approved account. The server checks existing assignments and the database has a sparse unique index on `sheetRecords.rowIndex`.
- A link stores row index plus owner and account values. If the row moves, an identity match (trimmed, case-insensitive owner plus account) can recover the link. If the row number is reused for a different identity, the stale link does not claim the new toon.
- Older records with a legacy `sheetRecordName` link by owner and include every roster row whose owner matches after trim/case normalization.
- Administration choices show unoccupied roster rows, searchable by account or owner. Empty account names display as “Unnamed toon”.
- Approval requires at least one selected roster row. Approval both marks the account approved and saves its selected toon links.
- Linking an already-approved account also requires at least one row. Linking rejects rows already owned by another approved account. Duplicate/conflicting links return a conflict error.
- A manager may unlink one toon at a time. The user’s remaining links are saved; the unlinked row becomes available. Removing the final link is possible using the individual unlink action.
- Pending sign-up denial deletes the pending account. No separate denial audit record is written.
- Search is available in each mapping selector; the selector shows the count of selected toons.

### 5.3 Roster cache and failure behavior

- Roster snapshots are cached in MongoDB by spreadsheet ID for 30 seconds.
- A refresh lock coordinates concurrent refreshes. The lock duration is 20 seconds; waiting/polling for an in-flight refresh can last up to 15 seconds with 250 ms polling.
- Ordinary reads may return stale cached roster data while Google Sheets is unavailable or another refresh is in progress. The API marks the data stale and reports whether a refresh was delayed/failed.
- Mutations that rely on roster rows request a fresh snapshot and reject rows that no longer exist or whose owner/account identity changed.
- Transient Google Sheets read failures (quota/rate limit, 408, 500, 502, 503, or 504) are retried up to three times after the first attempt, with exponential delay plus jitter. Writes are retried for rate-limit/quota errors.
- Google API requests have a 20-second timeout. Financial mutations and auction reservations share one spreadsheet ledger lock; a fresh read is taken inside that lock before a new reservation is committed. Cached views do not authorize spending.
- The cache preserves the Five-week activity field when serializing stored roster rows. Generation checks prevent a refresh begun before a mutation from publishing its obsolete snapshot afterward.
- The dashboard shows refreshing, last-updated, or cached/refresh-needed status with localized time. Financial actions still require authoritative server checks even when a cached screen is displayed.

## 6. Dashboard and DKP leaderboard

### 6.1 Shared dashboard shell

- The persistent shell has desktop sidebar, mobile navigation drawer, breadcrumb header, profile, role icon, permitted management links, Sign Out, skip-to-content link, and a clan-help footer.
- The Roster page shows three summary statistics: approved clan accounts, active linked toons, and the signed-in user’s aggregate available DKP before auction holds. These statistics and the welcome header appear only on Roster.
- A **My toon DKP** section replaces the aggregate My weekly earned card. Every linked toon has its own responsive rounded card showing its name, class/icon, available DKP before auction holds, and its individual earned-this-week value. Loading and no-linked-toon states are explicit.
- Roster contains the leaderboard. Overview provides one staff Record a kill entry button; its dialog selects the boss and participating toons before recording the award. Keyboard-operable sidebar/drawer links select the workspace view. Visited views, search/filter state and drafts remain mounted while switching; their hidden sections have descriptive accessible names instead of obsolete tab relationships.
- URL query state supports direct links to auctions, catalog, and embedded history. Feature panels load on demand rather than all shipping in the initial dashboard chunk.
- Scoped in-memory snapshots render returning views immediately while deduplicated requests revalidate. Refresh buttons are removed. Roster, history and member administration update automatically about every two minutes; catalog and full auction snapshots about every three minutes, with up to 15% jitter. Returning to a section, visibility/focus, reconnecting, and relevant mutation events trigger revalidation. Hidden views/offline tabs pause requests. Wake events have a 15-second cooldown, per-view requests cannot overlap, and failures retry after 15 seconds with exponential backoff capped at ten minutes. Existing content and drafts remain visible. Old in-flight responses are discarded after a mutation or session change.
- A separate fast session endpoint populates the shell without waiting for Google Sheets; session identity is refreshed on return and periodically. Server authorization remains authoritative.

### 6.2 Active toon leaderboard

- Shows only roster toons linked to approved users, not every row in the Sheet.
- Toons are grouped/sorted by the configured role order: Ranger, DPS Rogue, Fire Mage, Ice Mage, Support Druid, DPS Druid, Support Rogue, DPS Warrior, Tank. Unrecognized roles follow in case-insensitive alphabetical order.
- Within each role, higher Available DKP sorts first, then owner and account/owner alphabetically (case-insensitive).
- A rank counter restarts within each role. The top toon in each role receives the highlighted first-place style.
- Columns are toon/account name, role, owner, lifetime earned, lifetime spent, available DKP, and rank on wider screens. Rank is hidden below the medium breakpoint; owner, earned, and spent are hidden below the large breakpoint. Available remains prominent at narrower sizes.
- Search matches approved member nickname, sheet owner, toon/account name, or subclass/role, case-insensitively.
- Initial loads use a shared skeleton; refreshing preserves the existing table. Empty search results remain explicit. Search uses deferred updates to keep input responsive, and negative available balances are styled distinctly.
- If the account has no linked roster rows, its toons do not appear in this leaderboard.

### 6.3 Boss attendance DKP distribution

- Chiefs, Generals, and Guardians can open the kill-recording picker from Overview. Other roles see an explanation that the operation is restricted.
- The boss list and award values are fixed:

| Boss | Award per selected toon |
|---|---:|
| Base | 1 DKP |
| Prime | 2 DKP |
| Bt | 5 DKP |
| Gele | 6 DKP |
| Dino | 7 DKP |
| Crom | 12 DKP |

Tier labels are not displayed. Legacy is an auction item type, not a new boss award.

- The dialog lets a manager search every roster toon by owner, account, or class, select/deselect multiple rows, see selected toon chips and a selected count, and choose the boss.
- The dialog defaults to Base. Submission is disabled until at least one toon is selected. The client also rejects an empty selection with a message.
- The search field receives focus when the dialog opens. The dialog can be closed by its close button, Cancel, or clicking the backdrop; these close controls are disabled while an award is being submitted. Closing without submitting preserves the selected toons and boss choice if the dialog is reopened. After a successful award, selected toons and search text reset, while the selected boss remains selected.
- Empty-selection and server errors appear inline. During submission the native dialog traps focus, cannot be dismissed, and displays an applying state. Escape/backdrop/close dismiss the idle dialog and restore focus to its opener.
- The server validates the boss name, a UUID v4 `requestId`, unique integer row indices within 3 through 1000, at least one selection, and that every selected row still exists in a fresh roster.
- The client retains the same request ID for retries of the same submission. The server binds it to the boss and sorted row selection. An identical completed request returns success without granting points twice; reusing that ID for a different award returns a conflict. The award's deterministic MongoDB object ID also enforces uniqueness through the default database index.
- The server first creates a pending boss award record, then records an immutable, authorized sheet mutation before changing points. A timeout or persistence failure leaves the award pending for recovery with the original request ID; it does not invite a second grant. After the journaled change completes, the award becomes applied.
- A successful action shows the response message, clears the selection, closes the dialog, resets its search, and reloads dashboard data.
- A current-week award adds points to Sheet D (Weekly Earned) and Sheet I (Five-week activity). The ledger evaluates the award's occurrence time after acquiring its lock. If recovery crosses a Sunday boundary after rollover, it credits the original completed week through Lifetime Earned and Available and corrects retained activity rather than placing the award in the new week's Weekly Earned.
- Boss history stores the boss, points, participant row/owner/account identities, creator, request ID and fingerprint, recovery state, and timestamps. Applied records are the source for weekly auction activity calculations. Duplicate legacy participant entries in one award contribute at most once per resolved roster row.

## 7. Boss history and attendance correction

- The Kill history workspace view and `/admin/boss-history` show boss awards newest first. All approved roles can read the history; only Chief, General, and Guardian can edit it.
- Each entry shows boss name, points per toon, status, recorded time, creator, optional last editor, participant count, and participant names (account, falling back to owner).
- Pending, failed, and updating records remain visible. Safe recovery messages are shown; raw legacy provider errors are suppressed. Applied records offer edit and delete controls. Recoverable pending/updating records offer Resume controls, using the stored original request and target selection.
- A manager can edit an applied award’s attendance by selecting any currently existing roster rows, including clearing all attendees. The page displays the roster as checkboxes and a selected count.
- Adding a participant applies the award's points; removing a participant reverses them. An atomic transition from applied to updating stores the complete pending operation: request ID, request fingerprint, edit/delete kind, target participant identities, and initiating editor. An interrupted operation remains recoverable; a different request cannot overwrite it.
- Every edit/delete needs its own UUID v4 request ID, retained through retries. Completed request IDs and fingerprints stay with the award. Replaying an earlier completed edit after a later edit returns its completion without applying that earlier edit again. Reusing an ID with a changed payload returns a conflict.
- Participant identities resolve by normalized owner/account together with the saved row when it still matches, or by a unique matching identity if the row moved. Missing or ambiguous identities block edits/deletion. Duplicate identities are kept distinct by their resolved rows when those original rows still match.
- If the award was created during the current DKP week, correction changes Weekly Earned and Five-week activity. Older award corrections change Lifetime Earned and Available. If its completed week is still one of the five retained buckets, the correction also updates that bucket and Sheet I, so the next rollover preserves the correction. Older weeks never reenter rolling activity. The current week begins Sunday at midnight in `America/New_York`.
- Before saving attendance removals or deleting a kill, the UI requires confirmation. A reduction cannot put Available below remaining auction reservations, or below zero when there are no reservations.
- Deleting an award reverses its attendance DKP and retains a deleted tombstone with completed request keys. The ordinary history omits that tombstone. A retry after an uncertain response completes the original operation without reversing points twice.
- Chiefs and Generals may resume another staff member's pending grant. A Guardian can resume their own grant. Any history manager may resume a stored edit or deletion. Legacy failed records or updating records without a recoverable pending operation require manager investigation.
- Boss award records have a MongoDB TTL index for approximately one year. The implementation does not define a separate archive/export screen.

## 8. Auction house

### 8.1 Browsing and data shown

- Every approved user can view auctions. Chief, General and Guardian also see saved-item choices for posting.
- Auction cards show item name, poster, posting time in the browser’s local time, one or more item images, boss type, eligible role(s), state, and remaining time while live.
- The leading bid shows the bid amount and leading toon name. The current user is told when their own bid is leading. The UI does not present a complete sequence of previous bids.
- Active auctions are highlighted. At 30 seconds or less the countdown receives an urgent style.
- The screen has Live and All history views; All history is fetched on demand. It also offers text search over item, poster, winner/bidder nickname, owner, and account; role, boss, and winner/holder filters; and a clear-filters action.
- The initial API response includes up to the 100 most recent auction records plus relevant pending delivery tasks, no-bid tasks, recent wins by the current user, and recent completed wins. The All history query returns all auction records. The history is not paginated in the UI.
- A follow-up panel exposes actions for deliveries awaiting confirmation and no-bid auctions awaiting a poster decision. A separate “Items you won” panel shows the current user’s completed wins, the item boss type, mail state, and DKP deduction.
- Catalog images are loaded lazily when near the viewport. Multi-image items have previous/next controls and an image counter. Image failure displays an unavailable state.
- Catalog names are unique, ignoring case, among listed items only. Removing an item archives its record and images so existing auctions retain their history; its name can be used for a new catalog item with a new ID.

### 8.2 Auction posting

- Chiefs, Generals, and Guardians can post an auction. Clansmen see a restricted-access notice.
- Posting selects a previously saved catalog item. New items must first be created from the Items section.
- The item must have one or two supported eligible subroles, or Everyone on its own. The UI disables posting if the selection is invalid; the server validates the current catalog selection inside the posting transaction.
- Posting snapshots the item name, boss type, and role(s) onto a new auction record, records the poster, and sets the initial end time to **24 hours** after posting. Existing active records keep their stored deadlines. Legacy Base/Prime catalog boss labels normalize to Prot when posting; unknown labels produce a specific catalog correction error.
- The item selector searches catalog item names and initially displays 40 matches, with a Show more control adding 40 at a time. The selected item and its roles/type are shown before submission.
- Successful posting closes the form, shows a confirmation, and refreshes auction data.

### 8.3 Bid eligibility, bid amounts, and reservations

- Any approved user may bid if they have at least one linked toon matching one of the auction’s allowed subroles and meet the weekly DKP check. Everyone items allow any linked toon; balance, reservation and other bidding checks still apply.
- The weekly DKP check sums qualifying applied boss-award points for all of the user’s linked toons over the previous completed Sunday-to-Sunday week. The configured minimum is **0 DKP**, so a zero or positive total passes; a negative total does not.
- A bid must be a positive safe whole-number amount, exceed the current leading bid, use one of the bidder’s own linked toons, match an allowed role, and not exceed that toon’s available DKP.
- If one linked toon is eligible, it is selected automatically and shown. If several are eligible, the bidder chooses one. The input’s minimum is current bid + 1 (or 1 when there is no bid), and its maximum reflects available DKP after holds across auctions.
- A bid reserves points in a MongoDB hold record. It does not deduct the sheet balance immediately. The leading reservation is released when outbid; a new reservation is added to the new leading toon. Existing reservations across other auctions reduce that toon’s maximum bid.
- The server rechecks auction status, bid order, toon ownership, role, current roster, available balance, and holds inside a MongoDB transaction. Concurrent higher bids cause the stale bid to fail and ask the user to refresh.
- The only bid persisted on the auction is the current leading bid (and ultimately the winner); a full outbid history is not stored by this model.
- A bid arriving in the final **five minutes** leaves five minutes on the clock from that accepted bid. Earlier bids preserve the existing deadline. Repeated late bids can extend the auction repeatedly; expired auctions cannot accept bids.
- After a successful bid, the user sees a confirmation; the bid box clears and the auction data refreshes. If a bid fails, an error is shown and a refresh is attempted.

### 8.4 Auction closing, settlement, and delivery

- Auction API requests schedule expiry settlement using Next `after()`, allowing a read to return before Google Sheets settlement completes. Sweeps process at most 25 expiries, have a 45-second work deadline and a two-second per-process scheduling throttle. Transient failures retry after a 30-second delay; deterministic integrity failures pause for verified review. An authenticated daily cron invokes the same worker at 05:05 UTC when there is no traffic; Hobby scheduling is flexible within one hour.
- An expired auction with no leading bid becomes completed with no delivery requirement. Its poster can mark the item as mailed to the bank or repost it for a new **24-hour** auction. A repost creates a new auction record; the old record remains in history.
- An expired auction with a leading bid deducts the winning amount from Weekly Spent, Lifetime Spent, and Available (Sheet E, G, H), consumes the matching hold, marks the winning bid as winner, and creates a pending delivery task.
- DKP settlement uses an idempotent mutation key per auction and stored settlement attempt/lease state to support recovery from interrupted updates. A legacy/interrupted settlement lacking a replay marker can be flagged for manual review rather than automatically replayed.
- The poster or a Chief, General, or Guardian can mark a pending winner delivery as done. The record stores who confirmed it and when. DKP is deducted at auction settlement, not at mail confirmation.
- The stable-ID poster resolves no-bid auctions by choosing Mail to bank or Repost. Chief/General can recover legacy records lacking a stable creator ID. Nickname reuse does not establish ownership. Resolution is transactional, requires confirmation, and stores actor/time.
- Open auction removal is allowed for Chief and General for any open auction, and for a Guardian only for their own. Removal releases the leading bid’s reservation and deletes the open auction record. Ended auctions cannot be removed this way and remain in history.
- Eligible users see a Close control: Chief, stable-ID poster, or General closing a Guardian-posted auction. Closing stops further bids and schedules settlement. The screen says Finalizing while expiry/settlement is unconfirmed rather than declaring a winner prematurely.
- Chief/General can retry a failed settlement only when a prior tracked attempt/applied marker permits safe replay. Unknown legacy charge state cannot be retried through the UI without reconciliation. This action retains the same settlement idempotency key.
- Settlement errors are displayed on the auction card. A settlement requiring manual review is visually labeled Review.

### 8.5 Auction live refresh and cache

- The client ticks the displayed countdown once per second.
- While the view is visible, lightweight bid/state polling occurs every 30–35 seconds with jitter. When there are no active, settling or failed auctions, idle compact polls are throttled to once per five minutes. Compact polls do not overlap.
- Complete roster/catalog/auction snapshots refresh automatically on entry, about every three minutes while visible, on focus/return/reconnect with a 15-second cooldown, and after relevant mutations. Errors trigger bounded retry backoff; initial failures recover automatically. There is no manual Refresh auctions button.
- Poll responses carry per-auction version tokens; unchanged data can return without a full response. Poll failures leave the last known state visible and are retried on subsequent polling.
- Private snapshots remain in tab memory for up to five minutes and are revalidated on entry. No personal auction cache is persisted to session storage; legacy cache entries are cleared at logout. Session-generation guards discard results from a previous account. Returning to a visited tab preserves content during its refresh.
- Compact updates refresh the current user’s full holds/balances when their leading bid, bid version or auction status changes. Pending/expired/settling auctions continue polling; hidden tabs stop their frequent work. Bidding is disabled until the view has a confirmed refresh and while syncing; server balance checks still decide acceptance.
- Auction API responses used for live refresh specify `Cache-Control: no-store`.

### 8.6 UI action details

- The post form is collapsed by default and can be opened/closed by managers. Its selected item is cleared only by the explicit clear control; closing the form does not itself post an auction.
- Auction follow-up and Items You Won are expandable panels. Follow-up displays only work the current user can perform; a manager sees the panel even when its task count is zero.
- Removing an auction uses a browser confirmation that explains the leading reservation will be released and ended auctions remain in history. Closing early uses a confirmation that names the leading toon/price, or explains the no-bid resolution choices. No-bid bank/repost choices also require confirmation.
- Confirming delivery does not use a separate confirmation prompt. It records an operational mail status only; the winning DKP has already been deducted.
- The All history tab fetches the complete archive on first selection and offers retry after a failed fetch. Search and filters apply to the loaded data; clearing filters resets the search and role, boss, and holder selections.
- The component optimistically updates the high bid or early-close timer after a successful action, then reloads canonical data from the API.

## 9. Saved item catalog and image handling

### 9.1 Catalog controls

- Catalog access is limited to Chief, General, and Guardian.
- Item fields are name, allowed role(s), boss type, and one or more images.
- Name is trimmed and must contain 1–120 characters. Names are unique with case-insensitive English collation.
- One or two subroles must be selected from Ranger, DPS Rogue, Fire Mage, Ice Mage, Support Druid, DPS Druid, Support Rogue, DPS Warrior and Tank. Everyone is an exclusive alternative. Selection cards show each class icon and a checked state; other roster strings are not offered as item choices. Role matching normalizes whitespace and letter case. Duplicate normalized roles are collapsed.
- Boss type must be Prot, Bt, Gele, Dino, Crom, or Legacy. Prot groups Base and Prime; the UI label is “Prot (Base / Prime)”. Unassigned is a stored compatibility value but cannot be used to create or update catalog items.
- Catalog search filters item names. Items are sorted alphabetically. Each item can be edited in place and removed after confirmation.
- New-item and individual edit forms expand on demand from compact previews, avoiding rendering every image crop/role editor on initial load. The add form starts collapsed.
- Updating an item without uploading images preserves existing images. Uploading replacement images replaces the item’s entire image set.
- Replacement images use the same crop flow as new images. Items with unsupported saved subroles must be assigned supported choices before saving or posting; the editor shows a correction message. Existing auction eligibility is snapshotted separately from catalog edits.
- Removing an item is a soft removal (`isListed=false`): it disappears from the catalog and new auction choices, but existing auction history is kept.

### 9.2 Image selection, crop, compression, storage, and delivery

- The browser accepts PNG, JPEG, and WebP files. The upload flow crops each image to a square with drag-to-position and 1×–3× zoom (0.05 increments), then produces a 768×768 WebP crop.
- New catalog items require at least one image. A maximum of eight images may be selected per item.
- Browser-side preparation rejects source images above 40 million pixels and compresses images to WebP, trying long-side widths from 1200 down to 700. Each client-prepared file must be at most 256 KB, and the combined prepared upload must be at most 2 MB.
- The server independently validates PNG/JPEG/WebP file signatures against MIME type, permits no more than eight files, requires each submitted file to be nonempty and at most 1 MB, and requires total submitted bytes no more than 2 MB.
- The server rotates/resizes and converts to WebP, attempting widths 1000, 900, 800, 700, and 600 at decreasing quality. Each stored image must be no more than 75 KB; stored item images together must be no more than 150 KB. Images that cannot meet the limit are rejected.
- Image bytes and content type are stored in MongoDB. Authenticated image retrieval sends an ETag, exact length, nosniff and private browser caching (60 seconds with revalidation); matching conditional requests can return 304. Native lazy image loading avoids repeated fetch/blob/decode work.
- Crop dialogs trap focus, support Escape and arrow-key movement, preserve image bounds, and respect reduced motion. Server requests are size-bounded before multipart decoding, independently of client limits.
- Item images are requested only by signed-in users. A missing ID, invalid index, missing item, missing image, processing error, and image decoding error each produce an error state.

## 10. Administration and access management

### 10.1 Page sections and data

- Only Chief and General can load `/admin/requests` data or execute its API actions.
- The page has Sign-up requests, Members, and Activity log sections. Badge counts display pending requests, approved members, and audit events loaded (up to 100).
- The shared sidebar Roster link returns to the dashboard. A non-manager sees a manager-access-required message and a dashboard button; an unauthenticated user is sent to login. Member data revalidates automatically; its former Refresh members button is removed.

### 10.2 Pending requests

- Pending sign-ups are sorted oldest first.
- Each request displays the nickname, pending state, a searchable selector of unlinked roster rows, selected-toon count, Approve, and Deny controls.
- Approve is disabled while that account is being processed and requires at least one toon; successful approval sets the account to approved and links the selected rows.
- Deny deletes the pending account. There is no confirmation dialog in the current UI.

### 10.3 Approved accounts, toon links, and removal

- Approved accounts are sorted by nickname and display role and linked-toon count.
- Linked toons display account/owner and have an individual unlink button. Unlink requires confirmation and makes the row available for reassignment.
- Manage linked toons expands a searchable selection list showing unoccupied rows plus rows already linked to that member. Saving links requires at least one selection.
- The selector updates toons as a set, so saving can replace the member’s current set with the selected available/current rows.
- Removing a member account requires confirmation and deletes only approved Guardian or Clansman accounts. Chief and General accounts cannot be removed by this action. Removal does not mutate the Google Sheet roster rows.
- Toon unlink/replacement is blocked while removed identities or their old/current rows have outstanding reservations or pending deliveries. Newly assigned identities cannot adopt orphaned or unidentified legacy reservations; those require reconciliation. Refreshing row metadata for unchanged identities remains allowed. Removal is blocked while the member has open auctions, reserved bids, unresolved no-bid items, or pending deliveries. Resolve those tasks first; removal revokes server sessions atomically with the account deletion.
- Every account mutation rechecks the current actor/target inside a serialized MongoDB transaction. The same administration fence coordinates role/link changes with auction authorization and new financial journal plans, preventing stale page state from granting permission.

### 10.4 Role hierarchy controls

- Role order for promotion/demotion is Chief → General → Guardian → Clansman.
- A user cannot change their own role.
- A Chief can set another account to any of the four roles, subject to the final-Chief protection and valid-role check. Promote and Demote open a rank dialog with icon cards, permission summaries, current-rank labeling, change preview and explicit Save. Unavailable ranks are disabled. The same shared permission rules drive the dialog and server authorization.
- A General can only promote a Clansman to Guardian or demote a Guardian to Clansman. A General cannot manage Chief or General targets.
- The last approved Chief cannot be demoted. Role changes require a confirmation dialog.
- A successful promotion/demotion is stored with actor ID/nickname/role, target ID/nickname, old/new role, and timestamp in the clan audit log in the same MongoDB transaction as the role update.

### 10.5 Activity log

- The page shows the newest 100 role promotions, demotions, and member removals.
- Entries include target, event, previous/new role where applicable, actor nickname and role, and localized date/time.
- Account approval/denial, toon linking/unlinking, DKP awards, item catalog edits, auction posts, and bids are not included in this activity log.

### 10.6 Monthly toon role changes

- Every approved member can request the other subrole for a toon linked to their account; the main class cannot change. Allowed switches are Fire Mage/Ice Mage, Support Druid/DPS Druid, DPS Warrior/Tank, and DPS Rogue/Support Rogue. Ranger has no switch because it has only one subrole. The request UI offers one switch button for each eligible toon. Requests remain pending until a General approves or denies them. Only General accounts can approve or deny; Generals can review the full roster queue. Members can cancel their own pending requests or upcoming approved changes, and Generals can cancel any.
- The five main-role groups are Ranger (Ranger), Druid (Support Druid, DPS Druid), Warrior (Tank, DPS Warrior), Rogue (DPS Rogue, Support Rogue), and Mage (Fire Mage, Ice Mage).
- An approved subclass takes effect at 12:00 AM fixed EST (UTC−05:00, without daylight-saving adjustment) on the next month's first day. Until then, auction eligibility uses the current subclass; once effective, bid eligibility uses only the approved subclass. This is evaluated by the server at bid time and requires no rollover job.
- Pending requests expire at the next first-of-month cutoff if no General has decided them; they are removed from the active review queue and cannot be approved after the cutoff. Approved schedules and pending requests are visible to the toon’s linked member; Generals see all roster statuses and the review queue.
- Members may cancel their own pending requests or upcoming approved changes. Generals may cancel any pending or upcoming approved request.
- The workspace shows current, pending, and approved roles, effective dates, and the latest 100 role-change actions. Request, approval, denial, cancellation, and expiration records include toon identity, previous/requested roles, effective date where relevant, actor ID/nickname/role, and timestamp. The durable activity collection has no retention TTL.
- Removing a toon clears its active role override and schedule; its historical role-change audit entries remain.

## 11. DKP accounting, weekly cycle, and consistency rules

### 11.1 Sheet writes

- Current-week boss award (`weekly-earned` mode): add points to D and I. The occurrence timestamp is checked inside the ledger lock so a request crossing rollover is credited to its original week.
- Auction spend (`auction-spend` mode): subtract the negative adjustment from E/G and add that negative adjustment to H; in practical terms, increase Weekly Spent and Lifetime Spent and reduce Available by the winning price.
- Lifetime balance corrections (`balance` mode): add/subtract from F and H. Historical boss attendance corrections also update I and their retained completed-week bucket when applicable.
- Non-weekly negative adjustments must not reduce Available below outstanding held auction DKP, except for the explicitly consumed reservation during auction settlement. Weekly-earned corrections do not use the hold-floor check.
- A mutation validates integer rows 3 through 1000, finite points and source balances, safe numeric results, target existence, and the expected owner/account identity. Multiple adjustments to the same row are combined; conflicting identities for one row are rejected.
- Held amounts and explicitly consumed reservations must be finite and nonnegative; a consumed reservation cannot exceed the recorded hold. Nonfinite Available or hold values cannot pass bid affordability checks. Moved or unverified outstanding holds stop affected debits until a manager reconciles them.
- Multi-cell numeric updates use Google Sheets batch update with `RAW` input mode. Financial reads use unformatted values. Spreadsheet locale, display rounding, and formula interpretation do not determine the amount being written.
- Every nonempty point adjustment first stores a durable pending MongoDB mutation, including its unique operation key, request fingerprint, exact numeric before/after cells, and affected row identities. Staff-created plans also retain the authorizing user's ID. The same operation key cannot apply different point instructions.
- Before a staff award/correction plan commits, the current actor must still be approved and hold Chief, General, or Guardian authority. That authorization check and journal creation share the clan administration transaction fence with role changes. No Google request runs inside that database transaction. Committing the immutable plan accepts the financial action; later recovery may finish that accepted action after a subsequent role change.

### 11.2 Week rollover

- DKP weeks begin Sunday at midnight in `America/New_York`, with daylight-saving changes respected.
- The first activation initializes the weekly cycle without transferring the current week’s points; the first transfer happens at the next Sunday boundary.
- On each later rollover, for roster rows with activity, Weekly Earned moves into Lifetime Earned and Available. Weekly Earned and Weekly Spent reset to zero for every roster row. The Five-week activity field becomes the sum of up to the latest five weekly activity buckets.
- The oldest activity week falls off after five Sunday rollovers. A preexisting Five-week activity value is retained as one legacy bucket until it ages out.
- If multiple Sunday boundaries were missed, the elapsed calendar weeks are counted with daylight-saving changes respected. The stored weekly earnings transfer into lifetime balances once; empty missed weeks age the activity buckets so stale activity does not remain indefinitely.
- Before planning a rollover, the server checks that its resulting Available balances still cover outstanding auction reservations. Invalid or inconsistent holds stop the rollover for review.
- Weekly reset uses the shared spreadsheet ledger lock and a stored pending plan with exact before/after values and row identities. It is checked on relevant Sheet reads/writes and by an authenticated daily hosting cron at 05:00 UTC. The worker applies a reset only when the Sunday boundary is due; process startup does not schedule financial work. Preview deployments cannot access the shared database or Sheet. `DKP_WRITES_PAUSED=true` pauses financial writes for coordinated manual Sheet maintenance; allow in-flight operations to finish before editing directly.

### 11.3 Locking, retries, and reconciliation

- All point writes, rollover plans, pending replay, and new auction reservations share one spreadsheet ledger lock. Its lease is 120 seconds; a contender waits up to 30 seconds and polls every 250 ms. The owner renews the lease every 30 seconds and verifies ownership around financial work. Google API requests time out after 20 seconds.
- Recovery first verifies the original row identities, then compares all affected cells against the saved before/after values. A complete before state permits the original absolute write; a complete after state marks it applied without writing again. Mixed states, unrelated changes, missing snapshots, and moved identities stop further ledger work for manager reconciliation.
- A journaled correction restores its recorded activity history together with completion. A pending rollover restores its recorded activity history and cycle marker, clears the pending plan, and invalidates the roster cache. Point mutations invalidate the cache after completion.
- Existing interrupted operations created by older code without sufficient identity/before-value snapshots are blocked rather than guessed. The application does not yet provide a dedicated reconciliation screen for those legacy operations.
- MongoDB and Google Sheets do not share one atomic transaction. Direct external sheet edits during an in-flight write remain an operational limit; use the application's mutation flow and reconcile detected drift before resuming. The before/after checks cannot identify an external edit that exactly reproduces one of those recorded states.

## 12. Data stored by the application

The implementation uses MongoDB/Mongoose for:

- **Users**: nickname, bcrypt password hash, role, approval status, legacy sheet owner, linked sheet row identities, creation time.
- **Authentication sessions**: hashed random token, user ID, creation time, explicit expiry and TTL cleanup.
- **Authentication rate limits**: hashed account/proxy identities, fixed-window counters and TTL expiry. Raw passwords and cookie tokens are not stored here.
- **Administration state**: transaction revision fence and one-time bootstrap claim.
- **Roster cache**: spreadsheet-keyed roster values including five-week activity, fetch time, generation, refresh lock/error, weekly reset marker, renewable ledger lease/owner token, rolling activity history, and pending reset plan with exact cells, before-values, identities, next history, and cycle marker.
- **DKP sheet mutations**: spreadsheet ID, unique operation key, optional authorizing actor user ID, immutable request fingerprint, pending/applied status, exact sheet before/after cells, participant identities, optional corrected activity-history snapshot, and timestamps. No automatic journal TTL is defined.
- **Boss awards**: boss, points, participant row/owner/account identities, creator/editor, original request ID/fingerprint, completed edit/delete request IDs and fingerprints, pending operation with target identities/editor/kind, pending/applied/failed/updating/deleted status, safe failure reason, and timestamps. Deleted records serve as retry tombstones and are omitted from normal history. TTL remains approximately 365 days.
- **Auction holds**: unique row index and points reserved for current high bids.
- **Auction items**: unique name, roles, boss type, image bytes/content types, image count, listing status, creator, creation time.
- **Auctions**: item snapshot, roles/type, creator, end time, current high bid/winner, status, bid version, delivery tracking, settlement attempt/lease/error/manual-review state, timestamps.
- **Clan audit events**: role changes and member removals, actor and target details, timestamp. Read endpoint returns 100 latest events; no retention TTL is specified.
- **Toon role changes**: stable toon identity, active subclass override, optional scheduled subclass/effective date, and last actor.
- **Toon role change requests**: requester and toon identities, current/requested subclass, next monthly cutoff, pending/approved/denied/cancelled/expired/applied status, optional General decision identity, and timestamps.
- **Toon role-change audit**: request/approval/denial/cancellation/expiration action, toon identity, role details, effective date, actor ID/nickname/role, and timestamp. The workspace returns the 100 latest entries; no retention TTL is specified.

The roster’s authoritative DKP values remain in Google Sheets. MongoDB stores application identities, auction state, award records, reservations, caches, and replay/audit support.

## 13. Nonfunctional requirements and observed quality attributes

### 13.1 Security and access control

- All roster, history, admin, auction, catalog, and image data APIs require a valid approved-user session except sign-up/sign-in.
- Authorization is enforced in API handlers, not only by hiding buttons. Chief/General-only member administration and manager-role DKP/item/history actions are checked server-side.
- Passwords are stored as bcrypt hashes, not plaintext. Session cookies are HttpOnly and production cookies are Secure.
- User input is validated server-side for roles, object IDs, sheet rows, item values, image signatures, bid integer ranges, and auction state transitions.
- Auction bid/reservation changes and several account/auction mutations use MongoDB transactions. The production MongoDB deployment therefore needs transaction support for those operations.
- Google Sheets write operations validate row identity immediately before applying a balance change to reduce the chance of writing to a moved/reused row.
- Authentication uses revocable random server sessions and strict production cookies. Public first-Chief creation requires a private one-time setup code. New credentials are bounded/normalized and durable rate limits protect sign-up/sign-in.
- Every mutation checks exact origin or same-origin browser metadata; trusted deployment origin can be configured explicitly. JSON and multipart bodies are bounded before parsing. Query-shaped authentication values are rejected.
- Response policy includes CSP, frame denial, nosniff, referrer and permission restrictions, and HSTS in production. CSP permits Next’s inline scripts; this is defense in depth, not a claim of a fully nonce-based policy.
- Password reset, MFA, and a user-facing device/session-management screen remain unimplemented.

### 13.2 Availability, reliability, and consistency

- Roster cache fallback keeps ordinary reads usable during temporary Google Sheets issues; write actions still require a fresh sheet read.
- Read retries, refresh locks, reset locks, generation checks, pending reset plans, and idempotency records coordinate transient failures and concurrent work.
- Auction reservations prevent the same available points from being promised across multiple auctions. Server-side transactions protect the current bid and hold updates from competing requests.
- Settlement records distinguish active, settling, failed, and completed states; recoverable attempts use leases and replay keys, while ambiguous legacy attempts are marked for manual review.
- Google Sheets and MongoDB are both required for core features. No explicit uptime SLA, backup cadence, disaster recovery target, or recovery time objective is stated in the project.

### 13.3 Performance and freshness

- Roster snapshots are reused for up to 30 seconds; live auction state polls every 30 seconds and the full catalog/roster refreshes every 15 minutes while visible.
- Auction image requests are lazy-loaded near the viewport and images are compressed before MongoDB storage.
- The item picker batches visibility in groups of 40; catalog and auction history have search/filter controls.
- The roster sheet range is capped at rows 3–1000. The UI does not paginate the leaderboard or full auction history.
- No measured response-time or concurrency target is specified.

### 13.4 Usability, responsiveness, and accessibility

- Visual system is a dark, high-contrast interface using indigo/violet actions and distinct status colors. Global metadata title is `Centuri DKP — Celtic Heroes`, description is `Clan DKP Management System for Centuri`, and document language is English.
- Layouts use responsive breakpoints, scrollable tab/navigation areas, adaptive tables, touch-friendly controls, dialogs for DKP distribution and image cropping, and visible loading/empty/error/success states.
- Native labels, table headers, buttons, fieldsets, dialog roles, tab roles, `aria-selected`, `aria-expanded`, status and alert roles, and explicit accessible labels are used in key controls.
- The global page uses a dark class, dark body colors, antialiasing, and indigo selection highlighting. A six-pixel indigo custom scrollbar style is defined for elements using the `custom-scrollbar` class.
- No conformance target (such as WCAG level), screen-reader/browser support matrix, keyboard-only acceptance criteria, or formal accessibility audit is specified.

### 13.5 Maintainability and runtime

- The site uses Next.js App Router, React, TypeScript, Tailwind CSS, Lucide, Mongoose, Google APIs, bcrypt, and Sharp. JWT dependencies and duplicated obsolete route implementations were removed.
- Package scripts include `dev`, `build`, `start`, `test`, and `typecheck`.
- Required service configuration is `MONGODB_URI`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`. New installation bootstrap additionally needs private `CLAN_BOOTSTRAP_TOKEN`. Optional `APP_ORIGIN` handles a canonical proxy origin; `TRUST_PROXY` explicitly enables trusted IP throttles. `JWT_SECRET` is no longer used. `.env.example` documents the setup.
- No deployment platform, browser support floor, localization policy beyond English labels/local browser dates, or formal operational monitoring requirement is specified.

## 14. Errors, confirmations, and empty states

- Sign-in/sign-up displays server errors and success/pending messages.
- Dashboard and admin pages show loading states; roster sync failures show a status plus an error message.
- Distribution, auction, catalog, boss-history, and admin actions show inline errors or success notices; destructive actions retain confirmation dialogs. Financial failures offer the original-operation recovery flow where safe.
- Relevant empty states include no roster records, no matching toons, no unlinked toons, no pending requests, no approved accounts, no audit events, no boss awards, no saved items, no matching items, no auctions, no live auctions, and no matching auction filters.
- Auction failures include stale bid, ended auction, insufficient available DKP, invalid role, removed roster row, missing reservation, failed settlement, and delivery already completed states.
- Shared loading and error boundaries provide navigation placeholders and recovery. There is no centralized notification inbox.

## 15. Implementation gaps and rules not defined by the code

The security/UI refresh resolves the former logout, early-close, credential-validation, and replay gaps. Remaining limits are:

1. **External Sheet edits:** manual edits do not participate in the application’s transaction or lock. Identity/before/after snapshots detect unsafe recovery drift; an external edit during an in-flight Google request cannot be made atomic with MongoDB. Restrict direct Sheet write access operationally.
2. **Legacy interruption:** old pending operations without a trusted identity/value snapshot, moved or corrupt reservations, and unknown legacy charge state stop for verified reconciliation. The app cannot safely infer whether an untracked historical charge occurred.
3. **Real-world kill identity:** request IDs prevent accidental replay of the same submitted operation. Different request IDs do not prove that two staff submissions correspond to different real boss kills.
4. **Weekly auction threshold:** the configured minimum remains 0 DKP; zero or positive previous-week activity passes.
5. **Bid history:** only current lead and winner are stored; there is no complete bid timeline.
6. **Audit interface:** an internal durable point-write journal now exists, but there is no general ledger/reconciliation screen and direct external Sheet edits are not journaled. The clan activity page still covers only role changes/removals.
7. **Settlement scheduling:** application requests schedule background sweeps. An authenticated daily cron at 05:05 UTC provides a fallback without traffic; Vercel Hobby allows a flexible one-hour window. No worker guarantees settlement exactly at expiry. Reserved points remain protected until completion.
8. **Account recovery:** MFA, password reset, device management, and recovery of a deleted final administrator outside normal app rules remain owner-operated concerns.
9. **Operational targets and scale:** no SLA, capacity target, measured production response-time guarantee, or backup/restore policy is set. The roster scan ends at row 1000. Boss and full auction history use cursor pagination with 50 records per page.
10. **Business scope:** the application uses one configured clan spreadsheet. Multi-clan operation and the effect of external manual DKP edits on history-derived auction activity are not defined.

## 16. API request and validation details

This section records the server-side checks that sit behind the screen behavior above. Error responses generally use a JSON `{ "error": "..." }` body; successful mutations generally include `success: true` and, where relevant, a user-facing message.

### 16.1 Authentication

- `POST /api/auth` accepts a bounded JSON object with string `action`, `nickname`, and `password`. Invalid types, malformed JSON or invalid credentials shape return 400; incorrect media type returns 415 and bodies above 4 KiB return 413.
- Supported actions are `signup` and `signin`; another action returns HTTP 400.
- Duplicate normalized sign-up nickname returns 409; invalid sign-in credentials return 401; a pending account returns 403; throttling returns 429 and `Retry-After`. Fresh installation without a valid private setup code returns 503 with `needsSetup: true`; an already-claimed empty database requires owner recovery. Successful sign-in returns nickname/role and sets a revocable server-session cookie.
- `GET /api/auth/session` returns 401 when the token is absent, old, invalid, revoked or expired. On success it returns current identity plus linked row IDs resolved from the cached roster; those row IDs are shell metadata, not a fresh financial roster.
- `POST /api/auth/logout` validates origin, deletes the hashed current session, and expires the HttpOnly cookie. It is safe to call without a cookie. Database failures return an error, not false success.

### 16.2 Roster and boss awards

- `GET /api/dkp` requires an approved session. It returns the sheet roster, cache freshness metadata, approved users with their resolved linked toons, and the current user’s resolved linked rows.
- `POST /api/dkp` requires Chief, General, or Guardian and JSON `{ bossName, selectedRows, requestId }`. The boss must be recognized, `requestId` must be a UUID v4, and `selectedRows` must contain one or more unique integer rows within 3 through 1000. Invalid input or missing fresh roster rows returns 400; missing session returns 401; insufficient current role returns 403.
- An identical completed boss request returns success with `replayed: true`. A mismatched request fingerprint/creator, unsafe accounting condition, occupied ledger lock, or unresolvable recovery condition returns 409. Chiefs/Generals may resume another creator's pending grant; Guardians must own that grant. An ambiguous server failure returns a generic error instructing the caller to retry the original request ID.
- `GET /api/admin/boss-history` returns up to 50 nondeleted award records per cursor page to approved users, with `nextCursor` when more exist. Managers also receive the roster, safe failure messages, original grant request ID/row selection, and any `pendingChange` containing its request ID, edit/delete kind, and original target rows. Those fields let the UI resume interrupted work. Raw internal request fingerprints and completed-request arrays are not returned.
- `PATCH /api/admin/boss-history` requires `{ awardId, selectedRows, requestId }`; `DELETE` requires `{ awardId, requestId }`. Both require a 24-character hexadecimal object ID, UUID v4 request ID, and Chief/General/Guardian authority. PATCH accepts an empty participant array but rejects duplicate, noninteger, or out-of-range rows. Initial changes claim only applied records; a matching stored pending operation may be resumed. A missing award returns 404; a competing operation, changed reuse of a request ID, or unavailable legacy record returns 409.
- Staff mutations pass same-origin request checks and require an `application/json` object with a default 32 KiB maximum body. Invalid JSON/object shape returns 400, an oversized body returns 413, and another media type returns 415. The server revalidates the approved manager role when committing a new financial journal plan, atomically with administration changes.

### 16.3 Administration

- `GET /api/admin/requests` returns 401 without a valid session and 403 unless the current database role is Chief or General.
- `POST /api/admin/requests` accepts only `approve`, `deny`, `link`, `unlink`, `remove`, or `set-role`, with a valid MongoDB user ID. Unknown actions or malformed IDs return 400; a missing account returns 404.
- Approve applies only to pending users; deny applies only to pending users; link/unlink apply only to approved accounts; remove applies only to approved Guardian/Clansman accounts.
- Link and approve require one or more distinct integer sheet rows within 3–1000 and unique owner/toon identities in the fresh roster. Unlink requires exactly one currently linked row. Occupied rows, outstanding financial tasks, stale account state, and role conflicts return 409.
- `set-role` requires one of the four defined roles, an approved target other than the manager, and the manager-specific role rules in section 10. Repeating the current role or attempting to demote the last Chief is rejected.

### 16.4 Auctions and catalog

- `GET /api/auction` requires a session. `live=1` takes the lightweight version-token path; `includeArchive=1` returns up to 50 history records per cursor page with `nextCursor`. Normal snapshots include unresolved auctions even outside the latest-record window. Reads schedule expiry work after the response. Live removed IDs identify genuinely deleted records, not merely older history records.
- `POST /api/auction` requires bounded JSON and same-origin checks. Supported actions are create-auction, bid, resolve-no-bid, remove-auction, close-auction, mark-delivered, and guarded retry-settlement. Unknown actions return 400.
- `create-auction` additionally requires a UUID request ID. A transaction stores its permanent receipt and reads the current listed catalog item; an identical retry acknowledges the original auction even after that auction is deleted. Browser session storage retains opaque action IDs across reloads for auction posting and boss operations with identical inputs.
- Auction IDs and item IDs must be valid MongoDB object IDs. Bids require an integer row index and a positive safe integer amount. The server validates role, row ownership, current auction state, available DKP and reservations again, even when the UI already disables invalid inputs.
- Bid reservations share the financial ledger lock and administration transaction fence; they bind both row and normalized owner/toon identity. Staff authority for other auction/catalog mutations is re-read inside the administration transaction as well.
- `GET/POST/PATCH/DELETE /api/auction/items` require Chief, General, or Guardian. Create/update requires a trimmed 1–120 character name, a supported assigned boss type, and one or two supported subroles or Everyone alone. New items need at least one valid image; update may omit images to keep the existing image set. Duplicate names return HTTP 409; invalid fields/images return HTTP 400; missing item IDs/records return 400/404 as applicable.
- `GET /api/auction/image` requires a valid session, valid item ID, and nonnegative integer image index. Invalid IDs/indices return 400; missing item/image returns 404. Successful responses return image bytes rather than JSON.

The website’s client performs useful validation and disables many invalid controls, but the server checks above remain authoritative. The code does not define a formal OpenAPI schema or shared typed API contract.

## 17. Clan toon management

- Members & access has a **Clan toons** section for approved Chiefs and Generals. Guardians and Clansmen cannot read or mutate this management endpoint.
- The list searches toon name, owner, subrole and linked account, shows available DKP and linked accounts, and refreshes automatically while visible.
- Adding requires a toon name and owner of 1–80 characters, plus exactly one of the nine supported toon subroles. Everyone is an item-only eligibility option. Names reject control characters; Google writes use RAW input so names cannot become formulas.
- A duplicate live toon name, ignoring case, is rejected. A newly created toon has D–I explicitly set to numeric zero: weekly earned, weekly spent, all-time earned, all-time spent, available DKP and five-week activity. It remains unlinked even when its owner matches an old owner-wide account assignment; existing links are narrowed to explicit identities.
- Creation selects an unused row within 3–1000, excluding rows referenced by saved links, boss awards, historical bids, DKP journals and earlier roster operations. It does not shift other rows. Lack of safe capacity returns a conflict.
- Removal clears A–I in the selected roster row without shifting rows. It forfeits every DKP/activity value for that toon, including a nonzero available balance, and removes its account links. It does not delete the login account or other toons. The dialog shows the owner, linked accounts and balance, and requires an explicit permanent-forfeiture checkbox.
- Reserved bids, pending delivery, unfinished boss awards/attendance edits, ambiguous identities and unverified legacy reservations block the operation until resolved. No reservation is silently released. Completed auction and boss history remains intact.
- A removed owner/toon identity is permanently retired from app-created roster entries. An identity with an earlier roster lifecycle or retained award history cannot be recreated as brand new to inherit old award credit. Stale linking and boss-award requests are rejected for retired identities.
- Each mutation requires a UUID v4 request ID; actor-scoped browser session storage retains opaque retry IDs. A permanent MongoDB roster receipt records the authorized actor, request fingerprint, exact before/after row and planned link changes before writing to Sheets.
- Roster writes use the shared renewable DKP ledger lock and administration fence. Pending roster changes prevent conflicting administration mutations. Recovery accepts only the exact before or after Sheet state, finishes links, removes the retired activity bucket, invalidates the roster cache and writes one audit event in a MongoDB transaction. A mismatched external edit pauses recovery for reconciliation.
- Creation/removal audit entries identify the acting manager and toon/owner. Removal retains the six original DKP/activity values in the audit record. The interface shows available and weekly-earned DKP at removal.
- Interrupted changes can be completed with **Finish interrupted change** by a Chief or General. The next financial worker also recovers a staged change before starting new financial work. Direct Sheet edits still require coordinated maintenance; Google Sheets and MongoDB do not share one atomic transaction.
- Management reads permit 120 requests per member per minute; roster writes permit 20. Mutations require the same origin and bounded JSON, and respond with safe errors.

---

This specification describes current behavior. Any policy that is absent or marked as a gap requires a product decision before it can be treated as a guaranteed requirement.
