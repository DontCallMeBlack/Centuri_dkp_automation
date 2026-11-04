// Run against a local production build. All API calls use fixtures; live writes are blocked.
// Set PLAYWRIGHT_MODULE to an external Playwright install if needed.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.PERF_ORIGIN || 'http://localhost:3105';
const names = 'Druidprov8 khuno bulajing rxm note3 crizvia healsbeast incin nitroranger rasberries icymagic montage pogba ftw salhorgordon draculaX oogway74 Vexana';
const user = { id: '100000000000000000000001', nickname: 'Test Chief', role: 'chief', sheetRecordRows: [3] };
const roster = [...names.split(' '), 'Unrelated', 'healsbeastz'].map((account, index) => ({
  rowIndex: index + 3, owner: `Owner ${index}`, account: account === 'icymagic' ? 'icy magic' : account === 'crizvia' ? 'crizivia' : account, subClass: 'Ranger',
  available: 100, earned: 100, spent: 0, weeklyEarned: 19, weeklySpent: 0, fiveWeekActivity: 14, dkpIssues: [],
}));
const paste = (input, text) => input.evaluate((element, value) => {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', value);
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
}, text);

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
          writes.push(url.pathname);
          return route.fulfill({ status: 400, json: { error: 'Test: live writes blocked' } });
        }
        let data;
        if (url.pathname === '/api/auth/session') data = { user };
        else if (url.pathname === '/api/dkp') data = { success: true, user, roster,
          clanMembers: [{ nickname: user.nickname, role: user.role, toons: roster }], bossActivity: [] };
        else if (url.pathname === '/api/admin/boss-history') data = { canManage: true, roster, nextCursor: null,
          awards: [{ id: '400000000000000000000001', originalSelectedRows: [21], selectedRows: [21],
            bossName: 'Gele', points: 6, participants: [roster[18]], auditTrail: [], createdBy: user.nickname,
            createdAt: new Date().toISOString(), status: 'applied', canModify: true }] };
        else throw new Error('Unexpected API request: ' + url.pathname);
        return route.fulfill({ status: 200, json: data });
      });
      await page.goto(origin + '/dashboard');
      await page.getByRole('button', { name: 'Record a kill', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const input = dialog.getByRole('searchbox', { name: 'Search attendees or paste toon names' });
      await input.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('dialog input[type=search]').disabled);
      assert.equal(await dialog.getByRole('region', { name: /^Top ten/ }).count(), 0);
      assert.equal(await dialog.getByText(/hall of fame|Top 10 by recorded appearances/).count(), 0);
      await input.fill('Unrelated');
      await dialog.getByRole('button', { name: /Unrelated/ }).click();
      await paste(input, names);
      await dialog.getByRole('status').filter({ hasText: '18 names matched.' }).waitFor();
      await dialog.getByRole('status').filter({ hasText: 'crizvia → crizivia' }).waitFor();
      await dialog.getByRole('button', { name: 'Record kill · 19 toons', exact: true }).waitFor();
      assert.equal(await input.inputValue(), '');
      await paste(input, names.toUpperCase());
      await dialog.getByRole('button', { name: 'Record kill · 19 toons', exact: true }).waitFor();
      await paste(input, 'nitrorange oogway75 healsbeas missing');
      await dialog.getByRole('status').filter({ hasText: 'nitrorange → nitroranger' }).waitFor();
      await dialog.getByRole('status').filter({ hasText: 'oogway75 → oogway74' }).waitFor();
      await dialog.getByText('Not found: missing', { exact: true }).waitFor();
      await dialog.getByText('Multiple matches; select manually: healsbeas', { exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'healsbeas missing', 'Only unresolved names remain in paste order');
      await dialog.getByRole('button', { name: /healsbeastz/ }).waitFor();
      await input.fill('healsbeast');
      await input.press('Enter');
      await dialog.getByRole('status').filter({ hasText: '1 name matched.' }).waitFor();
      assert.equal(await input.inputValue(), '', 'Corrected names disappear when matched');
      await input.fill('ftw pogba');
      await input.press('Enter');
      await dialog.getByRole('status').filter({ hasText: '2 names matched.' }).waitFor();
      assert.equal(writes.length, 0, 'Paste and Enter only update selections');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.goto(origin + '/admin/boss-history');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const historyInput = page.getByRole('searchbox', { name: 'Search attendees or paste toon names' });
      await paste(historyInput, names + ' missing healsbeas');
      await page.getByRole('status').filter({ hasText: '18 names matched.' }).waitFor();
      assert.equal(await historyInput.inputValue(), 'missing healsbeas');
      await historyInput.fill('');
      assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 19, 'Existing attendees remain selected');
      await paste(historyInput, names);
      assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 19);
      await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No page overflow');
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(`${width}px: paste, fuzzy/unknown/ambiguous names, deduplication, Enter, and existing attendance passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
