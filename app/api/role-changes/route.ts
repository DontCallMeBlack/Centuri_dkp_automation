import mongoose from 'mongoose';
import { NextResponse } from 'next/server';
import User from '@/lib/models/User';
import ToonRoleChange from '@/lib/models/ToonRoleChange';
import ToonRoleChangeAudit from '@/lib/models/ToonRoleChangeAudit';
import ToonRoleChangeRequest from '@/lib/models/ToonRoleChangeRequest';
import { getSessionUser } from '@/lib/auth/session';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { guardMutationRequest, readJsonObject, requestErrorResponse, RequestValidationError } from '@/lib/security/request';
import { getAlternateToonSubrole } from '@/lib/auctionRules';
import { getEffectiveToonRole, getNextRoleChangeAt, ROLE_CHANGE_TIME_ZONE } from '@/lib/toonRoleChanges';

const privateHeaders = { 'Cache-Control': 'private, no-store' };
const OPEN_REQUEST_STATUSES = ['pending', 'approved'] as const;

async function expireDueRequests(now = new Date()) {
  if (!await ToonRoleChangeRequest.exists({ status: { $in: OPEN_REQUEST_STATUSES }, effectiveAt: { $lte: now } })) return;
  await withClanAdministrationTransaction(async (session) => {
    const dueRequests = await ToonRoleChangeRequest.find({
      status: { $in: OPEN_REQUEST_STATUSES }, effectiveAt: { $lte: now },
    }).session(session).lean();
    const expiredRequests = dueRequests.filter((request) => request.status === 'pending');
    const appliedRequestIds = dueRequests.filter((request) => request.status === 'approved').map((request) => request._id);
    if (expiredRequests.length) {
      await ToonRoleChangeRequest.updateMany(
        { _id: { $in: expiredRequests.map((request) => request._id) }, status: 'pending' },
        { $set: { status: 'expired' } }, { session },
      );
      await ToonRoleChangeAudit.insertMany(expiredRequests.map((request) => ({
        action: 'expired' as const, identityKey: request.identityKey, owner: request.owner, account: request.account,
        previousRole: request.currentRole, scheduledRole: request.requestedRole, effectiveAt: request.effectiveAt,
        actorNickname: 'System', actorRole: 'system' as const,
      })), { session });
    }
    if (appliedRequestIds.length) await ToonRoleChangeRequest.updateMany(
      { _id: { $in: appliedRequestIds }, status: 'approved' }, { $set: { status: 'applied' } }, { session },
    );
  });
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new RequestValidationError('Unauthorized.', 401);
    await limitMemberRequests(user._id.toString(), 'role-read');
    await expireDueRequests(new Date());
    const now = new Date();
    const roster = await getSheetRoster();
    const isGeneral = user.role === 'general';
    const linkedRows = new Set(getLinkedSheetRecordRows(user, roster));
    const visibleToons = isGeneral ? roster : roster.filter((toon) => linkedRows.has(toon.rowIndex));
    const identities = [...new Set(visibleToons.map(getSheetRecordKey))];
    const [changes, requests] = await Promise.all([
      ToonRoleChange.find({ identityKey: { $in: identities } }).lean(),
      ToonRoleChangeRequest.find({
        identityKey: { $in: identities }, status: { $in: OPEN_REQUEST_STATUSES }, effectiveAt: { $gt: now },
      }).sort({ createdAt: -1 }).lean(),
    ]);
    const auditQuery = isGeneral ? {} : { identityKey: { $in: identities } };
    const audit = await ToonRoleChangeAudit.find(auditQuery).sort({ createdAt: -1 }).limit(100).lean();
    const changesByIdentity = new Map(changes.map((change) => [change.identityKey, change] as const));
    const requestsByIdentity = new Map(requests.map((request) => [request.identityKey, request] as const));
    const countsByIdentity = new Map<string, number>();
    for (const toon of roster) {
      const identityKey = getSheetRecordKey(toon);
      countsByIdentity.set(identityKey, (countsByIdentity.get(identityKey) ?? 0) + 1);
    }
    const toons = visibleToons.map((toon) => {
      const identityKey = getSheetRecordKey(toon);
      const change = changesByIdentity.get(identityKey);
      const request = requestsByIdentity.get(identityKey);
      return {
        rowIndex: toon.rowIndex,
        owner: toon.owner,
        account: toon.account,
        currentRole: getEffectiveToonRole(toon.subClass, change, now),
        scheduledRole: request?.status === 'approved' ? request.requestedRole : null,
        effectiveAt: request?.status === 'approved' ? request.effectiveAt.toISOString() : null,
        request: request ? {
          id: request._id.toString(), status: request.status, requestedRole: request.requestedRole,
          requestedByNickname: request.requestedByNickname, createdAt: request.createdAt.toISOString(),
          decidedByNickname: request.decidedByNickname ?? null,
          effectiveAt: request.effectiveAt.toISOString(),
        } : null,
        canRequest: linkedRows.has(toon.rowIndex) && !request,
        canCancel: Boolean(request && (isGeneral || linkedRows.has(toon.rowIndex))),
        duplicateIdentity: (countsByIdentity.get(identityKey) ?? 0) > 1,
      };
    });

    return NextResponse.json({
      isGeneral,
      toons,
      nextChangeAt: getNextRoleChangeAt(now).toISOString(),
      timeZone: 'EST (UTC-05:00)',
      audit: audit.map((entry) => ({
        id: entry._id.toString(), action: entry.action, owner: entry.owner, account: entry.account,
        previousRole: entry.previousRole, scheduledRole: entry.scheduledRole,
        effectiveAt: entry.effectiveAt?.toISOString() ?? null,
        actorUserId: entry.actorUserId?.toString() ?? null, actorNickname: entry.actorNickname,
        actorRole: entry.actorRole, createdAt: entry.createdAt.toISOString(),
      })),
    }, { headers: privateHeaders });
  } catch (error) {
    return requestErrorResponse(error, 'Unable to load role change requests.');
  }
}

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    const user = await getSessionUser();
    if (!user) throw new RequestValidationError('Unauthorized.', 401);
    await limitMemberRequests(user._id.toString(), 'role-write');
    await expireDueRequests(new Date());
    const body = await readJsonObject(request);
    if (!['request', 'approve', 'deny', 'cancel'].includes(String(body.action))) {
      throw new RequestValidationError('Choose a valid role request action.');
    }
    const action = body.action as 'request' | 'approve' | 'deny' | 'cancel';
    if (action === 'request') {
      if (typeof body.rowIndex !== 'number' || !Number.isInteger(body.rowIndex) || body.rowIndex < 3 || body.rowIndex > 1000) {
        throw new RequestValidationError('Choose one of your linked toons.');
      }
      const roster = await getSheetRoster({ fresh: true });
      const toon = roster.find((record) => record.rowIndex === body.rowIndex);
      if (!toon) throw new RequestValidationError('This toon is no longer in the roster. Refresh and try again.', 409);
      const identityKey = getSheetRecordKey(toon);
      if (roster.filter((record) => getSheetRecordKey(record) === identityKey).length !== 1) {
        throw new RequestValidationError('This toon has a duplicate roster identity. Ask clan leadership to correct it before requesting a change.', 409);
      }
      const result = await withClanAdministrationTransaction(async (session) => {
        const actor = await User.findOne({ _id: user._id, status: 'approved' })
          .select('_id nickname role sheetRecords sheetRecordName').session(session);
        if (!actor) throw new RequestValidationError('Your session is no longer authorized.', 401);
        if (!getLinkedSheetRecordRows(actor, roster).includes(toon.rowIndex)) {
          throw new RequestValidationError('You can only request a role change for one of your linked toons.', 403);
        }
        const now = new Date();
        const existing = await ToonRoleChangeRequest.findOne({
          identityKey, status: { $in: OPEN_REQUEST_STATUSES }, effectiveAt: { $gt: now },
        }).session(session);
        if (existing) throw new RequestValidationError('This toon already has an open request or scheduled change.', 409);
        const change = await ToonRoleChange.findOne({ identityKey }).session(session);
        const currentRole = getEffectiveToonRole(toon.subClass, change, now).trim();
        const requestedRole = getAlternateToonSubrole(currentRole);
        if (!requestedRole) throw new RequestValidationError('This toon has no alternate subclass within its current class.');
        const effectiveAt = getNextRoleChangeAt(now);
        const [created] = await ToonRoleChangeRequest.create([{
          identityKey, owner: toon.owner, account: toon.account, currentRole, requestedRole,
          effectiveAt, status: 'pending', requestedByUserId: actor._id, requestedByNickname: actor.nickname,
        }], { session });
        await ToonRoleChangeAudit.create([{
          action: 'requested', identityKey, owner: toon.owner, account: toon.account,
          previousRole: currentRole, scheduledRole: requestedRole, effectiveAt,
          actorUserId: actor._id, actorNickname: actor.nickname, actorRole: actor.role,
        }], { session });
        return { requestId: created._id.toString(), requestedRole, effectiveAt };
      });
      return NextResponse.json({ success: true, ...result, message: `Request for ${result.requestedRole} sent to clan Generals. It expires if not reviewed by ${result.effectiveAt.toLocaleDateString('en-US', { timeZone: ROLE_CHANGE_TIME_ZONE, month: 'long', day: 'numeric', year: 'numeric' })}.` }, { headers: privateHeaders });
    }

    if (typeof body.requestId !== 'string' || !mongoose.isValidObjectId(body.requestId)) {
      throw new RequestValidationError('Choose a valid role change request.');
    }
    const roster = await getSheetRoster({ fresh: true });
    const result = await withClanAdministrationTransaction(async (session) => {
      const actor = await User.findOne({ _id: user._id, status: 'approved' })
        .select('_id nickname role sheetRecords sheetRecordName').session(session);
      if (!actor) throw new RequestValidationError('Your session is no longer authorized.', 401);
      const roleRequest = await ToonRoleChangeRequest.findById(body.requestId).session(session);
      if (!roleRequest) throw new RequestValidationError('Role change request not found.', 404);
      const now = new Date();
      const toon = roster.find((record) => getSheetRecordKey(record) === roleRequest.identityKey);
      if (!toon) throw new RequestValidationError('This toon is no longer in the roster.', 409);
      if (action === 'approve' && roster.filter((record) => getSheetRecordKey(record) === roleRequest.identityKey).length !== 1) {
        throw new RequestValidationError('This toon has a duplicate roster identity. Reconcile it before processing the request.', 409);
      }

      if (action === 'approve' || action === 'deny') {
        if (actor.role !== 'general') throw new RequestValidationError('Only General accounts can approve or deny role requests.', 403);
        if (roleRequest.status !== 'pending' || roleRequest.effectiveAt.getTime() <= now.getTime()) {
          throw new RequestValidationError('This request is no longer waiting for review.', 409);
        }
        if (action === 'approve') {
          const currentChange = await ToonRoleChange.findOne({ identityKey: roleRequest.identityKey }).session(session);
          const currentRole = getEffectiveToonRole(toon.subClass, currentChange, now).trim();
          if (getAlternateToonSubrole(currentRole) !== roleRequest.requestedRole) {
            throw new RequestValidationError('The requested subclass no longer matches this toon’s class. Ask the member to submit a new request.', 409);
          }
          if (currentChange) {
            currentChange.owner = toon.owner;
            currentChange.account = toon.account;
            currentChange.currentRole = currentRole;
            currentChange.scheduledRole = roleRequest.requestedRole;
            currentChange.effectiveAt = roleRequest.effectiveAt;
            currentChange.updatedByUserId = actor._id;
            currentChange.updatedByNickname = actor.nickname;
            await currentChange.save({ session });
          } else {
            await ToonRoleChange.create([{
              identityKey: roleRequest.identityKey, owner: toon.owner, account: toon.account,
              currentRole, scheduledRole: roleRequest.requestedRole, effectiveAt: roleRequest.effectiveAt,
              updatedByUserId: actor._id, updatedByNickname: actor.nickname,
            }], { session });
          }
          roleRequest.currentRole = currentRole;
          roleRequest.status = 'approved';
          roleRequest.decidedByUserId = actor._id;
          roleRequest.decidedByNickname = actor.nickname;
          roleRequest.decidedAt = now;
          await roleRequest.save({ session });
        } else {
          roleRequest.status = 'denied';
          roleRequest.decidedByUserId = actor._id;
          roleRequest.decidedByNickname = actor.nickname;
          roleRequest.decidedAt = now;
          await roleRequest.save({ session });
        }
      } else {
        const isGeneral = actor.role === 'general';
        const linked = getLinkedSheetRecordRows(actor, roster).includes(toon.rowIndex);
        if (!isGeneral && !linked) throw new RequestValidationError('You can only cancel a request for one of your linked toons.', 403);
        if ((roleRequest.status !== 'pending' && roleRequest.status !== 'approved') || roleRequest.effectiveAt.getTime() <= now.getTime()) {
          throw new RequestValidationError('Only an upcoming request or scheduled change can be cancelled.', 409);
        }
        if (roleRequest.status === 'approved') {
          const currentChange = await ToonRoleChange.findOne({ identityKey: roleRequest.identityKey }).session(session);
          if (!currentChange || currentChange.effectiveAt?.getTime() !== roleRequest.effectiveAt.getTime()) {
            throw new RequestValidationError('The scheduled toon role changed. Refresh the page and try again.', 409);
          }
          currentChange.scheduledRole = undefined;
          currentChange.effectiveAt = undefined;
          currentChange.updatedByUserId = actor._id;
          currentChange.updatedByNickname = actor.nickname;
          await currentChange.save({ session });
        }
        roleRequest.status = 'cancelled';
        roleRequest.decidedByUserId = actor._id;
        roleRequest.decidedByNickname = actor.nickname;
        roleRequest.decidedAt = now;
        await roleRequest.save({ session });
      }

      const auditAction = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'cancelled';
      await ToonRoleChangeAudit.create([{
        action: auditAction, identityKey: roleRequest.identityKey, owner: roleRequest.owner, account: roleRequest.account,
        previousRole: roleRequest.currentRole, scheduledRole: roleRequest.requestedRole, effectiveAt: roleRequest.effectiveAt,
        actorUserId: actor._id, actorNickname: actor.nickname, actorRole: actor.role,
      }], { session });
      return { action, requestedRole: roleRequest.requestedRole, effectiveAt: roleRequest.effectiveAt };
    });
    const message = result.action === 'approve'
      ? `${result.requestedRole} is scheduled to become active on ${result.effectiveAt.toLocaleDateString('en-US', { timeZone: ROLE_CHANGE_TIME_ZONE, month: 'long', day: 'numeric', year: 'numeric' })}.`
      : result.action === 'deny'
        ? `The request for ${result.requestedRole} was denied.`
        : `The ${result.requestedRole} request or schedule was cancelled.`;
    return NextResponse.json({ success: true, ...result, message }, { headers: privateHeaders });
  } catch (error) {
    return requestErrorResponse(error, 'The role change request could not be completed.');
  }
}
