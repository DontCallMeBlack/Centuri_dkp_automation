/** Direct browser-to-broker SSE. No persistent Vercel function or extra SDK. */
export function subscribeAuctionChanges(onChange: (ids: string[] | null) => void, onConnected: (connected: boolean) => void) {
  let disposed = false;
  let stream: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: Set<string> | null = new Set();
  let lastFlushAt = 0;
  let retryMs = 15_000;
  let connecting = false;
  let request: AbortController | undefined;
  let credentials: { token: string; channel: string; expiresAt: number } | undefined;
  const visible = () => !disposed && document.visibilityState === 'visible' && navigator.onLine !== false;
  const queue = (ids: string[] | null) => {
    if (ids === null) pending = null;
    else if (pending) for (const id of ids) pending.add(id);
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (!visible()) return;
      const ids = pending === null ? null : [...pending];
      pending = new Set();
      lastFlushAt = Date.now();
      onChange(ids);
    }, Math.max(250, lastFlushAt + 5000 - Date.now()));
  };
  const close = () => {
    stream?.close(); stream = undefined;
    clearTimeout(timer); timer = undefined;
    clearTimeout(flushTimer); flushTimer = undefined;
    onConnected(false);
  };
  const connect = async () => {
    if (!visible() || stream || connecting) return;
    connecting = true;
    request = new AbortController();
    try {
      if (!credentials || credentials.expiresAt - Date.now() < 60_000) {
        const response = await fetch('/api/auction/realtime', { method: 'POST', cache: 'no-store', signal: request.signal });
        if (response.status === 401 || response.status === 403) { dispose(); return; }
        if (!response.ok) throw new Error('Unavailable');
        const body = await response.json();
        if (body.enabled === false) { dispose(); return; }
        if (typeof body.token !== 'string' || body.channel !== 'centuri:auction-changes' ||
          !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now() + 60_000) throw new Error('Invalid subscription');
        credentials = body;
      }
      if (!visible() || !credentials) return;
      const url = new URL('https://main.realtime.ably.net/sse');
      url.search = new URLSearchParams({ v: '1.2', channels: credentials.channel, accessToken: credentials.token, enveloped: 'false' }).toString();
      const source = new EventSource(url.toString());
      stream = source;
      source.onopen = () => {
        if (stream !== source || !visible()) return;
        retryMs = 15_000;
        onConnected(true);
        // Includes new auctions and changes lost before subscribing/reconnecting.
        queue(null);
      };
      source.onmessage = (event) => {
        if (stream !== source || !visible()) return;
        try {
          const notice = JSON.parse(event.data);
          if (!Array.isArray(notice.auctionIds) || notice.auctionIds.length > 100 ||
            !notice.auctionIds.every((id: unknown) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id))) return;
          queue(notice.auctionIds.length ? notice.auctionIds : null);
        } catch { /* Malformed broker traffic cannot change auction state. */ }
      };
      source.onerror = () => {
        if (stream !== source) return;
        close();
        // An expired/rejected token is replaced on the next attempt.
        credentials = undefined;
        retry();
      };
      timer = setTimeout(() => { close(); void connect(); }, credentials.expiresAt - Date.now() - 30_000);
    } catch {
      if (visible()) retry();
    } finally { connecting = false; }
  };
  const retry = () => {
    if (!visible() || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void connect(); }, retryMs);
    retryMs = Math.min(60_000, retryMs * 2);
  };
  const wake = () => {
    if (!visible()) { close(); return; }
    void connect();
  };
  function dispose() {
    disposed = true; request?.abort(); close(); credentials = undefined;
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('offline', wake);
    window.removeEventListener('centuri:clear-data', dispose);
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('offline', wake);
  window.addEventListener('centuri:clear-data', dispose);
  void connect();
  return dispose;
}
