// Run against a local production build. All APIs are fixtures; no live writes.
// PLAYWRIGHT_MODULE may point to an externally installed Playwright directory.
const assert = require('node:assert/strict');
const { randomFillSync } = require('node:crypto');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.PERF_ORIGIN || 'http://localhost:3101';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.BROWSER_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
  });
  try {
    // A textured raster near the upload limit exercises real image decoding.
    const imageBytes = await sharp(randomFillSync(Buffer.alloc(320 * 320 * 3)), {
      raw: { width: 320, height: 320, channels: 3 },
    }).webp({ quality: 70 }).toBuffer();
    assert.ok(imageBytes.length > 40 * 1024 && imageBytes.length <= 75 * 1024);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 1250000, uploadThroughput: 1250000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const errors = []; const imageRequests = []; const apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    const maliciousName = '<img src=x onerror=alert(1)>';
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: String(index + 1).padStart(24, '0'), name: index === 999 ? maliciousName : `Capacity item ${String(index).padStart(4, '0')}`,
      requiredRoles: ['Everyone'], bossType: 'Bt', imageCount: 8,
    }));
    const user = { id: '000000000000000000000001', nickname: 'Capacity Chief', role: 'chief', sheetRecordRows: [3] };
    let apiDelayMs = 250;
    await page.route('**/api/**', async route => {
      const req = route.request(); const url = new URL(req.url());
      assert.equal(req.method(), 'GET', 'Capacity checks must not write to APIs');
      apiRequests.push(url.pathname);
      if (url.pathname === '/api/auction/image') {
        assert.ok(items.some(item => item.id === url.searchParams.get('id')));
        assert.equal(url.searchParams.get('index'), '0');
        imageRequests.push(url.search);
        await route.fulfill({ contentType: 'image/webp', body: imageBytes });
        return;
      }
      const fixtures = {
        '/api/auth/session': { success: true, user },
        '/api/dkp': { success: true, user, roster: [], bossActivity: [], clanMembers: [] },
        '/api/auction/items': { success: true, items, roles: ['Everyone'] },
      };
      assert.ok(fixtures[url.pathname], `Unexpected API ${url.pathname}`);
      await new Promise(resolve => setTimeout(resolve, apiDelayMs));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
    });
    await page.goto(origin + '/dashboard');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('link', { name: 'Item catalog', exact: true }).waitFor();
    assert.equal(apiRequests.includes('/api/auction/items'), false, 'Catalog should load on demand');
    const at = Date.now();
    await nav.getByRole('link', { name: 'Item catalog', exact: true }).click();
    const cards = page.locator('article.item-catalog-card');
    await page.waitForFunction(() => document.querySelectorAll('article.item-catalog-card').length === 50);
    const tabReadyMs = Date.now() - at;
    assert.equal(await cards.count(), 50);
    await page.waitForTimeout(600);
    assert.ok(imageRequests.length > 0 && imageRequests.length <= 50);
    const initialImageRequests = imageRequests.length;
    assert.equal(await page.locator('img[src*="/api/auction/image"]').count(), 50);
    await page.getByRole('button', { name: 'Next items', exact: true }).click();
    await cards.first().getByText('Capacity item 0050', { exact: true }).waitFor();
    assert.equal(await cards.count(), 50);
    await page.getByRole('button', { name: 'Previous items', exact: true }).click();
    await cards.first().getByText('Capacity item 0000', { exact: true }).waitFor();
    const search = page.getByRole('searchbox', { name: 'Search catalog items' });
    const searchAt = Date.now();
    await search.fill(maliciousName);
    await page.waitForFunction(() => document.querySelectorAll('article.item-catalog-card').length === 1);
    const searchMs = Date.now() - searchAt;
    await cards.getByRole('heading', { name: maliciousName, exact: true }).waitFor();
    assert.equal(await page.locator('[onerror]').count(), 0, 'Item names must render as escaped text');
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    await search.fill('no matching catalog item');
    await page.getByRole('heading', { name: 'No items match your search' }).waitFor();
    await search.fill('');
    await page.waitForFunction(() => document.querySelectorAll('article.item-catalog-card').length === 50);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // A slow catalog backend should keep a visible loading state, then recover.
    apiDelayMs = 3000;
    const slowAt = Date.now();
    await page.reload();
    await page.getByRole('status', { name: 'Preparing item catalog' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('article.item-catalog-card').length === 50);
    const slowReloadMs = Date.now() - slowAt;
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ itemCount: 1000, imagesPerItem: 8, renderedCards: 50,
      metadataBytes: Buffer.byteLength(JSON.stringify({ success: true, items, roles: ['Everyone'] })),
      tabReadyMs, searchMs, initialImageRequests, fixtureImageBytes: imageBytes.length, slowReloadMs,
      network: { downloadMbps: 10, latencyMs: 100, cpuSlowdown: 4, fixtureApiDelayMs: 250 },
      pagination: true, searchAcrossAllItems: true, escapedItemNames: true, mobileOverflow: false, errors,
      limitation: 'Intercepted API/image fixtures; does not measure MongoDB latency or concurrent live users. Browser network throttling may not fully apply to intercepted responses.' }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
