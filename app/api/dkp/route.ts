import { NextResponse } from 'next/server';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster, adjustPlayersDKP } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import BossAward from '@/lib/models/BossAward';
import User from '@/lib/models/User';

const BOSS_POINTS: Record<string, number> = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

function isRosterRowArray(value: unknown, allowEmpty = false): value is number[] {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((rowIndex): rowIndex is number =>
      typeof rowIndex === 'number' && Number.isInteger(rowIndex)
    ) &&
    new Set(value).size === value.length;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const [roster, activeUsers] = await Promise.all([
      getSheetRoster(),
      User.find({ status: 'approved' })
        .select('nickname role sheetRecordName sheetRecords')
        .sort({ nickname: 1 })
        .lean(),
    ]);
    const recordsByRow = new Map(roster.map((record) => [record.rowIndex, record]));
    const sheetRecordRows = getLinkedSheetRecordRows(user, roster);
    const clanMembers = activeUsers.map((member) => ({
      nickname: member.nickname,
      role: member.role,
      toons: getLinkedSheetRecordRows(member, roster)
        .flatMap((rowIndex) => {
          const record = recordsByRow.get(rowIndex);
          return record ? [record] : [];
        }),
    }));
    return NextResponse.json({
      success: true,
      roster,
      clanMembers,
      user: {
        nickname: user.nickname,
        role: user.role,
        sheetRecordRows,
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
    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid boss award request' }, { status: 400 });
    }
    const { bossName, selectedRows } = body as { bossName?: unknown; selectedRows?: unknown };
    if (typeof bossName !== 'string' || !Object.prototype.hasOwnProperty.call(BOSS_POINTS, bossName)) {
      return NextResponse.json({ error: 'Invalid boss selection' }, { status: 400 });
    }
    if (!isRosterRowArray(selectedRows)) {
      return NextResponse.json({ error: 'Select at least one valid roster record' }, { status: 400 });
    }

    const roster = await getSheetRoster();
    const recordsByRow = new Map(roster.map((member) => [member.rowIndex, member]));
    const participants = selectedRows.map((rowIndex) => recordsByRow.get(rowIndex));
    if (participants.some((record) => record === undefined)) {
      return NextResponse.json({ error: 'One or more selected roster records no longer exist' }, { status: 400 });
    }

    const validParticipants = participants.filter((record) => record !== undefined);
    const points = BOSS_POINTS[bossName];
    const award = await BossAward.create({
      bossName,
      points,
      participants: validParticipants,
      createdBy: user.nickname,
      status: 'pending',
    });

    try {
      await adjustPlayersDKP(validParticipants.map(({ rowIndex, owner, account }) => ({
        rowIndex,
        points,
        owner,
        account,
      })));
    } catch (error: unknown) {
      award.status = 'failed';
      award.failureReason = error instanceof Error ? error.message : 'Unable to apply award to Google Sheets';
      await award.save();
      throw error;
    }

    award.status = 'applied';
    try {
      await award.save();
    } catch (error: unknown) {
      console.error('Failed to mark applied boss award in history', error);
      return NextResponse.json({
        error: 'DKP points were applied, but the boss history could not be marked complete. Check boss history before retrying.',
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `${bossName} recorded: +${points} DKP for ${validParticipants.length} toon(s)`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to record the boss award';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}