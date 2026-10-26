import { getSessionUser, canManageClan } from '@/lib/auth/session';
import { createHash } from 'node:crypto';
import { changeClanToon, ensureWeeklyDkpReset, getSheetRoster, resetToonDkp } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { ITEM_SUBROLES } from '@/lib/auctionRules';
import { isDkpRequestId } from '@/lib/bossDkp';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { guardMutationRequest, readJsonObject, requestErrorResponse, RequestValidationError } from '@/lib/security/request';
import { DkpIntegrityError } from '@/lib/dkpAccounting';
import RosterMutation from '@/lib/models/RosterMutation';
import User from '@/lib/models/User';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import { withdrawToonOpenAuctionBids } from '@/lib/auctionBidWithdrawal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function name(value: unknown, label: string, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new RequestValidationError(`Enter a valid ${label} of ${allowEmpty ? '0' : '1'}–80 characters.`);
  return value.trim();
}

export async function GET() {
  try {
    const actor = await getSessionUser();
    if (!actor) throw new RequestValidationError('Unauthorized.', 401);
    if (!canManageClan(actor.role)) throw new RequestValidationError('Only Chiefs and Generals can manage clan toons.', 403);
    await limitMemberRequests(actor._id.toString(), 'roster-read');
    const [roster, users, pending] = await Promise.all([
      getSheetRoster(), User.find({ status: 'approved' }).select('nickname sheetRecords sheetRecordName').lean(),
      RosterMutation.findOne({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), status: 'pending' }).select('action owner account rowIndex').lean(),
    ]);
    return Response.json({
      toons: roster.map((toon) => ({ ...toon, linkedAccounts: users.filter((user) => getLinkedSheetRecordRows(user, roster).includes(toon.rowIndex)).map((user) => user.nickname) })),
      pending: pending ? { action: pending.action, owner: pending.owner, account: pending.account } : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return requestErrorResponse(error, 'Unable to load clan toons.'); }
}

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    const actor = await getSessionUser();
    if (!actor) throw new RequestValidationError('Unauthorized.', 401);
    if (!canManageClan(actor.role)) throw new RequestValidationError('Only Chiefs and Generals can manage clan toons.', 403);
    await limitMemberRequests(actor._id.toString(), 'roster-write');
    const body = await readJsonObject(request);
    if (body.action === 'recover') {
      await ensureWeeklyDkpReset();
      return Response.json({ success: true, message: 'The interrupted clan toon change has finished.' });
    }
    if (!isDkpRequestId(body.requestId)) throw new RequestValidationError('A valid request ID is required. Reload this page.');
    const owner = name(body.owner, 'owner');
    const account = name(body.account, 'toon name', body.action === 'remove' || body.action === 'wipe');
    let result;
    if (body.action === 'create') {
      const subClass = ITEM_SUBROLES.find((role) => role !== 'Everyone' && role === body.subClass);
      if (!subClass) throw new RequestValidationError('Choose one of the nine toon subroles.');
      result = await changeClanToon(actor._id.toString(), body.requestId, { action: 'create', owner, account, subClass });
    } else if (body.action === 'remove') {
      if (typeof body.rowIndex !== 'number' || !Number.isInteger(body.rowIndex) || body.rowIndex < 3 || body.rowIndex > 1000) throw new RequestValidationError('Select a valid roster entry.');
      if (body.forfeitConfirmed !== true) throw new RequestValidationError('Confirm permanent removal and DKP forfeiture.');
      result = await changeClanToon(actor._id.toString(), body.requestId, { action: 'remove', rowIndex: body.rowIndex, owner, account });
    } else if (body.action === 'wipe') {
      if (typeof body.rowIndex !== 'number' || !Number.isInteger(body.rowIndex) || body.rowIndex < 3 || body.rowIndex > 1000) throw new RequestValidationError('Select a valid roster entry.');
      if (body.wipeConfirmed !== true) throw new RequestValidationError('Confirm the Available DKP wipe.');
      let bidChanges = { withdrawnBids: 0, promotedBids: 0 };
      result = await resetToonDkp({
        actorUserId: actor._id.toString(), requestId: body.requestId,
        identity: { owner, account }, mode: 'available', fingerprintData: { rowIndex: body.rowIndex },
        mutate: async (session, record, manager, roster) => {
          const rosterWithWeeklyEarned = await getRosterWithWeeklyEarned(roster, session);
          bidChanges = await withdrawToonOpenAuctionBids(record, roster, rosterWithWeeklyEarned, session);
          await ClanAuditEvent.create([{
            eventType: 'toon-dkp-wiped', actorUserId: manager._id, actorNickname: manager.nickname,
            actorRole: manager.role, targetNickname: record.account || record.owner, previousRole: 'toon',
            affectedToon: { rowIndex: record.rowIndex, owner: record.owner, account: record.account },
            operationKey: `${manager._id.toString()}:${body.requestId}`,
            dkpOperationKey: createHash('sha256').update(`toon-dkp:${process.env.GOOGLE_SHEET_ID?.trim()}:${manager._id.toString()}:${body.requestId}`).digest('hex'),
            dkpBefore: [record.weeklyEarned, record.weeklySpent, record.earned, record.spent, record.available, record.fiveWeekActivity]
              .map((value) => value === null ? 'unavailable' : String(value)),
            withdrawnBids: bidChanges.withdrawnBids, promotedBids: bidChanges.promotedBids,
          }], { session });
        },
      });
      if (result.replayed) {
        const audit = await ClanAuditEvent.findOne({ operationKey: `${actor._id.toString()}:${body.requestId}` }).select('withdrawnBids promotedBids').lean();
        bidChanges = { withdrawnBids: audit?.withdrawnBids ?? 0, promotedBids: audit?.promotedBids ?? 0 };
      }
      return Response.json({ success: true, ...result, ...bidChanges,
        message: `Available DKP reset to 0. ${bidChanges.withdrawnBids} open auction bid(s) withdrawn; ${bidChanges.promotedBids} next bid(s) promoted.` });
    } else throw new RequestValidationError('Unknown clan toon action.');
    return Response.json({ success: true, ...result, message: body.action === 'create' ? 'Toon added with zero DKP and no account link.' : 'Toon permanently removed. Its remaining DKP was forfeited and its account links were cleared.' });
  } catch (error) {
    if (error instanceof DkpIntegrityError) return Response.json({ error: error.message }, { status: 409 });
    return requestErrorResponse(error, 'The toon change could not be confirmed. Retry the same request or finish the interrupted change from Clan toons.');
  }
}
