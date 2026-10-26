import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import User from '@/lib/models/User';
import AuthSession from '@/lib/models/AuthSession';
import Auction, { type IAuction } from '@/lib/models/Auction';
import AuctionHold from '@/lib/models/AuctionHold';
import AuctionBidHistory from '@/lib/models/AuctionBidHistory';
import SheetRosterCache from '@/lib/models/SheetRosterCache';
import DkpSheetMutation from '@/lib/models/DkpSheetMutation';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import ClanAccountArchive from '@/lib/models/ClanAccountArchive';
import RosterMutation from '@/lib/models/RosterMutation';
import ToonDkpReset from '@/lib/models/ToonDkpReset';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { withClanAdministrationTransaction } from '@/lib/auth/administration';
import { readDkpCell } from '@/lib/dkpAccounting';
import { CLAN_ROLES, canChangeMemberRole, isClanRole, validRosterRows } from '@/lib/auth/permissions';
import { adjustPlayersDKP, changeClanToon, getSheetRoster, resetToonDkp, restoreToonDkpSnapshot, withDkpLedgerLock } from '@/lib/googleSheets';
import { getRosterWithWeeklyEarned } from '@/lib/dkpWeeklyEarned';
import { withdrawToonOpenAuctionBids } from '@/lib/auctionBidWithdrawal';
import { getLinkedSheetRecordRows, getSheetRecordKey, type SheetRecordIdentity } from '@/lib/sheetRecordLinks';
import { getChangedLinkIdentities, getReservationConflict, type ReservationSubject } from '@/lib/auth/reservationProtection';
import { planStaleRowReferenceRelease } from '@/lib/auth/staleRowReferences';
import { isDkpRequestId } from '@/lib/bossDkp';
import { normalizeNickname } from '@/lib/auth/validation';
import { guardMutationRequest, readJsonObject, RequestValidationError, requestErrorResponse } from '@/lib/security/request';

const privateHeaders = { 'Cache-Control': 'private, no-store' };
const unfinished: IAuction['status'][] = ['active', 'settling', 'settlement-failed', 'removing'];
const snapshotUserLinks = (user: { sheetRecords?: Array<{ rowIndex?: number; owner: string; account: string }>; sheetRecordName?: string }, roster: Awaited<ReturnType<typeof getSheetRoster>>, rows: number[]) => ({
  ...(user.sheetRecords?.length ? { sheetRecords: user.sheetRecords.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })) } : {}),
  ...(user.sheetRecordName?.trim() ? { sheetRecordName: user.sheetRecordName } : {}),
  linkedToons: roster.filter((record) => rows.includes(record.rowIndex)).map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })),
});

export async function GET(request: Request) {
  try {
    const manager = await getSessionUser();
    if (!manager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageClan(manager.role)) return NextResponse.json({ error: 'This page is limited to Chief and General accounts', role: manager.role }, { status: 403 });
    const [pendingUsers, members, roster, recentAuditEvents, pendingTransfers, archivedAccounts, archivedToons] = await Promise.all([
      User.find({ status: 'pending' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ createdAt: 1 }).lean(),
      User.find({ status: 'approved' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ nickname: 1 }).lean(),
      getSheetRoster(), ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).lean(),
      ClanAuditEvent.find({ eventType: 'toon-transferred', transferStatus: 'pending' }).sort({ createdAt: -1 }).lean(),
      ClanAccountArchive.find({ status: 'archived' }).select('auditEventId nickname role originalStatus archiveReason linkedToons archivedAt archivedByNickname').sort({ archivedAt: -1 }).limit(500).lean(),
      RosterMutation.find({ action: 'remove', status: 'applied', restoredAt: { $exists: false } })
        .select('_id owner account subClass before actorNickname createdAt removalEventId').sort({ createdAt: -1 }).limit(500).lean(),
    ]);
    const auditEvents = [...new Map([...recentAuditEvents, ...pendingTransfers].map((event) => [event._id.toString(), event])).values()]
      .sort((first, second) => second.createdAt.getTime() - first.createdAt.getTime());
    const accountArchiveEvents = new Set(archivedAccounts.map((archive) => archive.auditEventId.toString()));
    const toonArchiveEvents = new Set(archivedToons.flatMap((archive) => archive.removalEventId ? [archive.removalEventId.toString()] : []));
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
      auditEvents: auditEvents.map(({ _id, ...event }) => ({ ...event, id: _id.toString(), targetUserId: event.targetUserId?.toString(), transferToUserId: event.transferToUserId?.toString(), actorUserId: event.actorUserId.toString(),
        undoAvailable: ['promotion', 'demotion', 'toon-links', 'account-approval', 'toon-created'].includes(event.eventType) ||
          (['member-removal', 'account-denial'].includes(event.eventType) && accountArchiveEvents.has(_id.toString())) ||
          (event.eventType === 'toon-removed' && toonArchiveEvents.has(_id.toString())) ||
          (event.eventType === 'toon-dkp-wiped' && Boolean(event.affectedToon && event.dkpBefore?.[4])) ||
          (event.eventType === 'toon-transferred' && Boolean(event.sourceLinksBefore?.linkedToons && event.sourceLinksAfter?.linkedToons && event.destinationLinksBefore?.linkedToons && event.destinationLinksAfter?.linkedToons && event.dkpBefore?.length === 6 && Array.isArray(event.activityWeeksBefore) && typeof event.hadPriorDkpReset === 'boolean' && (!event.hadPriorDkpReset || (event.priorDkpResetAt && event.priorDkpResetByUserId && event.priorDkpResetByNickname)))),
      })),
      archivedAccounts: archivedAccounts.map(({ _id, ...archive }) => ({ ...archive, id: _id.toString(), auditEventId: archive.auditEventId.toString() })),
      archivedToons: archivedToons.map(({ _id, before, ...archive }) => ({
        id: _id, eventId: archive.removalEventId?.toString(), owner: archive.owner, account: archive.account,
        subClass: archive.subClass, available: String(before[7] ?? '0'), archivedAt: archive.createdAt, archivedByNickname: archive.actorNickname,
      })),
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

async function archiveAccount(target: InstanceType<typeof User>, manager: InstanceType<typeof User>, eventId: string,
  archiveReason: 'member-removal' | 'account-denial', linkedToons: SheetRecordIdentity[], session: ClientSession) {
  await ClanAccountArchive.create([{
    userId: target._id, auditEventId: eventId, nickname: target.nickname,
    nicknameKey: target.nicknameKey || normalizeNickname(target.nickname), passwordHash: target.passwordHash,
    role: target.role, originalStatus: target.status,
    linkedToons: [...new Map(linkedToons.map((toon) => [getSheetRecordKey(toon), { owner: toon.owner, account: toon.account }])).values()],
    createdAt: target.createdAt, archiveReason, archivedAt: new Date(),
    archivedByUserId: manager._id, archivedByNickname: manager.nickname, status: 'archived',
  }], { session });
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

async function assertRecentActivity(eventId: string, session: ClientSession) {
  const latest = await ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).select('_id').session(session).lean();
  if (!latest.some((entry) => entry._id.toString() === eventId)) throw new RequestValidationError('Only the latest 100 activity entries can be undone here.', 409);
}

async function assertLatestToonActivity(event: { _id: unknown }, identity: SheetRecordIdentity, session: ClientSession) {
  const related = await ClanAuditEvent.find({ $or: [
    { 'affectedToon.owner': identity.owner, 'affectedToon.account': identity.account },
    { addedToons: { $elemMatch: { owner: identity.owner, account: identity.account } } },
    { removedToons: { $elemMatch: { owner: identity.owner, account: identity.account } } },
  ] }).sort({ createdAt: 1, _id: 1 }).select('_id').collation({ locale: 'en', strength: 2 }).session(session).lean();
  if (!related.length || related[related.length - 1]._id.toString() !== String(event._id)) {
    throw new RequestValidationError('This toon has later DKP or roster activity. Undo the newer action first.', 409);
  }
}

async function restoreArchivedAccount(actorId: string, eventId: string, requestId: string, requireRecent = true) {
  return withDkpLedgerLock((roster) => withClanAdministrationTransaction(async (session) => {
    const manager = await User.findOne({ _id: actorId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
    if (!manager) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
    const event = await ClanAuditEvent.findById(eventId).session(session);
    if (!event || !['member-removal', 'account-denial'].includes(event.eventType) || !event.targetUserId) {
      throw new RequestValidationError('This account archive is unavailable.', 404);
    }
    if (requireRecent) await assertRecentActivity(eventId, session);
    const archive = await ClanAccountArchive.findOne({ auditEventId: event._id }).session(session);
    if (!archive) throw new RequestValidationError('This older account action has no saved credentials to restore.', 409);
    if (archive.status === 'restored') {
      if (archive.restoreRequestId === requestId) return { success: true, message: 'Account restored.' };
      throw new RequestValidationError('This archived account was already restored.', 409);
    }
    if (archive.userId.toString() !== event.targetUserId.toString() || !archive.passwordHash) {
      throw new RequestValidationError('The account archive is incomplete and cannot be restored safely.', 409);
    }
    if (await User.exists({ $or: [
      { _id: archive.userId }, { nicknameKey: archive.nicknameKey }, { nickname: archive.nickname },
    ] }).session(session)) throw new RequestValidationError('An account with this ID or nickname already exists.', 409);
    const matches = archive.linkedToons.map((identity) => roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(identity)));
    if (matches.some((entries) => entries.length !== 1)) throw new RequestValidationError('One of this account’s saved toons is no longer on the roster.', 409);
    const linked = matches.map((entries) => entries[0]);
    const otherUsers = await User.find().select('_id sheetRecords sheetRecordName').session(session).lean();
    if (otherUsers.some((user) => linked.some((record) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex)))) {
      throw new RequestValidationError('A saved toon is linked to another account. Unlink it before restoring this account.', 409);
    }
    await assertLinksUnreserved([{ identities: linked, rejectUnverifiedLegacyHolds: true }], session);
    await User.create([{
      _id: archive.userId, nickname: archive.nickname, nicknameKey: archive.nicknameKey,
      passwordHash: archive.passwordHash, role: archive.role, status: archive.originalStatus,
      createdAt: archive.createdAt,
      ...(linked.length ? { sheetRecords: linked.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })) } : {}),
    }], { session });
    archive.status = 'restored'; archive.passwordHash = undefined; archive.restoredAt = new Date();
    archive.restoredByUserId = manager._id; archive.restoredByNickname = manager.nickname; archive.restoreRequestId = requestId;
    await archive.save({ session });
    event.undoneAt = new Date(); event.undoneByUserId = manager._id;
    event.undoneByNickname = manager.nickname; event.undoRequestId = requestId;
    await event.save({ session });
    return { success: true, message: 'Account restored. It must sign in again.' };
  }));
}

async function undoWipedDkp(actorId: string, eventId: string, requestId: string) {
  const event = await ClanAuditEvent.findById(eventId).lean();
  if (!event || event.eventType !== 'toon-dkp-wiped' || !event.dkpBefore?.[4]) throw new RequestValidationError('The wiped Available DKP snapshot is unavailable.', 409);
  const requestParts = event.operationKey?.split(':') ?? [];
  const operationKey = event.dkpOperationKey ?? (requestParts.length === 2
    ? createHash('sha256').update(`toon-dkp:${process.env.GOOGLE_SHEET_ID?.trim()}:${event.actorUserId.toString()}:${requestParts[1]}`).digest('hex')
    : '');
  const originalMutation = operationKey ? await DkpSheetMutation.findOne({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), operationKey }).lean() : null;
  const toon = event.affectedToon ?? originalMutation?.identities?.[0];
  if (!toon?.owner || typeof toon.account !== 'string') throw new RequestValidationError('The wiped toon identity is unavailable.', 409);
  const restoredAvailable = readDkpCell(event.dkpBefore[4], 'H', toon.rowIndex ?? 3);
  if (!Number.isFinite(restoredAvailable) || restoredAvailable < 0) throw new RequestValidationError('The saved Available DKP amount is invalid.', 409);
  await adjustPlayersDKP([{ rowIndex: toon.rowIndex ?? 3, owner: toon.owner, account: toon.account, points: restoredAvailable }], {
    mode: 'available', actorUserId: actorId, idempotencyKey: `undo-wipe:${eventId}:${requestId}`,
    mutate: async (session) => {
      const manager = await User.findOne({ _id: actorId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
      if (!manager) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
      await assertRecentActivity(eventId, session);
      const current = await ClanAuditEvent.findOne({ _id: eventId, eventType: 'toon-dkp-wiped', undoneAt: { $exists: false } }).session(session);
      if (!current) throw new RequestValidationError('This wipe was already undone or changed.', 409);
      await assertLatestToonActivity(current, toon, session);
      current.undoneAt = new Date(); current.undoneByUserId = manager._id;
      current.undoneByNickname = manager.nickname; current.undoRequestId = requestId;
      await current.save({ session });
    },
  });
  return { success: true, message: 'Wiped Available DKP added back. Auction bids were not restored.' };
}

async function undoTransfer(actorId: string, eventId: string, requestId: string) {
  const preview = await ClanAuditEvent.findOne({ _id: eventId, eventType: 'toon-transferred' }).lean();
  if (!preview || preview.transferStatus !== 'completed' || !preview.removedToons?.[0]) {
    throw new RequestValidationError('This transfer is not complete.', 409);
  }
  const toon = preview.removedToons[0];
  if (preview.dkpBefore?.length !== 6 || !Array.isArray(preview.activityWeeksBefore) || typeof preview.hadPriorDkpReset !== 'boolean') {
    throw new RequestValidationError('This transfer has no complete DKP recovery snapshot.', 409);
  }
  const sourceBefore = preview.sourceLinksBefore?.linkedToons;
  const sourceAfter = preview.sourceLinksAfter?.linkedToons;
  const destinationBefore = preview.destinationLinksBefore?.linkedToons;
  const destinationAfter = preview.destinationLinksAfter?.linkedToons;
  if (!sourceBefore || !sourceAfter || !destinationBefore || !destinationAfter || !preview.targetUserId || !preview.transferToUserId) {
    throw new RequestValidationError('This transfer has no complete ownership snapshot.', 409);
  }
  if (preview.hadPriorDkpReset && (!preview.priorDkpResetAt || !preview.priorDkpResetByUserId || !preview.priorDkpResetByNickname)) {
    throw new RequestValidationError('The prior weekly DKP reset record is incomplete.', 409);
  }
  const snapshot = preview.dkpBefore.map((value, index) => readDkpCell(value, ['D', 'E', 'F', 'G', 'H', 'I'][index], toon.rowIndex ?? 3));
  await restoreToonDkpSnapshot({
    actorUserId: actorId, requestId, identity: { owner: toon.owner, account: toon.account },
    values: snapshot, weeklyActivity: preview.activityWeeksBefore,
    mutate: async (session, record, roster) => {
      const manager = await User.findOne({ _id: actorId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
      if (!manager) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
      await assertRecentActivity(eventId, session);
      const event = await ClanAuditEvent.findOne({ _id: eventId, eventType: 'toon-transferred' }).session(session);
      if (!event || event.transferStatus !== 'completed' || !event.targetUserId || !event.transferToUserId) {
        throw new RequestValidationError('This transfer is not complete.', 409);
      }
      if (event.undoneAt) {
        if (event.undoRequestId === requestId) return;
        throw new RequestValidationError('This transfer was already undone.', 409);
      }
      await assertLatestToonActivity(event, record, session);
      const openHolds = await AuctionHold.find({ heldPoints: { $ne: 0 } }).select('rowIndex owner account heldPoints').session(session).lean();
      const openAuctions = await Auction.find({ status: { $in: unfinished } }).select('status highBid').session(session).lean();
      if (getReservationConflict({ identities: [record], rejectUnverifiedLegacyHolds: true }, openHolds, openAuctions)) {
        throw new RequestValidationError('Resolve this toon’s open auction bids before undoing the transfer.', 409);
      }
      const source = await User.findOne({ _id: event.targetUserId, status: 'approved' }).session(session);
      const destination = await User.findOne({ _id: event.transferToUserId, status: 'approved' }).session(session);
      if (!source || !destination) throw new RequestValidationError('Restore both member accounts before undoing this transfer.', 409);
      const linksMatch = (user: InstanceType<typeof User>, expected: Array<{ owner: string; account: string }>) => {
        const current = getLinkedSheetRecordRows(user, roster).map((row) => roster.find((entry) => entry.rowIndex === row)!)
          .filter(Boolean).map(getSheetRecordKey).sort();
        const expectedKeys = expected.map(getSheetRecordKey).sort();
        return current.length === expectedKeys.length && current.every((key, index) => key === expectedKeys[index]);
      };
      if (!linksMatch(source, sourceAfter) || !linksMatch(destination, destinationAfter)) {
        throw new RequestValidationError('One of these accounts’ toon links changed after the transfer.', 409);
      }
      const toonKey = getSheetRecordKey(record);
      if (!sourceBefore.some((identity) => getSheetRecordKey(identity) === toonKey) ||
        sourceAfter.some((identity) => getSheetRecordKey(identity) === toonKey) ||
        destinationBefore.some((identity) => getSheetRecordKey(identity) === toonKey) ||
        !destinationAfter.some((identity) => getSheetRecordKey(identity) === toonKey)) {
        throw new RequestValidationError('The source account ownership snapshot is inconsistent.', 409);
      }
      const allRestored = [...sourceBefore, ...destinationBefore];
      const restoredMatches = allRestored.map((identity) => roster.filter((entry) => getSheetRecordKey(entry) === getSheetRecordKey(identity)));
      if (restoredMatches.some((entries) => entries.length !== 1)) throw new RequestValidationError('A toon from the saved account links is no longer on the roster.', 409);
      const restoredRows = new Set(restoredMatches.map((entries) => entries[0].rowIndex));
      const thirdParty = await User.find({ _id: { $nin: [source._id, destination._id] } }).select('sheetRecords sheetRecordName').session(session).lean();
      if (thirdParty.some((user) => getLinkedSheetRecordRows(user, roster).some((row) => restoredRows.has(row)))) {
        throw new RequestValidationError('A saved toon is now linked to another account.', 409);
      }
      const restoreLinks = (identities: typeof sourceBefore) => identities.length ? identities.map((identity) => {
        const current = roster.find((entry) => getSheetRecordKey(entry) === getSheetRecordKey(identity))!;
        return { rowIndex: current.rowIndex, owner: current.owner, account: current.account };
      }) : undefined;
      source.sheetRecords = restoreLinks(sourceBefore); source.sheetRecordName = undefined;
      destination.sheetRecords = restoreLinks(destinationBefore); destination.sheetRecordName = undefined;
      await source.save({ session }); await destination.save({ session });
      if (event.hadPriorDkpReset) {
        await ToonDkpReset.updateOne({ identityKey: toonKey }, { $set: {
          owner: record.owner, account: record.account, resetAt: event.priorDkpResetAt,
          resetByUserId: event.priorDkpResetByUserId, resetByNickname: event.priorDkpResetByNickname,
        } }, { upsert: true, session });
      } else await ToonDkpReset.deleteOne({ identityKey: toonKey }).session(session);
      event.undoneAt = new Date(); event.undoneByUserId = manager._id;
      event.undoneByNickname = manager.nickname; event.undoRequestId = requestId;
      await event.save({ session });
    },
  });
  return { success: true, message: 'Transfer undone. Saved DKP restored; withdrawn auction bids were not restored.' };
}

async function undoActivity(actorId: string, eventId: string, requestId: string) {
  const eventPreview = await ClanAuditEvent.findById(eventId).lean();
  if (!eventPreview) throw new RequestValidationError('Activity entry not found.', 404);
  if (eventPreview.undoneAt) {
    if (eventPreview.undoRequestId === requestId) return { success: true, message: 'Change undone.' };
    throw new RequestValidationError('This activity has already been undone.', 409);
  }
  if (eventPreview.eventType === 'toon-dkp-wiped') return undoWipedDkp(actorId, eventId, requestId);
  if (eventPreview.eventType === 'toon-transferred') return undoTransfer(actorId, eventId, requestId);
  if (eventPreview.eventType === 'member-removal' || eventPreview.eventType === 'account-denial') {
    return restoreArchivedAccount(actorId, eventId, requestId);
  }
  if (eventPreview.eventType === 'toon-removed') {
    const toon = eventPreview.removedToons?.[0];
    if (!toon) throw new RequestValidationError('This toon archive is unavailable.', 409);
    const archive = await RosterMutation.findOne({
      spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: getSheetRecordKey(toon),
      status: 'applied', restoredAt: { $exists: false }, $or: [{ removalEventId: eventId }, { removalEventId: { $exists: false } }],
    }).sort({ createdAt: -1 }).lean();
    if (!archive) throw new RequestValidationError('This toon archive was already restored or is unavailable.', 409);
    await changeClanToon(actorId, requestId, { action: 'restore', archiveMutationId: archive._id, undoEventId: eventId });
    return { success: true, message: 'Toon and its saved DKP were restored. Auction bids were not restored.' };
  }
  if (eventPreview.eventType === 'toon-created') {
    const toon = eventPreview.addedToons?.[0];
    if (!toon) throw new RequestValidationError('This toon creation cannot be undone safely.', 409);
    const roster = await getSheetRoster({ fresh: true });
    const current = roster.find((record) => getSheetRecordKey(record) === getSheetRecordKey(toon));
    if (!current) throw new RequestValidationError('This toon is no longer on the roster.', 409);
    await changeClanToon(actorId, requestId, {
      action: 'remove', rowIndex: current.rowIndex, owner: current.owner, account: current.account,
      undoCreatedEventId: eventId,
    });
    return { success: true, message: 'Toon creation undone.' };
  }

  return withDkpLedgerLock((roster) => withClanAdministrationTransaction(async (session) => {
    const manager = await User.findOne({ _id: actorId, status: 'approved', role: { $in: ['chief', 'general'] } }).session(session);
    if (!manager) throw new RequestValidationError('Your permissions changed. Refresh and try again.', 403);
    const latest = await ClanAuditEvent.find().sort({ createdAt: -1 }).limit(100).select('_id').session(session).lean();
    if (!latest.some((entry) => entry._id.toString() === eventId)) throw new RequestValidationError('Only the latest 100 activity entries can be undone.', 409);
    const event = await ClanAuditEvent.findById(eventId).session(session);
    if (!event) throw new RequestValidationError('Activity entry not found.', 404);
    if (event.undoneAt) {
      if (event.undoRequestId === requestId) return { success: true, message: 'Change undone.' };
      throw new RequestValidationError('This activity has already been undone.', 409);
    }
    if (!['promotion', 'demotion', 'toon-links', 'account-approval'].includes(event.eventType)) {
      throw new RequestValidationError('This change cannot be undone safely.', 409);
    }
    const target = event.targetUserId ? await User.findById(event.targetUserId).session(session) : null;
    if (!target) throw new RequestValidationError('The account no longer exists.', 409);
    const laterChange = await ClanAuditEvent.exists({
      targetUserId: target._id, createdAt: { $gt: event.createdAt },
    }).session(session);
    if (laterChange) throw new RequestValidationError('This account has later activity and cannot be safely undone.', 409);

    if (event.eventType === 'promotion' || event.eventType === 'demotion') {
      if (target.status !== 'approved' || target.role !== event.newRole || !canChangeMemberRole(manager.role, target.role, event.previousRole, target._id.equals(manager._id),
        target.role === 'chief' ? await User.countDocuments({ status: 'approved', role: 'chief' }).session(session) : 0)) {
        throw new RequestValidationError('The rank has changed or you cannot restore its previous value.', 409);
      }
      target.role = event.previousRole as typeof target.role;
      await target.save({ session });
    } else {
      const added = event.addedToons ?? [];
      const removed = event.removedToons ?? [];
      if (!added.length && !removed.length) throw new RequestValidationError('This entry has no toon link changes to undo.', 409);
      if (target.status !== 'approved' || target.sheetRecordName?.trim()) throw new RequestValidationError('This account uses legacy toon links and cannot be safely undone.', 409);
      const linkedRows = getLinkedSheetRecordRows(target, roster);
      const linkedKeys = new Set(roster.filter((record) => linkedRows.includes(record.rowIndex)).map(getSheetRecordKey));
      const addedKeys = new Set(added.map(getSheetRecordKey));
      const removedRecords = removed.map((toon) => roster.filter((record) => getSheetRecordKey(record) === getSheetRecordKey(toon)));
      if (removedRecords.some((matches) => matches.length !== 1) || added.some((toon) => !linkedKeys.has(getSheetRecordKey(toon))) ||
        [...addedKeys].some((key) => roster.filter((record) => getSheetRecordKey(record) === key).length !== 1) ||
        removed.some((toon) => linkedKeys.has(getSheetRecordKey(toon))) ||
        target.sheetRecords?.some((saved) => !roster.some((record) => getSheetRecordKey(record) === getSheetRecordKey(saved)))) {
        throw new RequestValidationError('The toon links have changed since this activity.', 409);
      }
      const restored = removedRecords.map((matches) => matches[0]);
      const otherUsers = await User.find({ _id: { $ne: target._id } }).select('sheetRecords sheetRecordName').session(session).lean();
      const changedRecords = [...restored, ...roster.filter((record) => addedKeys.has(getSheetRecordKey(record)))];
      if (otherUsers.some((user) => changedRecords.some((record) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex)))) {
        throw new RequestValidationError('A toon from this change is linked to another account now.', 409);
      }
      const addedRecords = roster.filter((record) => addedKeys.has(getSheetRecordKey(record)));
      await assertLinksUnreserved([
        { identities: addedRecords },
        { identities: restored, rejectUnverifiedLegacyHolds: true },
      ], session);
      const nextRows = roster.filter((record) => linkedRows.includes(record.rowIndex) && !addedKeys.has(getSheetRecordKey(record)))
        .map((record) => record.rowIndex);
      for (const record of restored) if (!nextRows.includes(record.rowIndex)) nextRows.push(record.rowIndex);
      const byRow = new Map(roster.map((record) => [record.rowIndex, record]));
      const selected = nextRows.map((row) => byRow.get(row)).filter((record) => record !== undefined);
      target.sheetRecords = selected.length ? selected.map(({ rowIndex, owner, account }) => ({ rowIndex, owner, account })) : undefined;
      target.sheetRecordName = undefined;
      if (event.eventType === 'account-approval') {
        if (await AuctionBidHistory.exists({ userId: target._id }).session(session) ||
          await Auction.exists({ createdByUserId: target._id }).session(session)) {
          throw new RequestValidationError('This account has auction history and cannot be safely returned to pending.', 409);
        }
        target.status = 'pending';
        await AuthSession.deleteMany({ userId: target._id }).session(session);
      }
      await target.save({ session });
    }
    event.undoneAt = new Date();
    event.undoneByUserId = manager._id;
    event.undoneByNickname = manager.nickname;
    event.undoRequestId = requestId;
    await event.save({ session });
    return { success: true, message: 'Change undone.' };
  }));
}

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    const body = await readJsonObject(request);
    const { action, userId } = body;
    if (typeof action !== 'string' || !['approve', 'deny', 'link', 'unlink', 'remove', 'set-role', 'transfer', 'undo-activity', 'restore-toon', 'restore-account'].includes(action)) {
      throw new RequestValidationError('Invalid administration request.');
    }
    const initialManager = await getSessionUser();
    if (!initialManager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageClan(initialManager.role)) throw new RequestValidationError('Permission denied.', 403);
    if (action === 'undo-activity') {
      if (typeof body.eventId !== 'string' || !/^[a-f0-9]{24}$/i.test(body.eventId) || !isDkpRequestId(body.requestId)) {
        throw new RequestValidationError('Choose a valid activity entry to undo.');
      }
      const result = await undoActivity(initialManager._id.toString(), body.eventId, body.requestId);
      return NextResponse.json(result, { headers: privateHeaders });
    }
    if (action === 'restore-toon') {
      if (typeof body.archiveMutationId !== 'string' || !/^[a-f0-9]{64}$/i.test(body.archiveMutationId) || !isDkpRequestId(body.requestId)) {
        throw new RequestValidationError('Choose a valid archived toon.');
      }
      const result = await changeClanToon(initialManager._id.toString(), body.requestId, { action: 'restore', archiveMutationId: body.archiveMutationId });
      return NextResponse.json({ success: true, ...result, message: 'Toon and saved DKP restored. Auction bids were not restored.' }, { headers: privateHeaders });
    }
    if (action === 'restore-account') {
      if (typeof body.eventId !== 'string' || !/^[a-f0-9]{24}$/i.test(body.eventId) || !isDkpRequestId(body.requestId)) {
        throw new RequestValidationError('Choose a valid archived account.');
      }
      const result = await restoreArchivedAccount(initialManager._id.toString(), body.eventId, body.requestId, false);
      return NextResponse.json(result, { headers: privateHeaders });
    }
    if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/i.test(userId)) throw new RequestValidationError('Invalid administration request.');
    if (action === 'transfer') {
      const toUserId = body.toUserId;
      const rowIndex = body.rowIndex;
      if (typeof toUserId !== 'string' || !/^[a-f0-9]{24}$/i.test(toUserId) || toUserId === userId ||
        typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000 ||
        typeof body.owner !== 'string' || !body.owner.trim() || body.owner.trim().length > 80 ||
        typeof body.account !== 'string' || body.account.length > 80 || !isDkpRequestId(body.requestId)) {
        throw new RequestValidationError('Choose a valid toon and a different approved account.');
      }
      const owner = body.owner.trim();
      const account = body.account.trim();
      const suppliedResumeKey = body.resumeOperationKey;
      if (suppliedResumeKey !== undefined && (typeof suppliedResumeKey !== 'string' ||
        !/^transfer:[a-f0-9]{24}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(suppliedResumeKey) ||
        suppliedResumeKey.split(':')[2] !== body.requestId)) {
        throw new RequestValidationError('Invalid pending transfer reference.', 409);
      }
      const transferAuditKey = typeof suppliedResumeKey === 'string'
        ? suppliedResumeKey : `transfer:${initialManager._id.toString()}:${body.requestId}`;
      let bidChanges = { withdrawnBids: 0, promotedBids: 0 };
      const result = await resetToonDkp({
        actorUserId: initialManager._id.toString(), requestId: body.requestId,
        identity: { owner, account }, mode: 'all', fingerprintData: { rowIndex, fromUserId: userId, toUserId },
        beforeMutation: async (session, record, manager, roster) => {
          if (await RosterMutation.exists({ spreadsheetId: process.env.GOOGLE_SHEET_ID?.trim(), action: 'remove', identityKey: getSheetRecordKey(record) }).session(session)) {
            throw new RequestValidationError('This toon was permanently removed. Refresh the roster before transferring it.', 409);
          }
          const existingTransfer = await ClanAuditEvent.findOne({ operationKey: transferAuditKey }).session(session);
          const source = await User.findOne({ _id: userId, status: 'approved' }).session(session);
          const destination = await User.findOne({ _id: toUserId, status: 'approved' }).session(session);
          if (!source || !destination) throw new RequestValidationError('Both accounts must be approved clan members.', 409);
          const sourceRows = getLinkedSheetRecordRows(source, roster);
          const destinationRows = getLinkedSheetRecordRows(destination, roster);
          if (existingTransfer) {
            if (!existingTransfer.targetUserId?.equals(source._id) || !existingTransfer.transferToUserId?.equals(destination._id) ||
              existingTransfer.transferStatus !== 'pending' ||
              !existingTransfer.removedToons?.some((toon) => getSheetRecordKey(toon) === getSheetRecordKey(record))) {
              throw new RequestValidationError('This transfer request has already been completed or changed.', 409);
            }
            return;
          }
          if (record.rowIndex !== rowIndex) throw new RequestValidationError('The roster changed. Refresh and retry the transfer.', 409);
          if (!sourceRows.includes(record.rowIndex)) throw new RequestValidationError('That toon is no longer linked to the source account.', 409);
          if (destinationRows.includes(record.rowIndex)) throw new RequestValidationError('That toon is already linked to the destination account.', 409);
          const otherUsers = await User.find({ _id: { $nin: [source._id, destination._id] } })
            .select('nickname status sheetRecords sheetRecordName').session(session).lean();
          const conflictingUser = otherUsers.find((user) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex));
          if (conflictingUser) throw new RequestValidationError(`This toon is linked to ${conflictingUser.nickname}. Refresh the member list and try again.`, 409);

          const remainingRows = sourceRows.filter((row) => row !== record.rowIndex);
          const sourceLinksBefore = snapshotUserLinks(source, roster, sourceRows);
          const destinationLinksBefore = snapshotUserLinks(destination, roster, destinationRows);
          const cache = await SheetRosterCache.findOne({ cacheKey: process.env.GOOGLE_SHEET_ID?.trim() }).select('weeklyActivityHistory').session(session).lean();
          const activityWeeksBefore = cache?.weeklyActivityHistory?.find((entry) => getSheetRecordKey(entry) === getSheetRecordKey(record))?.weeks
            ?? (record.fiveWeekActivity === 0 ? [] : [record.fiveWeekActivity ?? 0]);
          const priorReset = await ToonDkpReset.findOne({ identityKey: getSheetRecordKey(record) }).session(session).lean();
          source.sheetRecords = remainingRows.flatMap((row) => {
            const linked = roster.find((entry) => entry.rowIndex === row);
            return linked ? [{ rowIndex: linked.rowIndex, owner: linked.owner, account: linked.account }] : [];
          });
          if (!source.sheetRecords.length) source.sheetRecords = undefined;
          source.sheetRecordName = undefined;
          await source.save({ session });
          const dkpOperationKey = createHash('sha256').update(`toon-dkp:${process.env.GOOGLE_SHEET_ID?.trim()}:${manager._id.toString()}:${body.requestId}`).digest('hex');
          await ClanAuditEvent.create([{
            eventType: 'toon-transferred', actorUserId: manager._id, actorNickname: manager.nickname,
            actorRole: manager.role, targetUserId: source._id, targetNickname: source.nickname,
            previousRole: source.role, transferToUserId: destination._id, transferToNickname: destination.nickname,
            transferStatus: 'pending', operationKey: transferAuditKey,
            dkpOperationKey, activityWeeksBefore,
            hadPriorDkpReset: Boolean(priorReset), priorDkpResetAt: priorReset?.resetAt,
            priorDkpResetByUserId: priorReset?.resetByUserId, priorDkpResetByNickname: priorReset?.resetByNickname,
            sourceLinksBefore, sourceLinksAfter: snapshotUserLinks(source, roster, remainingRows), destinationLinksBefore,
            removedToons: [{ rowIndex: record.rowIndex, owner: record.owner, account: record.account }],
          }], { session });
        },
        mutate: async (session, record, manager, roster) => {
          const source = await User.findOne({ _id: userId, status: 'approved' }).session(session);
          const destination = await User.findOne({ _id: toUserId, status: 'approved' }).session(session);
          if (!source || !destination) throw new RequestValidationError('Both accounts must be approved clan members.', 409);
          const transferEvent = await ClanAuditEvent.findOne({ operationKey: transferAuditKey, transferStatus: 'pending' }).session(session);
          if (!transferEvent || !transferEvent.targetUserId?.equals(source._id) || !transferEvent.transferToUserId?.equals(destination._id) ||
            !transferEvent.removedToons?.some((toon) => getSheetRecordKey(toon) === getSheetRecordKey(record))) {
            throw new RequestValidationError('The transfer could not be resumed. Refresh the member list and try again.', 409);
          }
          const destinationRows = getLinkedSheetRecordRows(destination, roster);
          if (destinationRows.includes(record.rowIndex)) throw new RequestValidationError('That toon is already linked to the destination account.', 409);
          const otherUsers = await User.find({ _id: { $nin: [source._id, destination._id] } })
            .select('nickname sheetRecords sheetRecordName').session(session).lean();
          const conflictingUser = otherUsers.find((user) => getLinkedSheetRecordRows(user, roster).includes(record.rowIndex));
          if (conflictingUser) throw new RequestValidationError(`This toon is linked to ${conflictingUser.nickname}. Refresh the member list and try again.`, 409);

          await ToonDkpReset.updateOne({ identityKey: getSheetRecordKey(record) }, {
            $set: { owner: record.owner, account: record.account, resetAt: new Date(), resetByUserId: manager._id, resetByNickname: manager.nickname },
          }, { upsert: true, session });
          const weeklyRoster = await getRosterWithWeeklyEarned(roster, session);
          bidChanges = await withdrawToonOpenAuctionBids(record, roster, weeklyRoster, session);
          destination.sheetRecords = [
            ...(destination.sheetRecords ?? []).filter((saved) => getSheetRecordKey(saved) !== getSheetRecordKey(record)),
            { rowIndex: record.rowIndex, owner: record.owner, account: record.account },
          ];
          destination.sheetRecordName = undefined;
          await destination.save({ session });
          transferEvent.transferStatus = 'completed';
          transferEvent.transferToNickname = destination.nickname;
          transferEvent.addedToons = [{ rowIndex: record.rowIndex, owner: record.owner, account: record.account }];
          transferEvent.destinationLinksAfter = snapshotUserLinks(destination, roster, [...destinationRows, record.rowIndex]);
          transferEvent.removedToons = [{ rowIndex: record.rowIndex, owner: record.owner, account: record.account }];
          transferEvent.dkpBefore = [record.weeklyEarned, record.weeklySpent, record.earned, record.spent, record.available, record.fiveWeekActivity].map(String);
          transferEvent.withdrawnBids = bidChanges.withdrawnBids;
          transferEvent.promotedBids = bidChanges.promotedBids;
          await transferEvent.save({ session });
        },
      });
      if (result.replayed) {
        const audit = await ClanAuditEvent.findOne({ operationKey: transferAuditKey }).select('withdrawnBids promotedBids').lean();
        bidChanges = { withdrawnBids: audit?.withdrawnBids ?? 0, promotedBids: audit?.promotedBids ?? 0 };
      }
      return NextResponse.json({ success: true, ...result, ...bidChanges,
        message: `${account || owner} transferred to the new account. Its DKP was reset to 0; ${bidChanges.withdrawnBids} open bid(s) withdrawn and ${bidChanges.promotedBids} next bid(s) promoted.` }, { headers: privateHeaders });
    }
    let needsRoster = ['approve', 'link', 'unlink'].includes(action);
    if (action === 'remove') {
      const preview = await User.findById(userId).select('sheetRecordName sheetRecords').lean();
      needsRoster = Boolean(preview?.sheetRecords?.length || preview?.sheetRecordName?.trim());
    }
    let roster = needsRoster ? await getSheetRoster({ fresh: true }) : [];
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
    const applyMutation = () => withClanAdministrationTransaction(async (session) => {
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
        const [denialEvent] = await ClanAuditEvent.create([{ eventType: 'account-denial', actorUserId: manager._id,
          actorNickname: manager.nickname, actorRole: manager.role, targetUserId: target._id,
          targetNickname: target.nickname, previousRole: target.role }], { session });
        await archiveAccount(target, manager, denialEvent._id.toString(), 'account-denial', target.sheetRecords ?? [], session);
        await AuthSession.deleteMany({ userId: target._id }).session(session);
        await target.deleteOne({ session });
        return 'Sign-up request denied.';
      }

      if (action === 'remove') {
        if (target.status !== 'approved' || !['guardian', 'clansman'].includes(target.role)) throw new RequestValidationError('Only Guardian and Clansman accounts can be removed.');
        if (await ClanAuditEvent.exists({ eventType: 'toon-transferred', transferStatus: 'pending', $or: [
          { targetUserId: target._id }, { transferToUserId: target._id },
        ] }).session(session)) throw new RequestValidationError('Resume or resolve this account’s pending toon transfer before removing the account.', 409);
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
        const [removalEvent] = await ClanAuditEvent.create([{ eventType: 'member-removal', actorUserId: manager._id, actorNickname: manager.nickname,
          actorRole: manager.role, targetUserId: target._id, targetNickname: target.nickname, previousRole: target.role }], { session });
        await archiveAccount(target, manager, removalEvent._id.toString(), 'member-removal', currentIdentities, session);
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
      if (selected.length) {
        const pendingTransfers = await ClanAuditEvent.find({ eventType: 'toon-transferred', transferStatus: 'pending' })
          .select('removedToons').session(session).lean();
        const pendingKeys = new Set(pendingTransfers.flatMap((event) => (event.removedToons ?? []).map(getSheetRecordKey)));
        if (selected.some((record) => pendingKeys.has(getSheetRecordKey(record)))) {
          throw new RequestValidationError('Resume the pending transfer for this toon before changing its account link.', 409);
        }
      }
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
    const result = needsRoster || action === 'remove'
      ? await withDkpLedgerLock(async (lockedRoster) => {
        roster = lockedRoster;
        return applyMutation();
      })
      : await applyMutation();
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
