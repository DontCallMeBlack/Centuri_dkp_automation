import { Types } from 'mongoose';
import { RequestValidationError } from '@/lib/security/request';

export const HISTORY_PAGE_SIZE = 50;

export function readHistoryPage(url: URL) {
  const raw = url.searchParams.get('cursor');
  if (!raw) return {};
  try {
    if (raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value?.id !== 'string' || !/^[a-f\d]{24}$/i.test(value.id) || typeof value?.createdAt !== 'string') throw new Error();
    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error();
    return { $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: new Types.ObjectId(value.id) } }] };
  } catch { throw new RequestValidationError('Invalid history page. Reload the history view.'); }
}

export function historyCursor(record: { _id: { toString(): string }; createdAt: Date }) {
  return Buffer.from(JSON.stringify({ id: record._id.toString(), createdAt: record.createdAt.toISOString() })).toString('base64url');
}
