// Browser regression checks using intercepted fixture APIs only.
// Install playwright and @axe-core/playwright outside the app, then set
// PLAYWRIGHT_MODULE and AXE_MODULE to their absolute module directories.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const AxeBuilder = require(process.env.AXE_MODULE || '@axe-core/playwright').default;
const origin = process.env.PERF_ORIGIN || 'http://localhost:3102';

async function run(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = new Date().toISOString();
  const user = { id: '100000000000000000000001', nickname: 'Centuri Member', role: 'general', sheetRecordRows: [3] };
  const roster = Array.from({ length: 12 }, (_, i) => ({ rowIndex: i + 3, owner: `Owner ${i}`, account: `Toon ${i}`, subClass: i % 2 ? 'support druid' : 'fire mage', available: 200, earned: 300, spent: 100, weeklyEarned: 20, weeklySpent: 0, dkpIssues: [] }));
  const item = { id: '200000000000000000000001', name: 'Ancient dragon ring', requiredRoles: ['Fire Mage'], bossType: 'Bt', imageCount: 2 };
  const fixtures = {
    '/api/auth/session': { user },
    '/api/dkp': { success: true, user, roster, bossActivity: [], clanMembers: [{ nickname: user.nickname, role: user.role, toons: roster }] },
    '/api/auction/items': { items: [item], roles: ['Fire Mage', 'Ice Mage', 'Everyone'] },
    '/api/auction': { manager: true, weeklyEarnedTotal: 20, weeklyMinimum: 10, canBidWeekly: true, roles: ['fire mage'], toons: [{ ...roster[0], heldPoints: 0, canBid: true }], items: [item], auctions: [{ id: '300000000000000000000001', itemId: item.id, imageCount: 1, itemName: item.name, bossType: 'Bt', requiredRoles: ['Fire Mage'], createdBy: user.nickname, isPoster: true, isWinner: false, canMarkDelivered: false, canRemove: true, createdAt: now, endsAt: new Date(Date.now() + 3600000).toISOString(), biddingClosed: false, status: 'active', highBid: null, winner: null, deliveryStatus: 'pending' }], rosterSync: { fetchedAt: now, stale: false, refreshDelayed: false } },
    '/api/admin/boss-history': { canManage: true, roster, nextCursor: null, awards: [{ id: '400000000000000000000001', originalSelectedRows: [3, 4], selectedRows: [3, 4], bossName: 'Bt', points: 5, participants: roster.slice(0, 2), auditTrail: [], createdBy: user.nickname, createdAt: now, status: 'applied', canModify: true }] },
    '/api/role-changes': { canApprove: true, nextChangeAt: '2027-01-01T05:00:00.000Z', toons: [{ ...roster[0], currentRole: 'fire mage', scheduledRole: null, effectiveAt: null, request: null, isOwned: true, canRequest: true, canCancel: false, duplicateIdentity: false }] },
    '/api/admin/requests': { managerRole: user.role, managerId: user.id, pendingUsers: [{ _id: '500000000000000000000001', nickname: 'New recruit', role: 'clansman', sheetRecordRows: [] }], members: [{ _id: user.id, nickname: user.nickname, role: user.role, sheetRecordRows: [3] }, { _id: '500000000000000000000002', nickname: 'Another member', role: 'clansman', sheetRecordRows: [4] }], auditEvents: [], roster },
    '/api/admin/toons': { toons: roster.map(toon => ({ ...toon, linkedAccounts: [user.nickname] })), pending: null },
  };
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') return route.fulfill({ status: 400, json: { error: 'Test: live writes blocked' } });
    if (url.pathname === '/api/auction/image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#254254"/><circle cx="80" cy="80" r="35" fill="none" stroke="#e2c18a" stroke-width="9"/></svg>' });
    const data = url.searchParams.get('section') === 'archives' ? { archivedAccounts: [], archivedToons: [] } : fixtures[url.pathname];
    return route.fulfill({ status: data ? 200 : 404, json: data || { error: 'Missing fixture' } });
  });
  const ready = () => page.waitForFunction(() => ![...document.querySelectorAll('[aria-busy="true"]')].some(el => el.getClientRects().length));
  const violations = [];
  const audit = async label => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    for (const issue of result.violations) violations.push({ page: label, id: issue.id, impact: issue.impact, nodes: issue.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) });
  };
  const checkLayout = async label => {
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: page overflow`);
    assert.equal(await page.getByRole('main').count(), 1, `${label}: main landmark`);
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, `${label}: one visible page title`);
  };
  const routes = ['/login', '/dashboard', '/dashboard?view=auction', '/dashboard?view=items', '/dashboard?view=boss-history', '/admin/boss-history', '/admin/role-changes', '/admin/requests', '/missing-page'];
  try {
    for (const path of routes) {
      await page.goto(origin + path);
      await ready();
      await checkLayout(path);
      assert.equal(await page.getByRole('main').getByRole('alert').count(), 0, `${path}: unexpected error`);
      if (path === '/dashboard') assert.equal(await page.locator('tbody tr').count(), roster.length);
      await audit(path);
      if (process.env.UI_SCREENSHOTS_DIR) {
        const fs = require('node:fs');
        fs.mkdirSync(process.env.UI_SCREENSHOTS_DIR, { recursive: true });
        await page.screenshot({ path: require('node:path').join(process.env.UI_SCREENSHOTS_DIR, `${path.replace(/[^a-z0-9]/gi, '-')}-desktop.png`), fullPage: true });
      }
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await checkLayout(`${path} at ${width}px`);
        if (width === 390 && process.env.UI_SCREENSHOTS_DIR) await page.screenshot({ path: require('node:path').join(process.env.UI_SCREENSHOTS_DIR, `${path.replace(/[^a-z0-9]/gi, '-')}-mobile.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      console.error(`${path}: layout and accessibility checked`);
    }
    await page.goto(origin + '/login');
    await page.getByRole('button', { name: 'Request access', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill('test password');
    await page.getByRole('button', { name: 'Show password' }).click();
    assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text');
    await audit('signup');
    await page.goto(origin + '/dashboard'); await ready();
    const search = page.getByRole('searchbox');
    await search.fill('unmatched search');
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    assert.equal(await search.inputValue(), '');
    await page.getByRole('button', { name: 'Record a kill', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await audit('record kill dialog');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.setViewportSize({ width: 320, height: 640 });
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    await audit('mobile menu');
    await page.keyboard.press('Escape');
    assert.equal(await menu.evaluate(el => el === document.activeElement), true);
    await menu.click();
    await page.getByRole('dialog').getByRole('link', { name: 'Auction house' }).click();
    await page.getByRole('heading', { name: 'Auction house', exact: true }).waitFor(); await ready();
    assert.match(await page.title(), /^Auction house/);
    await page.getByRole('button', { name: 'Post an auction', exact: true }).click();
    await page.getByRole('button', { name: /Ancient dragon ring Fire Mage/ }).waitFor();
    assert.equal(await page.locator('button button').count(), 0, 'Item picker must not nest image navigation buttons');
    await audit('post auction picker');
    await page.getByRole('button', { name: 'Close auction post form', exact: true }).click();
    await page.goBack();
    await page.getByRole('heading', { name: 'Clan leaderboard' }).waitFor();
    await context.setOffline(true);
    await page.getByRole('status').filter({ hasText: 'You’re offline' }).waitFor();
    await context.setOffline(false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const [path, label] of [
      ['/dashboard?view=items', 'Search catalog items'],
      ['/dashboard?view=boss-history', 'Search loaded kill history'],
      ['/admin/role-changes', 'Search role changes'],
      ['/dashboard?view=auction', 'Search auctions by item, poster, or bidder'],
    ]) {
      await page.goto(origin + path); await ready();
      const input = page.getByRole('searchbox', { name: label });
      await input.fill('not a matching record');
      await page.getByRole('button', { name: 'Clear search and filters' }).click();
      assert.equal(await input.inputValue(), '');
    }
    await page.goto(origin + '/admin/requests'); await ready();
    for (const name of [/^Members\s/, /^Clan toons\s/, /^Activity log\s/]) {
      await page.getByRole('button', { name }).click(); await ready();
      await audit(`administration ${name}`);
      await page.setViewportSize({ width: 320, height: 844 });
      await checkLayout(`administration ${name} mobile`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.goto(origin + '/dashboard?view=items'); await ready();
    await page.getByRole('button', { name: 'Add an item', exact: true }).click();
    await audit('create catalog item');
    await page.setViewportSize({ width: 320, height: 844 });
    await checkLayout('create catalog item mobile');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ routes: routes.length, widths: [320, 390, 768, 1440], browserErrors: errors, violations }, null, 2));
    assert.deepEqual(violations, [], 'Accessibility violations');
  } finally { await context.close(); }
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try { await run(browser); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
