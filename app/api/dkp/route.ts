import { NextResponse } from 'next/server';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster, updatePlayerDKP } from '@/lib/googleSheets';

const BOSS_POINTS: Record<string, number> = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const roster = await getSheetRoster();
    return NextResponse.json({
      success: true,
      roster,
      user: {
        nickname: user.nickname,
        role: user.role,
        sheetRecordName: user.sheetRecordName,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load the Google Sheets roster';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageClan(user.role) && user.role !== 'guardian') {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  try {
    const { bossName, selectedRows } = await req.json();
    if (typeof bossName !== 'string' || !Object.prototype.hasOwnProperty.call(BOSS_POINTS, bossName)) {
      return NextResponse.json({ error: 'Invalid boss selection' }, { status: 400 });
    }
    if (!Array.isArray(selectedRows) || selectedRows.length === 0 || !selectedRows.every(Number.isInteger)) {
      return NextResponse.json({ error: 'Select at least one valid roster record' }, { status: 400 });
    }
    if (new Set(selectedRows).size !== selectedRows.length) {
      return NextResponse.json({ error: 'Duplicate roster records are not allowed' }, { status: 400 });
    }

    const roster = await getSheetRoster();
    const rosterRows = new Set(roster.map((member) => member.rowIndex));
    if (!selectedRows.every((rowIndex: number) => rosterRows.has(rowIndex))) {
      return NextResponse.json({ error: 'One or more selected roster records no longer exist' }, { status: 400 });
    }

    const points = BOSS_POINTS[bossName];
    for (const rowIndex of selectedRows as number[]) {
      await updatePlayerDKP(rowIndex, points);
    }

    return NextResponse.json({
      success: true,
      message: `${bossName} recorded: +${points} DKP for ${selectedRows.length} roster member(s)`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to record the boss award';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}