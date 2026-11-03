// Production build with fixture APIs and a virtual clock; never calls live storage.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const start = Date.parse('2026-11-03T12:00:00Z');
    await page.clock.install({ time: start });
    const requests = [], errors = [];
    const user = { id: '000000000000000000000001', nickname: 'Refresh Chief', role: 'chief', sheetRecordRows: [3] };
    const toon = { rowIndex: 3, owner: user.nickname, account: 'Main', subClass: 'Tank', available: 100,
      earned: 100, spent: 0, weeklyEarned: 20, weeklySpent: 0, heldPoints: 0, dkpIssues: [] };
    const auction = (id, role, minutes) => ({ id, itemId: '000000000000000000000003', itemName: role + ' item',
      imageCount: 0, bossType: 'Bt', requiredRoles: [role], createdBy: user.nickname, isPoster: true,
      isWinner: false, canMarkDelivered: false, canRemove: true, canClose: true,
      createdAt: new Date(start).toISOString(), endsAt: new Date(start + minutes * 60_000).toISOString(),
      biddingClosed: false, status: 'active', bidVersion: 0, highBid: null, winner: null,
      deliveryStatus: 'not-required', deliveredBy: null, deliveredAt: null, settlementError: null, canResolveNoBid: false });
    // Auction times are replaced on entering the auction view after the idle-roster check.
    let auctionStart = start;
    const count = path => requests.filter(url => url.pathname === path).length;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); requests.push(url);
      assert.equal(route.request().method(), 'GET', 'Smoke tests must never mutate live data');
      let value;
      if (url.pathname === '/api/auth/session') value = { success: true, user };
      else if (url.pathname === '/api/dkp') value = { success: true, user, roster: [toon], clanMembers: [], bossActivity: [] };
      else if (url.pathname === '/api/auction/image') {
        await route.fulfill({ status: 404, body: '' }); return;
      } else if (url.pathname === '/api/auction' && url.searchParams.has('live')) value = { changed: false };
      else if (url.pathname === '/api/auction') {
        const auctions = [auction('000000000000000000000002', 'Tank', 6), auction('000000000000000000000004', 'Ranger', 4)]
          .map(item => ({ ...item, endsAt: new Date(Date.parse(item.endsAt) + auctionStart - start).toISOString() }));
        value = { success: true, manager: true, weeklyEarnedTotal: 20, weeklyMinimum: 0, canBidWeekly: true,
          roles: ['Tank'], toons: [toon], items: [], auctions,
          rosterSync: { fetchedAt: new Date(start).toISOString(), stale: false, refreshDelayed: false } };
      } else throw Error('Unexpected API request: ' + url.pathname + url.search);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    });
    const origin = process.env.PERF_ORIGIN || 'http://localhost:3102';
    await page.goto(origin + '/dashboard');
    await page.getByRole('heading', { name: 'Welcome back, Refresh Chief.' }).waitFor();
    await page.clock.runFor(7 * 60_000);
    await page.waitForTimeout(100);
    assert.deepEqual([...new Set(requests.map(url => url.pathname))].sort(), ['/api/auth/session', '/api/dkp']);
    assert.equal(count('/api/dkp'), 1, 'Idle roster must not poll');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(count('/api/dkp'), 2, 'Manual refresh must request new data');
    auctionStart = await page.evaluate(() => Date.now());
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Auction house', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh auction house' }).waitFor();
    assert.equal(count('/api/auction'), 1);
    await page.clock.runFor(58_000);
    await page.waitForTimeout(100);
    assert.equal(count('/api/auction'), 1, 'No network calls before the final-five-minute boundary');
    await page.clock.runFor(3_000);
    await page.waitForTimeout(100);
    const full = () => requests.filter(url => url.pathname === '/api/auction' && !url.searchParams.has('live'));
    assert.equal(full().length, 2, 'Eligibility must refresh once at the boundary');
    await page.clock.runFor(61_000);
    await page.waitForTimeout(100);
    const targeted = requests.filter(url => url.searchParams.has('ids'));
    assert.equal(targeted.length, 1);
    assert.deepEqual(JSON.parse(targeted[0].searchParams.get('ids')), ['000000000000000000000002']);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenCount = count('/api/auction');
    await page.clock.runFor(2 * 60_000);
    await page.waitForTimeout(100);
    assert.equal(count('/api/auction'), hiddenCount, 'Hidden pages must not poll');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ idleRosterMinutes: 7, idleRosterRequests: 1, manualRefresh: true,
      noSectionPrefetch: true, eligibilityBoundary: true, targetedMinutePolling: true,
      wrongRoleExcluded: true, hiddenTabPaused: true,
      requests: requests.map(url => url.pathname + url.search), errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
