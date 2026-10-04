import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

export interface AuthenticatedUser {
  userId: string;
  nickname: string;
  role: string;
  status: string;
  sheetRecordName?: string;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const token = (await cookies()).get('token')?.value;
  if (!token) return null;

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === 'string' || typeof decoded.userId !== 'string') return null;
    payload = decoded;
  } catch {
    return null;
  }

  await dbConnect();
  const user = await User.findById(payload.userId).select(
    '_id nickname role status sheetRecordName'
  );
  if (!user || user.status !== 'approved') return null;

  return {
    userId: user._id.toString(),
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    sheetRecordName: user.sheetRecordName,
  };
}

export async function getAdminUser(): Promise<AuthenticatedUser | null> {
  const user = await getAuthenticatedUser();
  return user && ['chief', 'general'].includes(user.role) ? user : null;
}
