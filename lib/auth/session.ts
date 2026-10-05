import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export async function getSessionUser() {
  const token = (await cookies()).get('token')?.value;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === 'string' || typeof payload.userId !== 'string') return null;

    await dbConnect();
    const user = await User.findById(payload.userId).select('_id nickname role status sheetRecordName sheetRecords');
    if (!user || user.status !== 'approved') return null;
    return user;
  } catch {
    return null;
  }
}

export function canManageClan(role: string) {
  return role === 'chief' || role === 'general';
}