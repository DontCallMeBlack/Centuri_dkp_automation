// Populated role-based UI checks. Every API request is intercepted; no live writes.
// Uses the same PLAYWRIGHT_MODULE, BROWSER_PATH and PERF_ORIGIN as performance-smoke.cjs.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');

async function runRole(browser, role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const origin = process.env.PERF_ORIGIN || 'http://localhost:3101';
  const senior = ['chief', 'general'].includes(role);
  const manager = ['chief', 'general', 'guardian'].includes(role);
  const user = { id: '100000000000000000000001', nickname: `Test ${role}`, role, sheetRecordRows: [3] };
  const roster = Array.from({ length: 30 }, (_, i) => ({ rowIndex: i + 3, owner: `Owner ${i}`, account: `Toon ${i}`, subClass: 'fire mage', available: 200, earned: 300, spent: 100, weeklyEarned: 20, weeklySpent: 0, dkpIssues: [] }));
  let items = Array.from({ length: 120 }, (_, i) => ({ id: (i + 1).toString(16).padStart(24, '0'), name: `Catalog item ${String(i).padStart(3, '0')}`, requiredRoles: ['Fire Mage'], bossType: 'Bt', imageCount: 2 }));
  const image = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#4f46e5' } }).png().toBuffer();
  const errors = [], requests = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 2_500_000, uploadThroughput: 2_500_000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const now = new Date().toISOString();
  const pendingRole = { id: '200000000000000000000001', status: 'pending', requestedRole: 'ice mage', createdAt: now, effectiveAt: '2027-01-01T05:00:00.000Z' };
  const fixtures = {
    '/api/auth/session': { success: true, user },
    '/api/dkp': { success: true, user, roster, bossActivity: [{ bossName: 'Base', rowIndex: 3, count: 5 }], clanMembers: [{ nickname: user.nickname, role, toons: roster }] },
    '/api/admin/boss-history': { canManage: manager, roster, nextCursor: null, awards: [{ id: '300000000000000000000001', originalSelectedRows: [3, 4], selectedRows: [3, 4], bossName: 'Bt', points: 5, participants: roster.slice(0, 2), auditTrail: [{ kind: 'participant_added', changeId: 'test-comment', participant: roster[1], actor: 'Test manager', occurredAt: now }], createdBy: user.nickname, createdAt: now, status: 'applied', canModify: true }] },
    '/api/auction': { manager, weeklyEarnedTotal: 20, weeklyMinimum: 10, canBidWeekly: true, roles: ['fire mage'], toons: [{ ...roster[0], heldPoints: 0, canBid: true }], auctions: [], rosterSync: { fetchedAt: now, stale: false, refreshDelayed: false } },
    '/api/role-changes': { canApprove: senior, nextChangeAt: '2027-01-01T05:00:00.000Z', toons: [{ ...roster[0], currentRole: 'fire mage', scheduledRole: null, effectiveAt: null, request: pendingRole, isOwned: true, canRequest: false, canCancel: true, duplicateIdentity: false }] },
    '/api/admin/requests': { managerRole: role, managerId: user.id, pendingUsers: [{ _id: '400000000000000000000001', nickname: 'Pending member', role: 'clansman', sheetRecordRows: [] }], members: [{ _id: user.id, nickname: user.nickname, role, sheetRecordRows: [3] }, { _id: '400000000000000000000002', nickname: 'Approved member', role: 'clansman', sheetRecordRows: [4] }], auditEvents: [{ id: '500000000000000000000001', eventType: 'promotion', actorNickname: 'Test chief', actorRole: 'chief', targetNickname: 'Approved member', previousRole: 'clansman', newRole: 'guardian', createdAt: now }], roster },
    '/api/admin/toons': { toons: roster.map(toon => ({ ...toon, linkedAccounts: [user.nickname] })), pending: null },
  };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    requests.push(`${method} ${url.pathname}${url.search}`);
    const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (method !== 'GET') {
      mutations.push(`${method} ${url.pathname}`);
      if (url.pathname !== '/api/auction/items') return respond({ error: 'Unexpected test mutation blocked' }, 400);
      if (method === 'DELETE') {
        const { itemId } = req.postDataJSON();
        items = items.filter(item => item.id !== itemId);
        return respond({ success: true });
      }
      const form = await new Request(req.url(), { method, headers: req.headers(), body: req.postDataBuffer() }).formData();
      const record = { id: form.get('itemId') || '600000000000000000000001', name: form.get('name'), requiredRoles: form.getAll('requiredRoles'), bossType: form.get('bossType'), imageCount: form.getAll('images').length || 2 };
      items = [...items.filter(item => item.id !== record.id), record];
      assert.ok(record.requiredRoles.length > 0);
      if (method === 'POST') {
        const upload = form.get('images');
        assert.equal(upload.type, 'image/webp');
        assert.ok(upload.size <= 256 * 1024);
      }
      return respond({ success: true, id: record.id });
    }
    if (url.pathname === '/api/auction/image') return route.fulfill({ status: 200, contentType: 'image/png', body: image });
    await new Promise(resolve => setTimeout(resolve, 200));
    if (url.pathname === '/api/admin/requests' && !senior) return respond({ error: 'Manager access required', role }, 403);
    if (url.pathname === '/api/auction/items') return respond({ items, roles: ['Fire Mage', 'Ice Mage', 'Everyone'] });
    if (url.searchParams.get('section') === 'archives') return respond({ archivedAccounts: [], archivedToons: [] });
    if (url.pathname === '/api/auction') return respond({ ...fixtures[url.pathname], items });
    assert.ok(fixtures[url.pathname], `Unimplemented fixture ${url.pathname}`);
    return respond(fixtures[url.pathname]);
  });
  const ready = () => page.waitForFunction(() => ![...document.querySelectorAll('[aria-busy="true"]')].some(el => el.getClientRects().length));
  const go = async path => { await page.goto(origin + path); await ready(); };
  try {
    const started = Date.now();
    await go('/dashboard?view=items');
    if (!manager) {
      await page.getByText('Item management requires a Chief, General, or Guardian account.').waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Item catalog' }).count(), 0);
      await go('/admin/requests');
      await page.getByRole('heading', { name: 'Manager access required' }).waitFor();
      return { role, catalogBlocked: true, administrationBlocked: true, mutations, errors };
    }
    await page.getByRole('button', { name: 'Edit Catalog item 000', exact: true }).waitFor();
    const catalogReadyMs = Date.now() - started;
    assert.equal(await page.locator('.item-catalog-card').count(), 120);
    const search = page.getByRole('searchbox', { name: 'Search catalog items' });
    await search.fill('item 119');
    await page.waitForFunction(() => document.querySelectorAll('.item-catalog-card').length === 1);
    await search.fill('');
    await page.getByRole('button', { name: 'Edit Catalog item 000', exact: true }).click();
    const editor = page.locator('form').filter({ has: page.getByRole('textbox', { name: 'Item name', exact: true }) });
    assert.equal(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await editor.getByRole('textbox', { name: 'Item name', exact: true }).fill('Updated catalog item');
    await editor.getByRole('combobox', { name: 'Boss type' }).selectOption('Dino');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved item updated.', { exact: true }).waitFor();
    assert.equal(items.find(item => item.name === 'Updated catalog item').bossType, 'Dino');
    await editor.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Add an item', exact: true }).click();
    const create = page.locator('#create-catalog-form');
    await create.getByRole('textbox', { name: 'New catalog item name' }).fill('Created catalog item');
    await create.getByText('Fire Mage', { exact: true }).click();
    await create.getByText('Ice Mage', { exact: true }).click();
    assert.equal(await create.getByRole('checkbox', { name: 'DPS Rogue', exact: true }).isDisabled(), true);
    await create.getByText('Everyone', { exact: true }).click();
    assert.equal(await create.getByRole('checkbox', { name: 'Everyone', exact: true }).isChecked(), true);
    assert.equal(await create.getByRole('checkbox', { name: 'Fire Mage', exact: true }).isChecked(), false);
    assert.equal(await create.getByRole('checkbox', { name: 'Ice Mage', exact: true }).isChecked(), false);
    await create.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: image });
    const crop = page.getByRole('dialog');
    await crop.getByRole('button', { name: 'Use square crop', exact: true }).click();
    await page.getByText('1 square-cropped image ready', { exact: true }).waitFor();
    await create.getByRole('button', { name: 'Add item', exact: true }).click();
    await page.getByText('Item added to the auction catalog.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit Created catalog item', exact: true }).click();
    await page.getByRole('button', { name: 'Remove Created catalog item from catalog', exact: true }).click();
    await page.getByText(/Item removed\. You can reuse/).waitFor();
    assert.equal(items.some(item => item.name === 'Created catalog item'), false);

    await go('/dashboard?view=auction');
    await page.getByRole('button', { name: 'Post an auction', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Item', exact: true }).fill('item 119');
    await page.getByRole('button', { name: /Catalog item 119/ }).waitFor();
    await page.getByRole('button', { name: 'Close auction post form', exact: true }).click();
    await go('/dashboard?view=boss-history');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search attendees' }).fill('Toon 0');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: /Comments/ }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await go('/admin/role-changes');
    await page.getByRole('heading', { name: 'Subrole changes', exact: true }).waitFor();
    await ready();
    assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).count(), senior ? 1 : 0);
    if (!senior) await page.getByRole('button', { name: 'Cancel request', exact: true }).waitFor();

    await go('/admin/requests');
    if (senior) {
      await page.getByRole('heading', { name: 'Pending sign-ups', exact: true }).waitFor();
      await page.getByRole('button', { name: /^Members\s/ }).click();
      await page.getByRole('searchbox', { name: 'Search approved accounts' }).fill('Approved member');
      await page.getByRole('button', { name: 'Manage toons', exact: true }).click();
      await page.getByRole('button', { name: 'Close toon editor', exact: true }).click();
      await page.getByRole('button', { name: 'Change role', exact: true }).click();
      await page.getByRole('button', { name: 'Close rank editor', exact: true }).click();
      await page.getByRole('button', { name: /^Clan toons\s/ }).click();
      await page.getByRole('button', { name: 'Add a toon', exact: true }).click();
      await page.getByRole('button', { name: 'Close new toon form', exact: true }).click();
      await page.getByRole('button', { name: /^Activity log\s/ }).click();
      await page.getByRole('heading', { name: 'Removed accounts and denied sign-ups', exact: true }).waitFor();
      assert.ok(requests.some(req => req.includes('section=archives')));
    } else await page.getByRole('heading', { name: 'Manager access required', exact: true }).waitFor();
    await go('/dashboard?view=items');
    await page.getByRole('button', { name: 'Edit Catalog item 119', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Edit Catalog item 119', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    assert.deepEqual(mutations, ['PATCH /api/auction/items', 'POST /api/auction/items', 'DELETE /api/auction/items']);
    assert.deepEqual(errors, []);
    return { role, catalogReadyMs, catalogItems: items.length, catalogCreateEditRemove: true, browserCropAndCompression: true, auctionPostPicker: true, historyEditorAndComments: true, roleApprovalVisible: senior, administration: senior ? 'all four sections checked' : 'access blocked', mobileEditorNoOverflow: true, mockedMutations: mutations, errors };
  } catch (error) {
    console.error(JSON.stringify({ role, url: page.url(), visibleText: (await page.locator('body').innerText()).slice(-3000) }));
    throw error;
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const results = [];
    for (const role of ['guardian', 'general', 'chief', 'clansman']) {
      results.push(await runRole(browser, role));
      console.error(`${role}: passed`);
    }
    console.log(JSON.stringify({ fixtureApisOnly: true, networkMbps: 20, latencyMs: 100, cpuSlowdown: 4, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
