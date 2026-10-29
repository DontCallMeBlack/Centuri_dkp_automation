import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster, getSheetRosterSnapshot, adjustPlayersDKP } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';
import BossAward from '@/lib/models/BossAward';
import User from '@/lib/models/User';
import { BOSS_DKP_POINTS, getBossRequestFingerprint, isDkpRequestId, isRosterRowArray } from '@/lib/bossDkp';
import { DkpIntegrityError } from '@/lib/dkpAccounting';
import { guardMutationRequest, readJsonObject, requestErrorResponse } from '@/lib/security/request';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import RosterMutation from '@/lib/models/RosterMutation';
import { RequestValidationError } from '@/lib/security/request';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import { getEffectiveToonRole, isApprovedToonRoleSchedule } from '@/lib/toonRoleChanges';


export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const fresh = new URL(req.url).searchParams.get('fresh') === '1' &&
      (canManageClan(user.role) || user.role === 'guardian');
    const [rosterSnapshot, activeUsers] = await Promise.all([
      getSheetRosterSnapshot({ fresh }),
      User.find({ status: 'approved' })
        .select('nickname role sheetRecordName sheetRecords')
        .sort({ nickname: 1 })
        .lean(),
    ]);
    const roster = rosterSnapshot.roster;
    const identities = roster.map(getSheetRecordKey);
    const [roleChanges, roleApprovals] = await Promise.all([
      ToonRoleChange.find({ identityKey: { $in: identities } }).lean(),
      ToonRoleChangeRequest.find({
        identityKey: { $in: identities }, status: { $in: ['approved', 'applied'] },
        decidedByUserId: { $exists: true }, decidedAt: { $exists: true },
      }).sort({ createdAt: -1 }).lean(),
    ]);
    const roleChangesByIdentity = new Map(roleChanges.map((change) => [change.identityKey, change] as const));
    const roleApprovalsByIdentity = new Map<string, typeof roleApprovals>();
    for (const approval of roleApprovals) {
      roleApprovalsByIdentity.set(approval.identityKey, [...(roleApprovalsByIdentity.get(approval.identityKey) ?? []), approval]);
    }
    const roleReadAt = new Date();
    const effectiveRoster = roster.map((record) => {
      const identityKey = getSheetRecordKey(record);
      const change = roleChangesByIdentity.get(identityKey);
      const approval = roleApprovalsByIdentity.get(identityKey)?.find((candidate) => isApprovedToonRoleSchedule(change, candidate));
      return { ...record, subClass: getEffectiveToonRole(record.subClass, change, roleReadAt, approval) };
    });
    const recordsByRow = new Map(effectiveRoster.map((record) => [record.rowIndex, record]));
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
      roster: effectiveRoster,
      rosterSync: {
        fetchedAt: rosterSnapshot.fetchedAt.toISOString(),
        stale: rosterSnapshot.stale,
        refreshDelayed: rosterSnapshot.refreshDelayed,
      },
      clanMembers,
      user: {
        nickname: user.nickname,
        role: user.role,
        sheetRecordRows,
      },
    });
  } catch (error: unknown) {
    return requestErrorResponse(error, 'Unable to load the Google Sheets roster');
  }
}

export async function POST(req: Request) {
  const rejected = guardMutationRequest(req);
  if (rejected) return rejected;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageClan(user.role) && user.role !== 'guardian') return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    await limitMemberRequests(user._id.toString(), 'boss-write');
    const { bossName, selectedRows, requestId } = await readJsonObject(req);
    if (!isDkpRequestId(requestId)) {
      return NextResponse.json({ error: 'A valid requestId UUID is required. Retry interrupted actions with the same request ID.' }, { status: 400 });
    }
    if (typeof bossName !== 'string' || !Object.prototype.hasOwnProperty.call(BOSS_DKP_POINTS, bossName)) {
      return NextResponse.json({ error: 'Invalid boss selection' }, { status: 400 });
    }
    if (!isRosterRowArray(selectedRows)) {
      return NextResponse.json({ error: 'Select at least one valid roster record' }, { status: 400 });
    }

    const fingerprint = getBossRequestFingerprint('grant', bossName, selectedRows);
    // The default MongoDB _id index enforces request uniqueness even before a
    // deployment has built the additional sparse requestId index.
    const awardId = createHash('sha256').update(`boss-award:${requestId}`).digest('hex').slice(0, 24);
    let award = await BossAward.findById(awardId);
    if (!award) {
      const roster = await getSheetRoster({ fresh: true });
      const recordsByRow = new Map(roster.map((member) => [member.rowIndex, member]));
      const participants = selectedRows.map((rowIndex) => recordsByRow.get(rowIndex));
      if (participants.some((record) => record === undefined)) {
        return NextResponse.json({ error: 'One or more selected roster records no longer exist' }, { status: 400 });
      }
      try {
        award = await withClanAdministrationTransaction(async (session) => {
          const actor = await User.findOne({ _id: user._id, status: 'approved', role: { $in: ['chief', 'general', 'guardian'] } }).session(session).lean();
          if (!actor) throw new RequestValidationError('Your role no longer permits boss awards.', 403);
          if (await RosterMutation.exists({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: { $in: participants.map((record) => getSheetRecordKey(record!)) } }).session(session)) throw new RequestValidationError('A selected toon was permanently removed. Refresh the roster before recording this kill.', 409);
          const [created] = await BossAward.create([{
          _id: awardId, requestId, requestFingerprint: fingerprint,
          bossName, points: BOSS_DKP_POINTS[bossName],
          participants: participants.map((record) => ({ rowIndex: record!.rowIndex, owner: record!.owner, account: record!.account })),
          createdBy: user.nickname, status: 'pending',
          }], { session });
          return created;
        });
      } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error;
        award = await BossAward.findById(awardId);
        if (!award) throw error;
      }
    }
    if (award.requestId !== requestId || award.requestFingerprint !== fingerprint ||
      (award.createdBy !== user.nickname && !canManageClan(user.role))) {
      return NextResponse.json({ error: 'This request ID belongs to a different boss award.' }, { status: 409 });
    }
    if (award.status === 'applied') return NextResponse.json({ success: true, message: 'This boss award was already recorded.', replayed: true });
    if (award.status !== 'pending') return NextResponse.json({ error: 'This award is being edited or requires manager review.' }, { status: 409 });

    try {
      await adjustPlayersDKP(award.participants.map(({ rowIndex, owner, account }) => ({
        rowIndex,
        points: award.points,
        owner,
        account,
      })), { mode: 'weekly-earned', idempotencyKey: `boss-award:${awardId}`, earnedAt: award.createdAt, actorUserId: user._id.toString() });
    } catch (error: unknown) {
      // A timed-out Sheets write may have succeeded. Keep the original request
      // recoverable; a fresh request must never be encouraged as a retry.
      await BossAward.updateOne({ _id: awardId, status: 'pending' }, {
        $set: { failureReason: error instanceof DkpIntegrityError ? error.message : 'Award interrupted. Resume this request to recover it safely.' },
      });
      throw error;
    }

    try {
      await BossAward.updateOne({ _id: awardId, status: 'pending' }, { $set: { status: 'applied' }, $unset: { failureReason: 1 } });
    } catch (error: unknown) {
      console.error('Failed to mark applied boss award in history', error instanceof Error ? error.name : 'UnknownError');
      return NextResponse.json({
        error: 'DKP points were applied, but the boss history could not be marked complete. Check boss history before retrying.',
      }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `${bossName} recorded: +${award.points} DKP for ${award.participants.length} toon(s)`,
    });
  } catch (error: unknown) {
    if (error instanceof DkpIntegrityError) return NextResponse.json({ error: error.message }, { status: 409 });
    return requestErrorResponse(error, 'Unable to complete the boss award. Retry using the same request ID.');
  }
}
