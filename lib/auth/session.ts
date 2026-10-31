import { cookies } from 'next/headers';
import type { Types } from 'mongoose';
import dbConnect from '@/lib/mongodb';
import AuthSession from '@/lib/models/AuthSession';
import User, { type IUser } from '@/lib/models/User';
import { SESSION_MAX_AGE_SECONDS } from './validation';
import { hashSessionToken, newSessionToken, sessionCookieOptions, SESSION_TOKEN_PATTERN } from './tokens';

const sessionCookie = sessionCookieOptions(process.env.NODE_ENV === 'production');

export async function createSession(userId: Types.ObjectId) {
  const token = newSessionToken();
  await AuthSession.create({ _id: hashSessionToken(token), userId, expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000) });
  (await cookies()).set({ ...sessionCookie, value: token, maxAge: SESSION_MAX_AGE_SECONDS, priority: 'high' });
}

export async function revokeSession() {
  const store = await cookies();
  const token = store.get(sessionCookie.name)?.value;
  if (token && SESSION_TOKEN_PATTERN.test(token)) {
    await dbConnect();
    await AuthSession.deleteOne({ _id: hashSessionToken(token) });
  }
  store.set({ ...sessionCookie, value: '', maxAge: 0 });
}

export async function getSessionUser() {
  const token = (await cookies()).get(sessionCookie.name)?.value;
  // Old JWTs are intentionally invalid after the server-session migration.
  if (!token || !SESSION_TOKEN_PATTERN.test(token)) return null;
  await dbConnect();
  // Keep revocation and current permissions authoritative, in one database round trip.
  type SessionUser = Pick<IUser, 'nickname' | 'role' | 'status' | 'sheetRecordName' | 'sheetRecords'> & { _id: Types.ObjectId };
  const users = await AuthSession.aggregate<SessionUser>([
    { $match: { _id: hashSessionToken(token), expiresAt: { $gt: new Date() } } },
    { $lookup: {
      from: User.collection.name, localField: 'userId', foreignField: '_id', as: 'user',
      pipeline: [
        { $match: { status: 'approved' } },
        { $project: { nickname: 1, role: 1, status: 1, sheetRecordName: 1, sheetRecords: 1 } },
      ],
    } },
    { $unwind: '$user' },
    { $replaceRoot: { newRoot: '$user' } },
  ]);
  return users[0] ?? null;
}

export function canManageClan(role: string) {
  return role === 'chief' || role === 'general';
}
