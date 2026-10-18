import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import BossAward, { type IBossAwardParticipant } from '@/lib/models/BossAward';
import { getSessionUser } from '@/lib/auth/session';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import User from '@/lib/models/User';
import RosterMutation from '@/lib/models/RosterMutation';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { adjustPlayersDKP, getSheetRoster, isDkpMutationApplied } from '@/lib/googleSheets';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { getBossRequestFingerprint, isDkpRequestId, isRosterRowArray } from '@/lib/bossDkp';
import { DkpIntegrityError } from '@/lib/dkpAccounting';
import { guardMutationRequest, readJsonObject, RequestValidationError, requestErrorResponse } from '@/lib/security/request';
import { readHistoryPage, historyCursor, HISTORY_PAGE_SIZE } from '@/lib/historyPagination';

function canManageBossHistory(role: string) {
  return role === 'chief' || role === 'general' || role === 'guardian';
}

function resolveParticipant(participant: IBossAwardParticipant, roster: Awaited<ReturnType<typeof getSheetRoster>>) {
  const matches = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(participant));
  const record = matches.find((candidate) => candidate.rowIndex === participant.rowIndex)
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (!record) throw new DkpIntegrityError(`Toon "${participant.account || participant.owner}" is missing or ambiguous on the roster. A manager must reconcile it before editing this award.`);
  return record;
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const canManage = canManageBossHistory(user.role);
    const page = readHistoryPage(new URL(request.url));
    const [results, roster] = await Promise.all([
      BossAward.find({ status: { $ne: 'deleted' }, ...page }).sort({ createdAt: -1, _id: -1 }).limit(HISTORY_PAGE_SIZE + 1).lean(),
      canManage ? getSheetRoster() : Promise.resolve([]),
    ]);
    const awards = results.slice(0, HISTORY_PAGE_SIZE);
    const selectedRowsFor = (participants: IBossAwardParticipant[]) => participants.flatMap((participant) => {
      try { return [resolveParticipant(participant, roster).rowIndex]; } catch { return []; }
    });
    return NextResponse.json({
      success: true, canManage, roster,
      nextCursor: results.length > HISTORY_PAGE_SIZE ? historyCursor(awards[awards.length - 1]) : null,
      awards: awards.map((award) => ({
        id: award._id.toString(), bossName: award.bossName, points: award.points,
        participants: award.participants, status: award.status,
        createdAt: award.createdAt, updatedAt: award.updatedAt,
        createdBy: award.createdBy, updatedBy: award.updatedBy,
        selectedRows: selectedRowsFor(award.participants),
        ...(canManage ? {
          failureReason: award.status === 'failed'
            ? 'This legacy award requires manager review before it can be changed.'
            : award.failureReason,
          requestId: award.requestId,
          originalSelectedRows: award.participants.map((participant) => participant.rowIndex),
          pendingChange: award.pendingChange ? {
            requestId: award.pendingChange.requestId,
            kind: award.pendingChange.kind,
            selectedRows: award.pendingChange.participants.map((participant) => participant.rowIndex),
          } : undefined,
        } : {}),
      })),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load boss history');
  }
}

async function changeAward(req: Request, kind: 'edit' | 'delete') {
  const rejected = guardMutationRequest(req);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageBossHistory(user.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    await limitMemberRequests(user._id.toString(), 'boss-write');
    const body = await readJsonObject(req);
    const { awardId, requestId } = body;
    const selectedRows = kind === 'delete' ? [] : body.selectedRows;
    if (typeof awardId !== 'string' || !/^[a-f0-9]{24}$/i.test(awardId) || !mongoose.isValidObjectId(awardId)) {
      return NextResponse.json({ error: 'Invalid boss award ID' }, { status: 400 });
    }
    if (!isDkpRequestId(requestId) || !isRosterRowArray(selectedRows, true)) {
      return NextResponse.json({ error: 'A requestId UUID and valid, distinct toon rows are required.' }, { status: 400 });
    }
    let award = await BossAward.findById(awardId);
    if (!award) return NextResponse.json({ error: 'Boss award not found' }, { status: 404 });
    const fingerprint = getBossRequestFingerprint(kind, award.bossName, selectedRows);
    const completed = award.completedRequests?.find((entry) => entry.requestId === requestId);
    if (completed) {
      return completed.fingerprint === fingerprint
        ? NextResponse.json({ success: true, replayed: true, message: 'This attendance change was already completed.' })
        : NextResponse.json({ error: 'This request ID was already used for another attendance change.' }, { status: 409 });
    }

    if (award.status === 'applied') {
      const roster = await getSheetRoster({ fresh: true });
      for (const participant of award.participants) resolveParticipant(participant, roster);
      const rosterByRow = new Map(roster.map((record) => [record.rowIndex, record]));
      const nextParticipants = selectedRows.map((rowIndex) => rosterByRow.get(rowIndex));
      if (nextParticipants.some((record) => record === undefined)) {
        return NextResponse.json({ error: 'One or more selected roster records no longer exist.' }, { status: 400 });
      }
      const claimed = await withClanAdministrationTransaction(async (session) => {
        const actor = await User.findOne({ _id: user._id, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] } }).session(session).lean();
        if (!actor) throw new RequestValidationError('Your role no longer permits attendance changes.', 403);
        const keys = [...award!.participants, ...nextParticipants.filter((record) => record !== undefined)].map(getSheetRecordKey);
        if (await RosterMutation.exists({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: { $in: keys } }).session(session)) throw new RequestValidationError('This kill includes a permanently removed toon. Its forfeited DKP cannot be changed through old attendance records.', 409);
        return BossAward.findOneAndUpdate({ _id: awardId, status: 'applied' }, {
        $set: {
          status: 'updating',
          pendingChange: {
            requestId, fingerprint, kind, updatedBy: user.nickname,
            participants: nextParticipants.map((record) => ({ rowIndex: record!.rowIndex, owner: record!.owner, account: record!.account })),
          },
        },
        }, { new: true, session });
      });
      award = claimed ?? await BossAward.findById(awardId);
    }
    if (!award || award.status !== 'updating' || !award.pendingChange) {
      return NextResponse.json({ error: 'This award is unavailable for editing or requires manager review.' }, { status: 409 });
    }
    const pending = award.pendingChange;
    if (pending.requestId !== requestId || pending.fingerprint !== fingerprint || pending.kind !== kind) {
      return NextResponse.json({ error: 'Another attendance change is in progress. Resume its original request before making another change.' }, { status: 409 });
    }
    const operationKey = `boss-history:${awardId}:${requestId}`;
    let adjustmentCount = 0;
    let financialOperationApplied = await isDkpMutationApplied(operationKey);
    if (!financialOperationApplied) {
      const roster = await getSheetRoster({ fresh: true });
      const previous = new Map(award.participants.map((participant) => {
        const record = resolveParticipant(participant, roster);
        return [record.rowIndex, record];
      }));
      const next = new Map(pending.participants.map((participant) => {
        const record = resolveParticipant(participant, roster);
        return [record.rowIndex, record];
      }));
      const adjustments = [
        ...[...next].filter(([rowIndex]) => !previous.has(rowIndex)).map(([, record]) => ({ ...record, points: award!.points })),
        ...[...previous].filter(([rowIndex]) => !next.has(rowIndex)).map(([, record]) => ({ ...record, points: -award!.points })),
      ];
      adjustmentCount = adjustments.length;
      if (adjustments.length) {
        await adjustPlayersDKP(adjustments, {
          mode: 'weekly-earned', earnedAt: award.createdAt, idempotencyKey: operationKey, actorUserId: user._id.toString(),
        });
        financialOperationApplied = true;
      }
    }
    const finalize = (session?: mongoose.ClientSession) => BossAward.updateOne({ _id: awardId, status: 'updating', 'pendingChange.requestId': requestId }, {
      $set: {
        participants: kind === 'delete' ? [] : pending.participants,
        status: kind === 'delete' ? 'deleted' : 'applied', updatedBy: pending.updatedBy,
      },
      $push: { completedRequests: { requestId, fingerprint } },
      $unset: { pendingChange: 1, failureReason: 1 },
    }, { session });
    if (financialOperationApplied) {
      // A previously authorized financial plan must finish its history even
      // when the initiating account has since been demoted.
      await finalize();
    } else {
      // No-op edits have no financial journal to establish prior authority.
      await withClanAdministrationTransaction(async (session) => {
        const actor = await User.findOne({ _id: user._id, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] } })
          .select('_id').session(session).lean();
        if (!actor) throw new RequestValidationError('Your role no longer permits attendance changes.', 403);
        await finalize(session);
      });
    }
    return NextResponse.json({
      success: true,
      message: kind === 'delete'
        ? `Deleted ${award.bossName} kill and reversed its attendance DKP.`
        : `Updated ${award.bossName} attendance; ${adjustmentCount} toon(s) had DKP adjusted.`,
    });
  } catch (error: unknown) {
    if (error instanceof DkpIntegrityError) return NextResponse.json({ error: error.message }, { status: 409 });
    return requestErrorResponse(error, 'Unable to complete the attendance change. Resume the original request to recover safely.');
  }
}

export async function PATCH(req: Request) { return changeAward(req, 'edit'); }
export async function DELETE(req: Request) { return changeAward(req, 'delete'); }
