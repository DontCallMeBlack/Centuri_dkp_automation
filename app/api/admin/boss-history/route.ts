import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import BossAward, { type IBossAwardParticipant } from '@/lib/models/BossAward';
import { getSessionUser } from '@/lib/auth/session';
import { adjustPlayersDKP, getSheetRoster } from '@/lib/googleSheets';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';

function isRosterRowArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.every((rowIndex): rowIndex is number =>
      typeof rowIndex === 'number' && Number.isInteger(rowIndex)
    ) &&
    new Set(value).size === value.length;
}

function resolveParticipant(
  participant: IBossAwardParticipant,
  roster: Awaited<ReturnType<typeof getSheetRoster>>,
) {
  const matches = roster.filter((record) =>
    getSheetRecordKey(record) === getSheetRecordKey(participant)
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Toon "${participant.account || participant.owner}" is no longer on the roster.`
        : `Toon "${participant.account || participant.owner}" matches multiple roster rows; resolve the duplicate before editing this award.`,
    );
  }
  return matches[0];
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'chief' && user.role !== 'general') {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  try {
    const [awards, roster] = await Promise.all([
      BossAward.find().sort({ createdAt: -1 }).lean(),
      getSheetRoster(),
    ]);
    return NextResponse.json({
      success: true,
      awards: awards.map(({ _id, ...award }) => ({
        ...award,
        id: _id.toString(),
        selectedRows: award.participants.flatMap((participant) => {
          const matches = roster.filter((record) =>
            getSheetRecordKey(record) === getSheetRecordKey(participant)
          );
          return matches.length === 1 ? [matches[0].rowIndex] : [];
        }),
      })),
      roster,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load boss history';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'chief' && user.role !== 'general') {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  try {
    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid boss history update' }, { status: 400 });
    }
    const { awardId, selectedRows } = body as { awardId?: unknown; selectedRows?: unknown };
    if (typeof awardId !== 'string' || !mongoose.isValidObjectId(awardId)) {
      return NextResponse.json({ error: 'Invalid boss award ID' }, { status: 400 });
    }
    if (!isRosterRowArray(selectedRows)) {
      return NextResponse.json({ error: 'Select valid toon rows' }, { status: 400 });
    }

    const award = await BossAward.findOneAndUpdate(
      { _id: awardId, status: 'applied' },
      { $set: { status: 'updating' } },
      { new: true },
    );
    if (!award) {
      const exists = await BossAward.exists({ _id: awardId });
      return NextResponse.json(
        { error: exists ? 'This award is not available for editing right now' : 'Boss award not found' },
        { status: exists ? 409 : 404 },
      );
    }

    let sheetChangesApplied = false;
    try {
      const roster = await getSheetRoster();
      const rosterByRow = new Map(roster.map((record) => [record.rowIndex, record]));
      const selectedRecords = selectedRows.map((rowIndex) => rosterByRow.get(rowIndex));
      if (selectedRecords.some((record) => record === undefined)) {
        throw new Error('One or more selected roster records no longer exist.');
      }
      const nextParticipants = selectedRecords.filter((record) => record !== undefined);
      const previousByKey = new Map(
        award.participants.map((participant) => [
          getSheetRecordKey(participant),
          resolveParticipant(participant, roster),
        ]),
      );
      const nextByKey = new Map(nextParticipants.map((record) => [getSheetRecordKey(record), record]));

      const adjustments = [
        ...nextByKey.entries()
          .filter(([key]) => !previousByKey.has(key))
          .map(([, record]) => ({ ...record, points: award.points })),
        ...previousByKey.entries()
          .filter(([key]) => !nextByKey.has(key))
          .map(([, record]) => ({ ...record, points: -award.points })),
      ];

      if (adjustments.length > 0) {
        await adjustPlayersDKP(adjustments);
        sheetChangesApplied = true;
      }

      award.participants = nextParticipants.map(({ rowIndex, owner, account }) => ({
        rowIndex,
        owner,
        account,
      })) as typeof award.participants;
      award.updatedBy = user.nickname;
      award.status = 'applied';
      award.failureReason = undefined;
      try {
        await award.save();
      } catch (error: unknown) {
        console.error('Failed to save edited boss award after applying sheet changes', error);
        return NextResponse.json({
          error: 'Sheet points were changed, but the boss history could not be saved. Do not retry until the history is checked.',
        }, { status: 500 });
      }

      return NextResponse.json({
        success: true,
        message: `Updated ${award.bossName} attendance; ${adjustments.length} toon(s) had DKP adjusted.`,
      });
    } catch (error: unknown) {
      if (!sheetChangesApplied) {
        award.status = 'applied';
        await award.save();
      }
      const message = sheetChangesApplied
        ? 'Sheet points were changed, but the boss history could not be saved. Do not retry until the history is checked.'
        : error instanceof Error ? error.message : 'Unable to update boss history';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to update boss history';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'chief' && user.role !== 'general') {
    return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
  }

  try {
    const body: unknown = await req.json();
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json({ error: 'Invalid boss history deletion' }, { status: 400 });
    }
    const { awardId } = body as { awardId?: unknown };
    if (typeof awardId !== 'string' || !mongoose.isValidObjectId(awardId)) {
      return NextResponse.json({ error: 'Invalid boss award ID' }, { status: 400 });
    }

    const award = await BossAward.findOneAndUpdate(
      { _id: awardId, status: 'applied' },
      { $set: { status: 'updating' } },
      { new: true },
    );
    if (!award) {
      const existingAward = await BossAward.findById(awardId).select('status').lean();
      return NextResponse.json(
        { error: existingAward ? 'This award is not available for deletion right now' : 'Boss award not found' },
        { status: existingAward ? 409 : 404 },
      );
    }

    let sheetChangesApplied = false;
    try {
      const roster = await getSheetRoster();
      const adjustments = award.participants.map((participant) => ({
        ...resolveParticipant(participant, roster),
        points: -award.points,
      }));

      if (adjustments.length > 0) {
        await adjustPlayersDKP(adjustments);
        sheetChangesApplied = true;
      }

      await award.deleteOne();
      return NextResponse.json({
        success: true,
        message: `Deleted ${award.bossName} kill and reversed ${award.points} DKP for ${adjustments.length} toon(s).`,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to delete boss kill';
      if (sheetChangesApplied) {
        console.error('Failed to delete boss award after reversing its sheet points', error);
        return NextResponse.json({
          error: 'DKP was reversed in Google Sheets, but the boss history could not be deleted. Do not retry until the history is checked.',
        }, { status: 500 });
      }

      award.status = 'applied';
      try {
        await award.save();
      } catch (restoreError: unknown) {
        console.error('Failed to restore boss award after an unsuccessful deletion', restoreError);
        return NextResponse.json({
          error: 'Boss kill deletion failed and its history status could not be restored. Check boss history before retrying.',
        }, { status: 500 });
      }
      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to delete boss kill';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
