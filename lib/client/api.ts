'use client';

type Cached = { value: unknown };
const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
const MAX_CACHED_RESOURCES = 40;
let generation = 0;
export function clientDataVersion() { return generation; }

export class ApiError extends Error {
  constructor(message: string, public status: number, public details: Record<string, unknown> | null = null) { super(message); }
}

export async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || `The request failed (${response.status}). Please try again.`, response.status, data);
  if (!data) throw new ApiError('The server returned an unreadable response. Please try again.', response.status);
  return data as T;
}

// Private data stays in this tab's memory until refreshed or invalidated, with a 40-resource LRU limit.
export function peekData<T>(url: string): T | null {
  const entry = cache.get(url);
  if (!entry) return null;
  cache.delete(url);
  cache.set(url, entry);
  return entry.value as T;
}

export function rememberData<T>(url: string, value: T) {
  cache.delete(url);
  cache.set(url, { value });
  while (cache.size > MAX_CACHED_RESOURCES) {
    const oldestUrl = cache.keys().next().value;
    if (oldestUrl === undefined) break;
    cache.delete(oldestUrl);
  }
}

export function invalidateData(url: string) {
  versions.set(url, (versions.get(url) ?? 0) + 1);
  cache.delete(url);
  pending.delete(url);
}

export function getData<T>(url: string): Promise<T> {
  const existing = pending.get(url);
  if (existing) return existing as Promise<T>;
  const requestedGeneration = generation;
  const requestedVersion = versions.get(url) ?? 0;
  const request: Promise<T> = fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    .then(readResponse<T>)
    .then((value) => {
      if (requestedGeneration !== generation) throw new ApiError('Your session changed while this request was running.', 499);
      if (requestedVersion !== (versions.get(url) ?? 0)) return getData<T>(url);
      rememberData(url, value);
      return value;
    })
    .finally(() => { if (pending.get(url) === request) pending.delete(url); });
  pending.set(url, request);
  return request;
}

export function clearClientData() {
  generation += 1;
  cache.clear();
  pending.clear();
  versions.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('centuri:clear-data'));
    try { window.sessionStorage.removeItem('centuri-auction-house-v1'); } catch { /* Storage is optional. */ }
  }
}

export function notifyDkpChanged() {
  invalidateData('/api/dkp');
  invalidateData('/api/admin/boss-history');
  invalidateData('/api/auction');
  window.dispatchEvent(new Event('centuri:dkp-changed'));
}
