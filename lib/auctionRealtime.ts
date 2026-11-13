import { createHmac } from 'node:crypto';

// Keep production and preview in different Ably apps by using environment-specific keys.
export const AUCTION_CHANNEL = 'centuri:auction-changes';
export const AUCTION_TOKEN_TTL_MS = 15 * 60_000;

function configuredKey() {
  const key = process.env.ABLY_API_KEY?.trim();
  return key && /^[\w-]+\.[\w-]+:[\w+/=-]+$/.test(key) ? key : null;
}

export function auctionRealtimeEnabled() { return configuredKey() !== null; }

/** Subscribe-only JWT: never give browsers the server key or publishing rights. */
export function createAuctionSubscription(userId: string, now = Date.now()) {
  const key = configuredKey();
  if (!key || !userId) return null;
  const separator = key.indexOf(':');
  // Ably's current Free package requires identified clients. A stable keyed
  // pseudonym supports usage accounting without sharing our Mongo user IDs.
  const clientId = `member-${createHmac('sha256', key.slice(separator + 1))
    .update(`auction-viewer:${userId}`).digest('hex').slice(0, 32)}`;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expiresAt = now + AUCTION_TOKEN_TTL_MS;
  const unsigned = `${encode({ typ: 'JWT', alg: 'HS256', kid: key.slice(0, separator) })}.${encode({
    iat: Math.floor(now / 1000), exp: Math.floor(expiresAt / 1000),
    'x-ably-clientId': clientId,
    'x-ably-capability': JSON.stringify({ [AUCTION_CHANNEL]: ['subscribe'] }),
  })}`;
  const signature = createHmac('sha256', key.slice(separator + 1)).update(unsigned).digest('base64url');
  return { token: `${unsigned}.${signature}`, channel: AUCTION_CHANNEL, expiresAt };
}

/** Call only after the database transaction commits. Failure cannot undo an accepted bid. */
export async function publishAuctionChanges(ids: string[] = []) {
  const key = configuredKey();
  if (!key) return;
  const auctionIds = [...new Set(ids.filter((id) => /^[a-f\d]{24}$/i.test(id)))].slice(0, 100);
  try {
    const response = await fetch(`https://rest.ably.io/channels/${encodeURIComponent(AUCTION_CHANNEL)}/messages`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(3000),
      headers: { Authorization: `Basic ${Buffer.from(key).toString('base64')}`, 'Content-Type': 'application/json',
        'X-Ably-ClientId': Buffer.from('centuri-auction-server').toString('base64') },
      // No account names, bids, DKP, session tokens or user IDs leave the app.
      body: JSON.stringify({ name: 'changed', clientId: 'centuri-auction-server', data: JSON.stringify({ auctionIds }) }),
    });
    if (!response.ok) console.warn('Auction push unavailable; polling recovery remains enabled.', { status: response.status });
  } catch {
    // Provider responses/errors can contain credentials. Never log them.
    console.warn('Auction push unavailable; polling recovery remains enabled.');
  }
}
