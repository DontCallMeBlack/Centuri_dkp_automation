'use client';

// Store only opaque retry IDs, keyed by an account and hashed action payload.
// sessionStorage survives a page reload without exposing participant drafts.
async function storageKey(account: string, action: string, payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify([account, action, payload]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return `centuri:retry:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function getActionRequestId(account: string, action: string, payload: unknown) {
  const key = await storageKey(account, action, payload);
  try {
    const saved = sessionStorage.getItem(key);
    if (saved && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(saved)) return saved;
    const requestId = crypto.randomUUID();
    sessionStorage.setItem(key, requestId);
    return requestId;
  } catch {
    throw new Error('Allow browser session storage before submitting this action so an interrupted request can be retried safely.');
  }
}

export async function completeActionRequest(account: string, action: string, payload: unknown) {
  try { sessionStorage.removeItem(await storageKey(account, action, payload)); } catch { /* Keeping a receipt is safer than replaying with a new ID. */ }
}
