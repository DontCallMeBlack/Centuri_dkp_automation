// Local-only browser fixture for the real authenticated image route.
// Run: node --experimental-strip-types scripts/image-cache-browser-smoke.mjs
// Open the printed URL in a browser without Playwright request interception.
// /counts records actual origin requests; /fixture/* changes only in-memory data.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import sharp from 'sharp';

const port = Number(process.env.IMAGE_SMOKE_PORT || 3119);
const itemId = '000000000000000000000901';
const revisions = ['00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000902'];
const pngs = await Promise.all(['#d14b47', '#477dd1'].map(background =>
  sharp({ create: { width: 24, height: 24, channels: 3, background } }).png().toBuffer()));
const fixture = globalThis.__imageBrowserSmoke = {
  context: new AsyncLocalStorage(), revision: 0, itemReads: 0, authChecks: 0, requests: [],
  item() { return { imageVersion: revisions[this.revision], images: [{ data: pngs[this.revision], contentType: 'image/png' }] }; },
};
const mocks = {
  'next/server': 'export const NextResponse = {json: (value, init) => Response.json(value, init)};',
  '@/lib/auth/session': `export async function getSessionUser() {
    const fixture=globalThis.__imageBrowserSmoke;fixture.authChecks++;
    const session=fixture.context.getStore()?.session;
    return session==='one'||session==='two'?{_id:session,role:'clansman'}:null;
  }`,
  '@/lib/models/AuctionItem': `export default {findById(){
    const fixture=globalThis.__imageBrowserSmoke;fixture.itemReads++;
    return {select(){return {lean:async()=>fixture.item()};}};
  }};`,
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { GET } = await import('../app/api/auction/image/route.ts');
hooks.deregister();

const sessions = new Set(['one', 'two', 'none']);
const server = createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url, `http://127.0.0.1:${port}`);
  const session = /(?:^|;\s*)smoke-session=([^;]*)/.exec(incoming.headers.cookie ?? '')?.[1];
  const send = (body, type = 'text/html') => {
    outgoing.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); outgoing.end(body);
  };
  try {
    if (url.pathname === '/api/auction/image') {
      const response = await fixture.context.run({ session }, () => GET(new Request(url, { headers: incoming.headers })));
      fixture.requests.push({ session: session ?? null, version: url.searchParams.get('version'),
        probe: url.searchParams.get('probe'), status: response.status, conditional: incoming.headers['if-none-match'] ?? null });
      const headers = Object.fromEntries(response.headers);
      // Accelerate only the legacy control's 60-second browser expiry to one
      // second. The immutable case uses the production route's exact headers.
      if (url.searchParams.get('control') === 'short-legacy' && response.status < 400) {
        headers['cache-control'] = 'private, max-age=1, must-revalidate';
      }
      outgoing.writeHead(response.status, headers); outgoing.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname === '/counts') {
      send(JSON.stringify({ itemReads: fixture.itemReads, authChecks: fixture.authChecks,
        revision: revisions[fixture.revision], requests: fixture.requests }), 'application/json'); return;
    }
    if (url.pathname === '/fixture/session') {
      const nextSession = url.searchParams.get('value');
      if (!sessions.has(nextSession)) { outgoing.writeHead(400); outgoing.end(); return; }
      outgoing.setHeader('Set-Cookie', `smoke-session=${nextSession}; Path=/; HttpOnly; SameSite=Lax`);
      outgoing.writeHead(302, { Location: url.searchParams.get('returnTo')?.startsWith('/') ? url.searchParams.get('returnTo') : '/' });
      outgoing.end(); return;
    }
    if (url.pathname === '/fixture/replace' && incoming.method === 'POST') {
      fixture.revision = 1; send(JSON.stringify({ imageVersion: revisions[1] }), 'application/json'); return;
    }
    if (url.pathname === '/blank') { send('<!doctype html><title>Blank fixture</title><p>No images on this page.</p>'); return; }
    if (url.pathname !== '/') { outgoing.writeHead(404); outgoing.end(); return; }
    if (!session) outgoing.setHeader('Set-Cookie', 'smoke-session=one; Path=/; HttpOnly; SameSite=Lax');
    const probe = encodeURIComponent(url.searchParams.get('probe') ?? 'default');
    const mode = url.searchParams.get('mode') === 'legacy' ? 'legacy' : 'versioned';
    const revision = url.searchParams.get('version') ?? revisions[fixture.revision];
    const source = `/api/auction/image?id=${itemId}&index=0&probe=${probe}${mode === 'legacy'
      ? '&control=short-legacy' : `&version=${encodeURIComponent(revision)}`}`;
    send(`<!doctype html><html><head><title>Image browser cache fixture</title></head><body>
      <h1>Image browser cache fixture</h1><p>Mode: ${mode}</p>
      <img id="fixture-image" src="${source}" alt="Fixture item" width="96" height="96">
      <p><a href="/counts">Origin request counts</a></p>
      <p>This server uses in-memory fixtures and never connects to the application database.</p>
      </body></html>`);
  } catch (error) {
    console.error(error); outgoing.writeHead(500); outgoing.end('Fixture failed.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Image cache browser fixture: http://127.0.0.1:${port}/?mode=versioned&probe=smoke`));
