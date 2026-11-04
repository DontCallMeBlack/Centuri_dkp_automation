// Check history pagination against fixture APIs only; all live writes are blocked.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.PERF_ORIGIN || 'http://localhost:3105';
const id = value => value.toString(16).padStart(24, '0');
const user = { id: id(800), nickname: 'Dpro', role: 'chief', sheetRecordRows: [] };
const winner = { isMine: true, nickname: 'Winner owner', rowIndex: 3, owner: 'Winner owner', account: 'Healsbeast', amount: 10, placedAt: new Date().toISOString() };
const auction = (index, extra = {}) => ({
  id: id(index), itemId: id(900), itemName: `Item ${index}`, bossType: 'Gele', imageCount: 0,
  requiredRoles: ['Ranger'], createdBy: 'Dpro', isPoster: true, isWinner: true, canMarkDelivered: false,
  canRemove: false, canResolveNoBid: false, createdAt: new Date(Date.now() - index * 60_000).toISOString(),
  endsAt: new Date(Date.now() - 60_000).toISOString(), status: 'completed', biddingClosed: false,
  highBid: winner, winner, deliveryStatus: 'done', deliveredBy: 'Dpro', deliveredAt: new Date().toISOString(), ...extra,
});
const history = Array.from({ length: 55 }, (_, index) => auction(index + 1));
const live = auction(1000, { status: 'active', endsAt: new Date(Date.now() + 3_600_000).toISOString(), highBid: null, winner: null, isWinner: false, deliveryStatus: 'not-required' });
const pending = auction(1001, { deliveryStatus: 'pending', canMarkDelivered: true, deliveredBy: null, deliveredAt: null });

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const requests = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') return route.fulfill({ status: 400, json: { error: 'Live writes blocked' } });
        if (url.pathname === '/api/auction/image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
        let data;
        if (url.pathname === '/api/auth/session') data = { user };
        else if (url.pathname === '/api/dkp') data = { success: true, user, roster: [], clanMembers: [] };
        else if (url.pathname === '/api/auction') {
          if (url.searchParams.has('includeArchive')) {
            requests.push(url);
            const offset = Number(url.searchParams.get('cursor') || 0);
            data = { auctions: history.slice(offset, offset + 20), nextCursor: offset + 20 < history.length ? String(offset + 20) : null };
          } else data = { manager: true, weeklyEarnedTotal: 14, weeklyMinimum: 0, canBidWeekly: true,
            roles: ['Ranger'], toons: [], items: [], auctions: [live, pending],
            rosterSync: { fetchedAt: new Date().toISOString(), stale: false, refreshDelayed: false } };
        } else throw new Error('Unexpected API request: ' + url.pathname);
        return route.fulfill({ status: 200, json: data });
      });
      await page.goto(origin + '/dashboard?view=auction');
      const browse = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Browse auctions', exact: true }) });
      await browse.getByRole('button', { name: 'All history', exact: true }).waitFor();
      assert.equal(requests.length, 0, 'Opening live auctions does not read history');
      await browse.getByRole('button', { name: 'All history', exact: true }).click();
      await browse.getByText('20 history records loaded', { exact: true }).waitFor();
      assert.equal(await browse.locator('article').count(), 20, 'Live auctions and old delivery tasks do not expand the history page');
      assert.equal(requests.length, 1);
      await browse.getByText('Dpro mailed Item 1 to Healsbeast', { exact: true }).waitFor();
      await browse.getByRole('button', { name: 'Load older auctions', exact: true }).click();
      await browse.getByText('40 history records loaded', { exact: true }).waitFor();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].searchParams.get('cursor'), '20');
      await browse.getByRole('button', { name: /^Live / }).click();
      await browse.getByRole('button', { name: 'All history', exact: true }).click();
      await browse.getByText('40 history records loaded', { exact: true }).waitFor();
      assert.equal(requests.length, 2, 'Switching views reuses loaded history');
      await page.evaluate(() => window.dispatchEvent(new Event('centuri:dkp-changed')));
      await browse.getByText('20 history records loaded', { exact: true }).waitFor();
      assert.equal(requests.length, 3, 'Refresh requests only the latest page');
      assert.equal(requests[2].searchParams.has('cursor'), false);
      await page.getByRole('button', { name: /Items you won/ }).click();
      const wins = page.locator('#auction-won-items');
      await wins.locator('article').first().waitFor();
      assert.equal(await wins.locator('article').count(), 20);
      assert.equal(requests.length, 4);
      assert.equal(requests[3].searchParams.get('won'), '1');
      await wins.getByRole('button', { name: 'Load older wins', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('#auction-won-items article').length === 40);
      assert.equal(requests.length, 5);
      assert.deepEqual(errors, []);
      console.log(`${width}px: latest 20, explicit load more, no history prefetch, no older-page refresh loop, and personal wins passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
