import { NextResponse } from 'next/server';
import type { ClientSession } from 'mongoose';
import User from '@/lib/models/User';
import AuthSession from '@/lib/models/AuthSession';
import Auction, { type IAuction } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import RosterMutation from '@/lib/models/RosterMutation';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { CLAN_ROLES, canChangeMemberRole, isClanRole, validRosterRows } from '@/lib/auth/permissions';
import { getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey, type SheetRecordIdentity } from '@/lib/sheetRecordLinks';
import { getChangedLinkIdentities, getReservationConflict, type ReservationSubject } from '@/lib/auth/reservationProtection';
import { planStaleRowReferenceRelease } from '@/lib/auth/staleRowReferences';
import { guardMutationRequest, readJsonObject, RequestValidationError, requestErrorResponse } from '@/lib/security/request';

const privateHeaders = { 'Cache-Control': 'private, no-store' };
const unfinished: IAuction['status'][] = ['active', 'settling', 'settlement-failed', 'removing'];

export async function GET(request: Request) {
  try {
    const manager = await getSessionUser();
    if (!manager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageClan(manager.role)) return NextResponse.json({ error: 'This page is limited to Chief and General accounts', role: manager.role }, { status: 403 });
    const [pendingUsers, members, roster, auditEvents] = await Promise.all([
      User.find({ status: 'pending' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ createdAt: 1 }).lean(),
      User.find({ status: 'approved' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ nickname: 1 }).lean(),
      getSheetRoster(), ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    const includeRows = (user: (typeof members)[number]) => {
      const sheetRecordRows = getLinkedSheetRecordRows(user, roster);
      const needsLinkRefresh = Boolean(user.sheetRecords?.some((saved) => saved.rowIndex === undefined ||
        !roster.some((record) => record.rowIndex === saved.rowIndex && getSheetRecordKey(record) === getSheetRecordKey(saved))));
      return { ...user, sheetRecordRows, needsLinkRefresh };
    };
    let linkDiagnostics;
    const diagnosticAccount = new URL(request.url).searchParams.get('diagnoseLinks');
    if (diagnosticAccount) {
      if (diagnosticAccount.length > 80) throw new RequestValidationError('Account name is too long.');
      const query = new URL(request.url).searchParams.get('toons') ?? diagnosticAccount;
      if (query.length > 500) throw new RequestValidationError('Toon search is too long.');
      const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');
      const names = new Set(query.split(',').map(normalize).filter(Boolean));
      const matchingRoster = roster.filter((record) => names.has(normalize(record.account)) || names.has(normalize(record.owner)));
      const matchingRows = new Set(matchingRoster.map((record) => record.rowIndex));
      const matchingKeys = new Set(matchingRoster.map(getSheetRecordKey));
      const accounts = [...pendingUsers, ...members].filter((user) => normalize(user.nickname) === normalize(diagnosticAccount) ||
        getLinkedSheetRecordRows(user, roster).some((row) => matchingRows.has(row)) ||
        user.sheetRecords?.some((record) => (record.rowIndex !== undefined && matchingRows.has(record.rowIndex)) || matchingKeys.has(getSheetRecordKey(record))));
      const indexes = await User.collection.indexes();
      linkDiagnostics = {
        account: diagnosticAccount,
        roster: matchingRoster.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })),
        accounts: accounts.map((user) => ({ nickname: user.nickname, status: user.status,
          storedLinks: user.sheetRecords ?? [], legacyOwner: user.sheetRecordName ?? null,
          resolvedRows: getLinkedSheetRecordRows(user, roster) })),
        indexes: indexes.map(({ key, unique, sparse }) => ({ fields: Object.keys(key), unique: Boolean(unique), sparse: Boolean(sparse) })),
      };
    }
    return NextResponse.json({ success: true, managerRole: manager.role, managerId: manager._id.toString(),
      pendingUsers: pendingUsers.map(includeRows), members: members.map(includeRows), roster,
      ...(linkDiagnostics ? { linkDiagnostics } : {}),
      auditEvents: auditEvents.map(({ _id, ...event }) => ({ ...event, id: _id.toString(), targetUserId: event.targetUserId?.toString(), actorUserId: event.actorUserId.toString() })),
    }, { headers: privateHeaders });
  } catch (error) { return requestErrorResponse(error, 'Unable to load clan administration. Please retry.'); }
}

async function assertLinksUnreserved(subjects: ReservationSubject[], session: ClientSession) {
  const relevant = subjects.filter((subject) => subject.identities.length || subject.rows?.length || subject.legacyOwners?.length);
  if (!relevant.length) return;
  // The spreadsheet can reorder without updating historical bids. Match stable
  // identities in memory instead of querying only today's physical row numbers.
  const holds = await AuctionHold.find({ heldPoints: { $ne: 0 } }).select('rowIndex heldPoints owner account').session(session).lean();
  const auctions = await Auction.find({ $or: [
    { status: { $in: unfinished }, highBid: { $exists: true } },
    { status: 'completed', deliveryStatus: 'pending', winner: { $exists: true } },
  ] }).select('status deliveryStatus highBid.rowIndex highBid.owner highBid.account winner.rowIndex winner.owner winner.account').session(session).lean();
  for (const subject of relevant) {
    const conflict = getReservationConflict(subject, holds, auctions);
    if (conflict === 'unverified-legacy-hold') {
      throw new RequestValidationError('An unidentified legacy auction reservation needs review before assigning another toon. Resolve it with clan leadership first.', 409);
    }
    if (conflict) throw new RequestValidationError('A selected toon has a reserved bid or pending delivery. Resolve its auctions before changing links.', 409);
  }
}

async function releaseStaleRowReferences(actorId: string, targetId: string, rows: number[], roster: Awaited<ReturnType<typeof getSheetRoster>>, action: string) {
  await withClanAdministrationTransaction(async (session) => {
    const actor = await User.findOne({ _id: actorId, status: 'approved' }).session(session);
    if (!actor || !canManageClan(actor.role)) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
    const target = await User.findById(targetId).session(session);
    if (!target) throw new RequestValidationError('Account not found.', 404);
    if (target.status !== (action === 'approve' ? 'pending' : 'approved')) {
      throw new RequestValidationError('This account’s approval status changed. Refresh and try again.', 409);
    }
    const candidates = await User.find({ _id: { $ne: targetId }, 'sheetRecords.rowIndex': { $in: rows } }).session(session);
    for (const candidate of candidates) {
      const plan = planStaleRowReferenceRelease(candidate, roster, rows);
      if (!plan) continue;
      const identities = (candidate.sheetRecords ?? []).map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account }));
      // Historical reservations can depend on old physical rows. Keep those
      // references until the affected auctions have been resolved.
      await assertLinksUnreserved([{ identities, rows: plan.before }], session);
      // Unset every row key on this account so a mixed array cannot introduce
      // a null key in the sparse multikey index. Owner/toon identities remain.
      await User.updateOne({ _id: candidate._id }, { $unset: { 'sheetRecords.$[].rowIndex': '' } }, { session });
      await ClanAuditEvent.create([{ eventType: 'toon-reference-refresh',
        actorUserId: actor._id, actorNickname: actor.nickname, actorRole: actor.role,
        targetUserId: candidate._id, targetNickname: candidate.nickname, previousRole: candidate.role,
      }], { session });
    }
  });
}

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    const body = await readJsonObject(request);
    const { action, userId } = body;
    if (typeof action !== 'string' || !['approve', 'deny', 'link', 'unlink', 'remove', 'set-role'].includes(action) || typeof userId !== 'string' || !/^[a-f0-9]{24}$/i.test(userId)) {
      throw new RequestValidationError('Invalid administration request.');
    }
    const initialManager = await getSessionUser();
    if (!initialManager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageClan(initialManager.role)) throw new RequestValidationError('Permission denied.', 403);
    let needsRoster = ['approve', 'link', 'unlink'].includes(action);
    if (action === 'remove') {
      const preview = await User.findById(userId).select('sheetRecordName sheetRecords').lean();
      needsRoster = Boolean(preview?.sheetRecords?.length || preview?.sheetRecordName?.trim());
    }
    const roster = needsRoster ? await getSheetRoster({ fresh: true }) : [];
    if (['approve', 'link'].includes(action) && validRosterRows(body.sheetRecordRows)) {
      const selected = body.sheetRecordRows.map((row) => roster.find((record) => record.rowIndex === row));
      if (selected.some((record) => !record)) throw new RequestValidationError('A selected toon no longer exists. Refresh the roster.', 409);
      if (selected.some((record) => record && roster.filter((other) => getSheetRecordKey(other) === getSheetRecordKey(record)).length > 1)) {
        throw new RequestValidationError('Duplicate owner/toon identities exist in the sheet. Resolve them before linking.', 409);
      }
      // Separate commit is necessary: MongoDB cannot reuse another document's
      // released unique-index key inside the transaction that releases it.
      await releaseStaleRowReferences(initialManager._id.toString(), userId, body.sheetRecordRows, roster, action);
    }
    const result = await withClanAdministrationTransaction(async (session) => {
      // Actor, target and chief count are re-read inside the same serialized
      // transaction. Earlier page/session snapshots never authorize a write.
      const manager = await User.findOne({ _id: initialManager._id, status: 'approved' }).session(session);
      if (!manager || !canManageClan(manager.role)) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
      const target = await User.findById(userId).session(session);
      if (!target) throw new RequestValidationError('Account not found.', 404);
      const currentRows = getLinkedSheetRecordRows(target, roster);
      const currentRowSet = new Set(currentRows);
      const currentIdentities: SheetRecordIdentity[] = target.status === 'approved' ? [
        ...(target.sheetRecords ?? []).map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })),
        ...roster.filter((record) => currentRowSet.has(record.rowIndex)),
      ] : [];
      const legacyOwners = target.status === 'approved' && !target.sheetRecords?.length && target.sheetRecordName?.trim()
        ? [target.sheetRecordName] : [];

      if (action === 'set-role') {
        const nextRole = body.role;
        if (target.status !== 'approved' || !isClanRole(nextRole)) throw new RequestValidationError('Choose an approved member and a valid role.');
        const chiefCount = target.role === 'chief' ? await User.countDocuments({ status: 'approved', role: 'chief' }).session(session) : 0;
        if (!canChangeMemberRole(manager.role, target.role, nextRole, target._id.equals(manager._id), chiefCount)) {
          throw new RequestValidationError(target.role === 'chief' && chiefCount <= 1 ? 'The last Chief cannot be demoted.' : 'You cannot make this role change.', 409);
        }
        const previousRole = target.role;
        target.role = nextRole;
        await target.save({ session });
        await ClanAuditEvent.create([{ eventType: CLAN_ROLES.indexOf(nextRole) < CLAN_ROLES.indexOf(previousRole) ? 'promotion' : 'demotion',
          actorUserId: manager._id, actorNickname: manager.nickname, actorRole: manager.role,
          targetUserId: target._id, targetNickname: target.nickname, previousRole, newRole: nextRole }], { session });
        return `Updated ${target.nickname}'s role to ${nextRole}.`;
      }

      if (action === 'deny') {
        if (target.status !== 'pending') throw new RequestValidationError('Only pending requests can be denied.', 409);
        await ClanAuditEvent.create([{ eventType: 'account-denial', actorUserId: manager._id,
          actorNickname: manager.nickname, actorRole: manager.role, targetUserId: target._id,
          targetNickname: target.nickname, previousRole: target.role }], { session });
        await AuthSession.deleteMany({ userId: target._id }).session(session);
        await target.deleteOne({ session });
        return 'Sign-up request denied.';
      }

      if (action === 'remove') {
        if (target.status !== 'approved' || !['guardian', 'clansman'].includes(target.role)) throw new RequestValidationError('Only Guardian and Clansman accounts can be removed.');
        if (!needsRoster && (target.sheetRecords?.length || target.sheetRecordName?.trim())) {
          throw new RequestValidationError('This member’s toon links changed. Refresh and retry the removal.', 409);
        }
        await assertLinksUnreserved([{ identities: currentIdentities, legacyOwners }], session);
        const outstanding = await Auction.exists({ $or: [
          { status: { $in: unfinished }, $or: [{ createdByUserId: target._id }, { 'highBid.userId': target._id }] },
          { status: 'completed', deliveryStatus: 'pending', $or: [{ createdByUserId: target._id }, { 'winner.userId': target._id }] },
          { status: 'completed', deliveryStatus: 'not-required', highBid: null, createdByUserId: target._id },
        ] }).session(session);
        if (outstanding) throw new RequestValidationError('Resolve this member’s open auctions and delivery tasks before removing the account.', 409);
        await ClanAuditEvent.create([{ eventType: 'member-removal', actorUserId: manager._id, actorNickname: manager.nickname,
          actorRole: manager.role, targetUserId: target._id, targetNickname: target.nickname, previousRole: target.role }], { session });
        await AuthSession.deleteMany({ userId: target._id }).session(session);
        await target.deleteOne({ session });
        return 'Clan member account removed.';
      }

      if ((action === 'approve' && target.status !== 'pending') || (action !== 'approve' && target.status !== 'approved')) {
        throw new RequestValidationError('This account’s approval status changed. Refresh and try again.', 409);
      }
      const rows = body.sheetRecordRows;
      const clearingLinks = action === 'link' && Array.isArray(rows) && rows.length === 0;
      if ((!clearingLinks && !validRosterRows(rows)) || !Array.isArray(rows) || (action === 'unlink' && rows.length !== 1)) throw new RequestValidationError('Select valid, distinct toon rows.');
      if (action === 'link' && body.expectedSheetRecordRows !== undefined) {
        const expected = body.expectedSheetRecordRows;
        if (!Array.isArray(expected) || (expected.length > 0 && !validRosterRows(expected))) {
          throw new RequestValidationError('Invalid saved toon selection.');
        }
        if (expected.length !== currentRows.length || expected.some((row) => !currentRowSet.has(row))) {
          throw new RequestValidationError('This account’s toon links changed while you were editing. Close and reopen the editor to load the latest links.', 409);
        }
      }
      const byRow = new Map(roster.map((record) => [record.rowIndex, record]));
      let nextRows = rows;
      if (action === 'unlink') {
        if (!currentRows.includes(rows[0])) throw new RequestValidationError('That toon is no longer linked to this account.', 409);
        nextRows = currentRows.filter((row) => row !== rows[0]);
      }
      const records = nextRows.map((row) => byRow.get(row));
      if (records.some((record) => !record)) throw new RequestValidationError('A selected toon no longer exists. Refresh the roster.', 409);
      const selected = records.filter((record) => record !== undefined);
      if (await RosterMutation.exists({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: { $in: selected.map(getSheetRecordKey) } }).session(session)) throw new RequestValidationError('A selected toon was permanently removed. Refresh the roster before changing links.', 409);
      if (selected.some((record) => roster.filter((other) => getSheetRecordKey(other) === getSheetRecordKey(record)).length > 1)) {
        throw new RequestValidationError('Duplicate owner/toon identities exist in the sheet. Resolve them before linking.', 409);
      }
      const changed = getChangedLinkIdentities(currentIdentities, selected);
      const refreshingReferences = selected.some((record) => !target.sheetRecords?.some((saved) =>
        saved.rowIndex === record.rowIndex && getSheetRecordKey(saved) === getSheetRecordKey(record)));
      // Unchanged identities can refresh stale row metadata without acquiring or
      // releasing access. New links must also reject orphaned reservations.
      const removedRows = currentRows.filter((row) => !nextRows.includes(row));
      await assertLinksUnreserved([
        { identities: changed.removed, rows: removedRows },
        { identities: changed.added, rejectUnverifiedLegacyHolds: true },
        // Converting an owner-wide legacy link can otherwise abandon a removed
        // toon that no longer appears anywhere in the current roster.
        ...(legacyOwners.length
          ? [{ identities: [], legacyOwners, ignoredIdentities: selected.filter((record) => !changed.added.includes(record)) }] : []),
      ], session);
      // Pending accounts can retain legacy assignments too; the database's
      // unique row index does not limit its ownership check to approved users.
      const otherUsers = await User.find({ _id: { $ne: target._id } }).select('nickname status sheetRecordName sheetRecords').session(session).lean();
      for (const other of otherUsers) {
        const occupied = new Set(getLinkedSheetRecordRows(other, roster));
        const conflict = selected.find((record) => occupied.has(record.rowIndex));
        if (conflict) throw new RequestValidationError(`${conflict.account || conflict.owner} is linked to ${other.nickname}${other.status === 'pending' ? ' (pending approval)' : ''}. Unlink it from that account first.`, 409);
        // Reordered sheet rows may still be present in an old database index
        // entry. Report that separately instead of claiming identity ownership.
        const staleReference = other.sheetRecords?.find((record) => record.rowIndex !== undefined &&
          nextRows.includes(record.rowIndex) && !occupied.has(record.rowIndex));
        if (staleReference) throw new RequestValidationError(`A stale sheet-row reference on ${other.nickname} is blocking this link. Open that account’s toon editor and save its links to refresh the row references. No toon has been reassigned.`, 409);
      }
      // Omit an empty links array so the sparse unique row index does not
      // reserve an empty-array key for an account without linked toons.
      target.sheetRecords = selected.length ? selected.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })) : undefined;
      target.sheetRecordName = undefined;
      if (action === 'approve') target.status = 'approved';
      await target.save({ session });
      if (action === 'approve' || changed.added.length || changed.removed.length || legacyOwners.length || refreshingReferences) {
        const uniqueIdentities = (records: SheetRecordIdentity[]) => [...new Map(records.map((record) => [getSheetRecordKey(record), record])).values()];
        await ClanAuditEvent.create([{ eventType: action === 'approve' ? 'account-approval' : 'toon-links',
          actorUserId: manager._id, actorNickname: manager.nickname, actorRole: manager.role,
          targetUserId: target._id, targetNickname: target.nickname, previousRole: target.role,
          addedToons: uniqueIdentities(changed.added), removedToons: uniqueIdentities(changed.removed),
        }], { session });
      }
      return action === 'unlink' ? 'Toon unlinked and available for reassignment.' : `${action === 'approve' ? 'Account approved and linked' : 'Account linked'} to ${selected.length} toon(s).`;
    });
    return NextResponse.json({ success: true, message: result }, { headers: privateHeaders });
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      const pattern = 'keyPattern' in error && typeof error.keyPattern === 'object' && error.keyPattern
        ? Object.keys(error.keyPattern) : [];
      console.error('Administration unique-index conflict.', { fields: pattern });
      return NextResponse.json({ error: pattern.includes('sheetRecords.rowIndex')
        ? 'A saved sheet-row assignment is blocking this link. Reopen the toon editor to check current assignments. If the toon is available, clan leadership needs to reconcile its stale row reference.'
        : 'A database uniqueness conflict prevented saving these changes. No changes were committed. Clan leadership can check the server log for the conflicting field.',
      }, { status: 409 });
    }
    return requestErrorResponse(error, 'Unable to complete the administration request. Please retry.');
  }
}
