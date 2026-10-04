// app/api/dkp/route.ts
import { NextResponse } from 'next/server';
import { getSheetRoster, updatePlayerDKP } from '@/lib/googleSheets';
import { getAuthenticatedUser } from '@/lib/session';

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
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const roster = await getSheetRoster();
    return NextResponse.json({ success: true, roster, user });
  } catch (error: any) {
    console.error('Failed to load DKP roster:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST endpoint to log boss kill & assign DKP points
export async function POST(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!['chief', 'general'].includes(user.role)) {
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