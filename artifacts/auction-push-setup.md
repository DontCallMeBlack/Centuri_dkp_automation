# Auction push updates

Status: activated in Production on November 8, 2026. The restricted Ably key is stored as an encrypted Vercel Production secret. Deployment: https://vercel.com/dcmbs-projects/centuri-dkp-automation/43pry9qj4mpXmTxXr2HX25bFWNJA.

## Activate

1. Create a free Ably account and an app: https://ably.com/dashboard. No paid plan is needed for setup.
2. Create an API key restricted to the **publish** and **subscribe** capabilities on the exact channel `centuri:auction-changes`. Do not enable public/anonymous channel access.
3. Add the key to Vercel's project environment variables as **ABLY_API_KEY**, for Production. Keep the value private; do not put it in chat, a browser variable, source control, or a `NEXT_PUBLIC_` variable.
4. Deploy these changes after configuring the variable. Environment changes require a deployment. Use a separate Ably app/key for preview or development; otherwise those environments share auction notices.
5. Verify with two approved sessions: one places a legitimate bid, the other sees it within a few seconds without a manual refresh. Confirm a disconnected client still receives ordinary polling updates. Fixture tests deliberately do not place live bids.
6. Compare Vercel's function CPU and request counts over similar traffic and bidding periods. Check Ably's own usage limits too. Removing `ABLY_API_KEY` and redeploying restores the existing polling behavior.

## Behavior and security

- A successful auction mutation schedules a notification only after its transaction completes. Rejected bids do not publish. Settlement updates and bid promotions from transfers/wipes also notify viewers.
- Browsers connect directly to Ably's SSE endpoint. Vercel only issues a signed, subscribe-only, 15-minute JWT and publishes a small notice when an auction changes. No persistent Vercel function, broker SDK, or new npm dependency is needed.
- Notifications contain auction IDs only. Account names, DKP, bids, user IDs and session cookies are not sent to the broker. Existing authenticated API reads supply each viewer's current personalized permissions and bid state. A revoked subscription can receive these nonsensitive notices until its token expires, but cannot read auction data through the app API.
- Ably requires identified clients on this account. Viewer JWTs contain a stable HMAC pseudonym, rather than the app's raw user ID or nickname; the publisher uses a fixed server identity. This was verified against the live broker after an anonymous-client request returned error 40161.
- Known auctions use targeted version checks; new auctions and reconnects use discovery. Bursts coalesce into checks at most once every five seconds per open panel. Changes that affect the viewer's reservation trigger the existing full balance refresh.
- Hidden/offline tabs close their connection. Returning tabs reconcile state; logout clears the connection and credentials. Provider failure uses bounded reconnect attempts and the existing polling fallback. Publishing failure never turns an accepted bid into a failed HTTP response.
- While connected, empty final-window checks use a five-minute interval, with one-minute recovery after expiry to keep settlement moving. Disconnected/unconfigured clients retain the original one-minute final-window checks and hourly discovery. A connected client does not depend solely on notification delivery for correctness.

## Quality and CPU tradeoff

Normal delivery should display bids within seconds, versus up to one minute in the previous final-window polling flow. Push also updates auctions outside the final five minutes. It does not change bid priority, transaction locking, affordability checks, anti-snipe extensions, or settlement rules.

This removes many empty polling calls during quiet final windows. Active bidding also causes more timely authenticated reads, so very busy auctions can produce more reads than one-minute polling. The five-second burst limit controls fanout but is not a guarantee of a lower daily CPU total. No daily CPU reduction or clan capacity figure has been measured for this integration.

## Validation

- 372 automated tests passed, including token signatures/capabilities, origin/session checks, reconnect/renewal, visibility/offline/logout, burst coalescing, publish-after-commit and failed-bid behavior.
- TypeScript check and production build passed.
- [Browser fixture smoke](../scripts/auction-push-smoke.cjs) passed: changed bids, targeted reads, burst coalescing, personal balance refresh, auction removal and logout cleanup. Uses mocked broker messages and fixture APIs.
- Live Ably transport check passed: a signed, subscribe-only identified viewer connected through SSE, and received a change notice published using the restricted production key and identified publisher. The test contained no auction data and placed no bid. A real two-member bidding test was not performed.
- The final Vercel production deployment completed successfully with the identified-client correction; all 372 automated tests and the TypeScript check passed after the correction.

## References

- [Ably free package and current limits](https://ably.com/docs/platform/pricing/free)
- [Ably SSE API](https://ably.com/docs/api/sse)
- [Ably signed JWT authentication](https://ably.com/docs/auth/token/jwt)
