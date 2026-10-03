// app/api/dkp/route.ts
import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { getSheetRoster, updatePlayerDKP } from '@/lib/googleSheets';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

const BOSS_POINTS: { [key: string]: number } = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

// Helper to verify user session from cookies (await cookies() for Next.js 15+)
async function getUserFromCookie() {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string; nickname: string; role: string };
  } catch {
    return null;
  }
}

// GET endpoint to fetch player roster from Google Sheets
export async function GET() {
  const user = await getUserFromCookie();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const roster = await getSheetRoster();
    return NextResponse.json({ success: true, roster });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST endpoint to log boss kill & assign DKP points
export async function POST(req: Request) {
  const user = await getUserFromCookie();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!['chief', 'general', 'guardian'].includes(user.role)) {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  try {
    const { bossName, selectedRows } = await req.json(); 

    const points = BOSS_POINTS[bossName];
    if (points === undefined) {
      return NextResponse.json({ error: 'Invalid boss selection' }, { status: 400 });
    }

    for (const rowIndex of selectedRows) {
      await updatePlayerDKP(rowIndex, points);
    }

    return NextResponse.json({ success: true, message: `Successfully added ${points} DKP points for ${selectedRows.length} members!` });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}