// Fixture-only browser test. No live bids, financial writes or broker credentials.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage();
    const errors = [], reads = [], writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__pushSources = [];
      window.EventSource = class {
        constructor(url) { this.url = url; this.closed = false; window.__pushSources.push(this); setTimeout(() => this.onopen?.(), 10); }
        close() { this.closed = true; }
      };
      window.__push = (ids) => window.__pushSources.filter((source) => !source.closed).forEach((source) => source.onmessage?.({ data: JSON.stringify({ auctionIds: ids }) }));
    });
    const user = { id: '1'.padStart(24, '0'), nickname: 'Push Member', role: 'clansman', sheetRecordRows: [3] };
    const auction = {
      id: '2'.padStart(24, '0'), itemId: '3'.padStart(24, '0'), itemName: 'Push test item', imageCount: 0,
      requiredRoles: ['Tank'], bossType: 'Bt', createdBy: 'Chief', isPoster: false, canRemove: false, isWinner: false,
      createdAt: new Date().toISOString(), endsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      biddingClosed: false, status: 'active', bidVersion: 1, deliveryStatus: 'not-required',
      highBid: { isMine: false, nickname: 'Other', rowIndex: 4, owner: 'Other', account: 'Other Toon', amount: 10, placedAt: new Date().toISOString() },
      winner: null, canMarkDelivered: false, canResolveNoBid: false, settlementError: null,
    };
    let auctions = [auction];
    let fullReads = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url());
      let body = {};
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (url.pathname === '/api/auth/session') body = { success: true, user };
      else if (url.pathname === '/api/auction/realtime') body = { token: 'fixture', channel: 'centuri:auction-changes', expiresAt: Date.now() + 900_000 };
      else if (url.pathname === '/api/auction') {
        reads.push(url.search);
        if (url.searchParams.get('live') === '1') body = { changed: true, auctions, removedIds: auctions.length ? [] : [auction.id] };
        else {
          fullReads++;
          body = { realtimeEnabled: true, manager: false, weeklyEarnedTotal: 0, weeklyMinimum: 10, canBidWeekly: false, roles: [], items: [], toons: [], auctions,
            rosterSync: { fetchedAt: new Date().toISOString(), stale: false, refreshDelayed: false } };
        }
      } else if (url.pathname === '/api/auction/items') body = { items: [], roles: [] };
      else if (url.pathname === '/api/dkp') body = { success: true, roster: [], bossActivity: [], clanMembers: [] };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto((process.env.PERF_ORIGIN || 'http://localhost:3101') + '/dashboard?view=auction');
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: auction.itemName }) });
    await card.locator('.auction-leading-bid').getByText('10 DKP', { exact: true }).waitFor();
    await page.waitForFunction(() => window.__pushSources.length === 1);
    await page.waitForTimeout(1000); // initial subscription reconciliation
    const initialFullReads = fullReads;
    auction.highBid.amount = 25; auction.bidVersion++;
    await page.evaluate((id) => { for (let i = 0; i < 30; i++) window.__push([id]); }, auction.id);
    await card.locator('.auction-leading-bid').getByText('25 DKP', { exact: true }).waitFor();
    assert.equal(fullReads, initialFullReads, 'other members bids do not reload the roster/DKP');
    assert.ok(reads.some((search) => new URLSearchParams(search).get('ids') === JSON.stringify([auction.id])));
    assert.ok(reads.filter((search) => new URLSearchParams(search).has('live')).length <= 2, 'a burst is coalesced');
    // Becoming the leader needs fresh personal holds; later removal releases them.
    auction.highBid.isMine = true; auction.bidVersion++;
    await page.evaluate((id) => window.__push([id]), auction.id);
    await page.waitForFunction(() => document.querySelector('.auction-leading-bid')?.getAttribute('data-mine') === 'true');
    await page.waitForTimeout(500);
    assert.ok(fullReads > initialFullReads, 'personal holds are reconciled through the full authenticated read');
    auctions = [];
    await page.evaluate((id) => window.__push([id]), auction.id);
    await card.waitFor({ state: 'detached' });
    await page.evaluate(() => window.dispatchEvent(new Event('centuri:clear-data')));
    assert.equal(await page.evaluate(() => window.__pushSources.every((source) => source.closed)), true);
    assert.deepEqual(writes, ['/api/auction/realtime']);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pushBidUpdate: true, burstCoalescing: true, targetedRead: true, personalBalanceRefresh: true, removal: true, logoutCleanup: true, liveBrokerTested: false }));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
