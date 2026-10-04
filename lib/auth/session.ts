import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import type { UserRole } from '@/lib/models/User';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export interface AuthenticatedUser {
  id: string;
  nickname: string;
  role: UserRole;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;
  if (!token) return null;

  let userId: string;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === 'string' || typeof payload.userId !== 'string') return null;
    userId = payload.userId;
  } catch {
    return null;
  }

  await dbConnect();
  const user = await User.findById(userId).select('nickname role status').lean();
  if (!user || user.status !== 'approved') return null;

  return { id: user._id.toString(), nickname: user.nickname, role: user.role };
}
