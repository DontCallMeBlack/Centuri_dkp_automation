import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import BossAward, { type IBossAwardAuditEntry, type IBossAwardParticipant } from '@/lib/models/BossAward';
import { getSessionUser } from '@/lib/auth/session';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import User from '@/lib/models/User';
import RosterMutation from '@/lib/models/RosterMutation';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { adjustPlayersDKP, getSheetRoster, isDkpMutationApplied } from '@/lib/googleSheets';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { getBossRequestFingerprint, isBossAttendanceRemovalReason, isDkpRequestId, isRosterRowArray, type BossAttendanceRemovalReason } from '@/lib/bossDkp';
import { getCurrentDkpWeekStart } from '@/lib/dkpCycle';
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

function resolveHistoricalParticipant(participant: IBossAwardParticipant, roster: Awaited<ReturnType<typeof getSheetRoster>>) {
  const matches = roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(participant));
  if (matches.length === 0) return undefined;
  const record = matches.find((candidate) => candidate.rowIndex === participant.rowIndex)
    ?? (matches.length === 1 ? matches[0] : undefined);
  if (!record) throw new DkpIntegrityError(`Toon "${participant.account || participant.owner}" is ambiguous on the roster. A manager must reconcile it before editing this award.`);
  return record;
}

function validateRemovalReasons(
  value: unknown,
  previousParticipants: IBossAwardParticipant[],
  nextParticipants: Array<{ owner: string; account: string }>,
) {
  const nextKeys = new Set(nextParticipants.map(getSheetRecordKey));
  const removed = previousParticipants.filter((participant) => !nextKeys.has(getSheetRecordKey(participant)));
  const expectedByKey = new Map(removed.map((participant) => [getSheetRecordKey(participant), participant]));

  if (expectedByKey.size !== removed.length) {
    throw new DkpIntegrityError('This award has duplicate toon identities. Reconcile the record before changing attendance.');
  }
  if (removed.length === 0 && value === undefined) return [];
  if (!Array.isArray(value) || value.length !== removed.length) {
    throw new RequestValidationError('Choose a reason for every toon being removed from this kill.', 400);
  }

  const reasonByKey = new Map<string, BossAttendanceRemovalReason>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || !('owner' in entry) || !('account' in entry) || !('reason' in entry)) {
      throw new RequestValidationError('Each removal needs a toon and a valid reason.', 400);
    }
    const candidate = entry as { owner: unknown; account: unknown; reason: unknown };
    if (typeof candidate.owner !== 'string' || typeof candidate.account !== 'string' || !isBossAttendanceRemovalReason(candidate.reason)) {
      throw new RequestValidationError('Each removal needs a toon and a valid reason.', 400);
    }
    const key = getSheetRecordKey({ owner: candidate.owner, account: candidate.account });
    if (!expectedByKey.has(key) || reasonByKey.has(key)) {
      throw new RequestValidationError('Removal reasons must match each removed toon exactly once.', 400);
    }
    reasonByKey.set(key, candidate.reason);
  }

  if (reasonByKey.size !== expectedByKey.size) {
    throw new RequestValidationError('Choose a reason for every toon being removed from this kill.', 400);
  }

  return removed.map((participant) => ({
    owner: participant.owner,
    account: participant.account,
    reason: reasonByKey.get(getSheetRecordKey(participant)) as NonNullable<IBossAwardAuditEntry['reason']>,
  }));
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const canManage = canManageBossHistory(user.role);
    const page = readHistoryPage(new URL(request.url));
    const [results, roster] = await Promise.all([
      BossAward.find({ status: { $ne: 'deleted' }, ...page }).sort({ createdAt: -1, _id: -1 }).limit(HISTORY_PAGE_SIZE + 1).lean(),
      getSheetRoster(),
    ]);
    const now = new Date();
    const currentWeekStart = getCurrentDkpWeekStart(now);
    const awards = results.slice(0, HISTORY_PAGE_SIZE);
    const decorateParticipant = (participant: IBossAwardParticipant) => ({
      ...participant,
      subClass: participant.subClass || roster.find((record) => getSheetRecordKey(record) === getSheetRecordKey(participant))?.subClass || '',
    });
    const selectedRowsFor = (participants: IBossAwardParticipant[]) => participants.flatMap((participant) => {
      try { return [resolveParticipant(participant, roster).rowIndex]; } catch { return []; }
    });
    return NextResponse.json({
      success: true, canManage, roster: canManage ? roster : [],
      nextCursor: results.length > HISTORY_PAGE_SIZE ? historyCursor(awards[awards.length - 1]) : null,
      awards: awards.map((award) => ({
        id: award._id.toString(), bossName: award.bossName, points: award.points,
        participants: award.participants.map(decorateParticipant), status: award.status,
        createdAt: award.createdAt, updatedAt: award.updatedAt,
        createdBy: award.createdBy, updatedBy: award.updatedBy,
        auditTrail: (award.auditTrail ?? []).filter((entry) => !(
          entry.kind === 'participant_added' &&
          entry.actor === award.createdBy &&
          entry.occurredAt.getTime() <= award.createdAt.getTime()
        )).map((entry) => ({
          ...entry,
          ...(entry.participant ? { participant: decorateParticipant(entry.participant) } : {}),
        })),
        canModify: award.status === 'applied' && award.createdAt >= currentWeekStart,
        selectedRows: canManage ? selectedRowsFor(award.participants) : [],
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
            removalReasons: award.pendingChange.removalReasons,
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
      const weeklyResetStart = getCurrentDkpWeekStart();
      if (award.createdAt < weeklyResetStart) {
        return NextResponse.json({
          error: 'This kill is from a previous week and is locked after the Sunday DKP reset.',
        }, { status: 409 });
      }
      const roster = await getSheetRoster({ fresh: true });
      const rosterByRow = new Map(roster.map((record) => [record.rowIndex, record]));
      const nextParticipants = selectedRows.map((rowIndex) => rosterByRow.get(rowIndex));
      if (nextParticipants.some((record) => record === undefined)) {
        return NextResponse.json({ error: 'One or more selected roster records no longer exist.' }, { status: 400 });
      }
      const removalReasons = kind === 'edit'
        ? validateRemovalReasons(body.removalReasons, award.participants, nextParticipants as Array<{ owner: string; account: string }>)
        : [];
      const claimed = await withClanAdministrationTransaction(async (session) => {
        const actor = await User.findOne({ _id: user._id, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] } }).session(session).lean();
        if (!actor) throw new RequestValidationError('Your role no longer permits attendance changes.', 403);
        const keys = nextParticipants.filter((record) => record !== undefined).map((record) => getSheetRecordKey(record!));
        if (await RosterMutation.exists({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: { $in: keys } }).session(session)) throw new RequestValidationError('This kill includes a permanently removed toon. Its forfeited DKP cannot be changed through old attendance records.', 409);
        return BossAward.findOneAndUpdate({ _id: awardId, status: 'applied', createdAt: { $gte: weeklyResetStart } }, {
        $set: {
          status: 'updating',
          pendingChange: {
            requestId, fingerprint, kind, updatedBy: user.nickname,
            participants: nextParticipants.map((record) => ({ rowIndex: record!.rowIndex, owner: record!.owner, account: record!.account, subClass: record!.subClass })),
            ...(kind === 'edit' ? { removalReasons } : {}),
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
    const roster = await getSheetRoster({ fresh: true });
    const resolvedPrevious = award.participants.map((participant) => resolveHistoricalParticipant(participant, roster));
    const skippedParticipantCount = resolvedPrevious.filter((record) => record === undefined).length;
    const previous = new Map(resolvedPrevious.flatMap((record) => record ? [[getSheetRecordKey(record), record] as const] : []));
    const next = new Map(pending.participants.map((participant) => {
      const record = resolveParticipant(participant, roster);
      return [getSheetRecordKey(record), record];
    }));
    const adjustments = [
      ...[...next].filter(([identity]) => !previous.has(identity)).map(([, record]) => ({ ...record, points: award!.points })),
      ...[...previous].filter(([identity]) => !next.has(identity)).map(([, record]) => ({ ...record, points: -award!.points })),
    ];
    const auditAt = new Date();
    const auditEntries: IBossAwardAuditEntry[] = kind === 'delete'
      ? [{ kind: 'kill_deleted', changeId: requestId, actor: pending.updatedBy, occurredAt: auditAt }]
      : (() => {
        const previousKeys = new Set(award!.participants.map(getSheetRecordKey));
        const nextKeys = new Set(pending.participants.map(getSheetRecordKey));
        const reasonByKey = new Map((pending.removalReasons ?? []).map((entry) => [getSheetRecordKey(entry), entry.reason]));
        return [
          ...pending.participants
            .filter((participant) => !previousKeys.has(getSheetRecordKey(participant)))
            .map((participant) => ({ kind: 'participant_added' as const, changeId: requestId, participant, actor: pending.updatedBy, occurredAt: auditAt })),
          ...award!.participants
            .filter((participant) => !nextKeys.has(getSheetRecordKey(participant)))
            .map((participant) => ({
              kind: 'participant_removed' as const,
              changeId: requestId,
              participant,
              ...(reasonByKey.has(getSheetRecordKey(participant)) ? { reason: reasonByKey.get(getSheetRecordKey(participant))! } : {}),
              actor: pending.updatedBy,
              occurredAt: auditAt,
            })),
        ];
      })();
    const adjustmentCount = adjustments.length;
    let financialOperationApplied = await isDkpMutationApplied(operationKey);
    if (!financialOperationApplied) {
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
      $push: {
        completedRequests: { requestId, fingerprint },
        ...(auditEntries.length ? { auditTrail: { $each: auditEntries } } : {}),
      },
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
        ? `Deleted ${award.bossName} kill and reversed DKP for ${adjustmentCount} available toon(s)${skippedParticipantCount ? `; skipped ${skippedParticipantCount} removed toon(s)` : ''}.`
        : `Updated ${award.bossName} attendance; ${adjustmentCount} toon(s) had DKP adjusted.`,
    });
  } catch (error: unknown) {
    if (error instanceof DkpIntegrityError) return NextResponse.json({ error: error.message }, { status: 409 });
    return requestErrorResponse(error, 'Unable to complete the attendance change. Resume the original request to recover safely.');
  }
}

export async function PATCH(req: Request) { return changeAward(req, 'edit'); }
export async function DELETE(req: Request) { return changeAward(req, 'delete'); }
