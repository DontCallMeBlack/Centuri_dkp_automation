// app/api/dkp/route.ts
import { NextResponse } from 'next/server';
import { getSheetRoster, updatePlayerDKP } from '@/lib/googleSheets';
import { getAuthenticatedUser } from '@/lib/auth/session';

const BOSS_POINTS: { [key: string]: number } = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

// GET endpoint to fetch player roster from Google Sheets
export async function GET() {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const roster = await getSheetRoster();
    return NextResponse.json({ success: true, roster, user: { nickname: user.nickname, role: user.role } });
  } catch (error) {
    console.error('DKP roster error:', error);
    return NextResponse.json({ error: 'Unable to load roster' }, { status: 500 });
  }
}

// POST endpoint to log boss kill & assign DKP points
export async function POST(req: Request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!['chief', 'general', 'guardian'].includes(user.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    const { bossName, selectedRows } = await req.json(); 

    const points = BOSS_POINTS[bossName];
    if (points === undefined) {
      return NextResponse.json({ error: 'Invalid boss selection' }, { status: 400 });
    }
    if (!Array.isArray(selectedRows) || selectedRows.length === 0 ||
      selectedRows.some((rowIndex) => !Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > 1000)) {
      return NextResponse.json({ error: 'Invalid roster selection' }, { status: 400 });
    }

    for (const rowIndex of selectedRows) {
      await updatePlayerDKP(rowIndex, points);
    }

    return NextResponse.json({ success: true, message: `Successfully added ${points} DKP points for ${selectedRows.length} members!` });
  } catch (error) {
    console.error('DKP update error:', error);
    return NextResponse.json({ error: 'Unable to update DKP' }, { status: 500 });
  }
}