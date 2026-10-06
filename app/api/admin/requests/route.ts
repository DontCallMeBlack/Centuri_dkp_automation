import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import ClanAuditEvent from '@/lib/models/ClanAuditEvent';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';

const MEMBER_ROLES = ['clansman', 'guardian'] as const;
const ASSIGNABLE_ROLES = ['chief', 'general', 'guardian', 'clansman'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' &&
    (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

function isValidRowIndexArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((rowIndex): rowIndex is number =>
      typeof rowIndex === 'number' && Number.isInteger(rowIndex) && rowIndex > 0
    ) &&
    new Set(value).size === value.length;
}

export async function GET() {
  const manager = await getSessionUser();
  if (!manager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageClan(manager.role)) {
    return NextResponse.json({ error: 'This page is limited to Chief and General accounts', role: manager.role }, { status: 403 });
  }

  try {
    await dbConnect();
    const [pendingUsers, members, roster, auditEvents] = await Promise.all([
      User.find({ status: 'pending' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ createdAt: 1 }).lean(),
      User.find({ status: 'approved' })
        .select('_id nickname role status sheetRecordName sheetRecords')
        .sort({ nickname: 1 })
        .lean(),
      getSheetRoster(),
      ClanAuditEvent.find()
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    const includeLinkedRows = (user: (typeof members)[number]) => ({
      ...user,
      sheetRecordRows: getLinkedSheetRecordRows(user, roster),
    });

    return NextResponse.json({
      success: true,
      managerRole: manager.role,
      managerId: manager._id.toString(),
      pendingUsers: pendingUsers.map(includeLinkedRows),
      members: members.map(includeLinkedRows),
      roster,
      auditEvents: auditEvents.map(({ _id, ...event }) => ({
        ...event,
        id: _id.toString(),
        targetUserId: event.targetUserId.toString(),
        actorUserId: event.actorUserId.toString(),
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load clan administration data';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const manager = await getSessionUser();
  if (!manager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageClan(manager.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    await dbConnect();
    const body = await req.json();
    const { action } = body;
    const userId = typeof body.userId === 'string' ? body.userId : '';

    if (!['approve', 'deny', 'link', 'unlink', 'remove', 'set-role'].includes(action) || !mongoose.isValidObjectId(userId)) {
      return NextResponse.json({ error: 'Invalid administration request' }, { status: 400 });
    }

    const target = await User.findById(userId);
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    if (action === 'set-role') {
      if (target.status !== 'approved') {
        return NextResponse.json({ error: 'Only approved accounts can have their role changed' }, { status: 400 });
      }

      const requestedRole: unknown = body.role;
      if (!isAssignableRole(requestedRole)) {
        return NextResponse.json({ error: 'Select a valid member role' }, { status: 400 });
      }
      if (target._id.equals(manager._id)) {
        return NextResponse.json({ error: 'You cannot change your own role' }, { status: 400 });
      }
      if (manager.role === 'general' &&
        (!(MEMBER_ROLES as readonly string[]).includes(requestedRole) ||
          target.role === 'chief' || target.role === 'general')) {
        return NextResponse.json({
          error: 'Generals can only promote or demote Guardian and Clansman accounts',
        }, { status: 403 });
      }
      if (target.role === requestedRole) {
        return NextResponse.json({ error: 'This account already has that role' }, { status: 400 });
      }
      const previousRole = target.role;
      if (target.role === 'chief' && requestedRole !== 'chief') {
        const chiefCount = await User.countDocuments({ status: 'approved', role: 'chief' });
        if (chiefCount <= 1) {
          return NextResponse.json({ error: 'The last Chief account cannot be demoted' }, { status: 409 });
        }
      }

      const roleOrder = ['chief', 'general', 'guardian', 'clansman'];
      const eventType = roleOrder.indexOf(requestedRole) < roleOrder.indexOf(target.role)
        ? 'promotion'
        : 'demotion';
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          target.role = requestedRole;
          await target.save({ session });
          await ClanAuditEvent.create([{
            eventType,
            actorUserId: manager._id,
            actorNickname: manager.nickname,
            actorRole: manager.role,
            targetUserId: target._id,
            targetNickname: target.nickname,
            previousRole,
            newRole: requestedRole,
          }], { session });
        });
      } finally {
        await session.endSession();
      }
      return NextResponse.json({
        success: true,
        message: `Updated ${target.nickname}'s role to ${requestedRole}.`,
      });
    }

    if (action === 'unlink') {
      if (target.status !== 'approved') {
        return NextResponse.json({ error: 'Only approved accounts can have toons unlinked' }, { status: 400 });
      }

      const requestedRows: unknown = body.sheetRecordRows;
      if (!isValidRowIndexArray(requestedRows) || requestedRows.length !== 1) {
        return NextResponse.json({ error: 'Select one valid linked toon to unlink' }, { status: 400 });
      }

      const roster = await getSheetRoster();
      const linkedRows = getLinkedSheetRecordRows(target, roster);
      const rowToUnlink = requestedRows[0];
      if (!linkedRows.includes(rowToUnlink)) {
        return NextResponse.json({ error: 'That toon is not linked to this account' }, { status: 400 });
      }

      const rosterByRow = new Map(roster.map((record) => [record.rowIndex, record]));
      target.sheetRecords = linkedRows
        .filter((rowIndex) => rowIndex !== rowToUnlink)
        .flatMap((rowIndex) => {
          const record = rosterByRow.get(rowIndex);
          return record ? [{ rowIndex, owner: record.owner, account: record.account }] : [];
        });
      target.sheetRecordName = undefined;
      await target.save();

      const unlinkedRecord = rosterByRow.get(rowToUnlink);
      return NextResponse.json({
        success: true,
        message: `${unlinkedRecord?.account || unlinkedRecord?.owner || 'Toon'} unlinked from ${target.nickname} and is now available.`,
      });
    }

    if (action === 'deny') {
      if (target.status !== 'pending') {
        return NextResponse.json({ error: 'Only pending requests can be denied' }, { status: 400 });
      }
      await target.deleteOne();
      return NextResponse.json({ success: true, message: 'Sign-up request denied' });
    }

    if (action === 'remove') {
      if (target.status !== 'approved' || !(MEMBER_ROLES as readonly string[]).includes(target.role)) {
        return NextResponse.json({ error: 'Only approved clan member accounts can be removed' }, { status: 400 });
      }
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await ClanAuditEvent.create([{
            eventType: 'member-removal',
            actorUserId: manager._id,
            actorNickname: manager.nickname,
            actorRole: manager.role,
            targetUserId: target._id,
            targetNickname: target.nickname,
            previousRole: target.role,
          }], { session });
          await target.deleteOne({ session });
        });
      } finally {
        await session.endSession();
      }
      return NextResponse.json({ success: true, message: 'Clan member account removed' });
    }

    if (action === 'link' && target.status !== 'approved') {
      return NextResponse.json({ error: 'Only approved accounts can be linked' }, { status: 400 });
    }
    if (action === 'approve' && target.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending requests can be approved' }, { status: 400 });
    }

    const requestedRows: unknown = body.sheetRecordRows;
    if (!isValidRowIndexArray(requestedRows)) {
      return NextResponse.json({ error: 'Select at least one valid toon row' }, { status: 400 });
    }

    const roster = await getSheetRoster();
    const rosterByRow = new Map(roster.map((record) => [record.rowIndex, record]));
    const selectedRecords = requestedRows.map((rowIndex) => rosterByRow.get(rowIndex));
    if (selectedRecords.some((record) => record === undefined)) {
      return NextResponse.json({ error: 'One or more selected toon rows no longer exist' }, { status: 400 });
    }
    const validSelectedRecords = selectedRecords.filter((record) => record !== undefined);

    const linkedUsers = await User.find({
      _id: { $ne: target._id },
      status: 'approved',
    }).select('sheetRecordName sheetRecords').lean();
    const occupiedRows = new Set(
      linkedUsers.flatMap((user) => getLinkedSheetRecordRows(user, roster)),
    );
    if (validSelectedRecords.some((record) => occupiedRows.has(record.rowIndex))) {
      return NextResponse.json({ error: 'One or more selected toon rows are already linked to another user' }, { status: 409 });
    }

    target.sheetRecords = validSelectedRecords.map(({ rowIndex, owner, account }) => ({
      rowIndex,
      owner,
      account,
    }));
    target.sheetRecordName = undefined;
    if (action === 'approve') target.status = 'approved';
    await target.save();

    return NextResponse.json({
      success: true,
      message: action === 'approve'
        ? `Request approved and linked to ${validSelectedRecords.length} toon(s)`
        : `User linked to ${validSelectedRecords.length} toon(s)`,
    });
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return NextResponse.json({
        error: 'One or more selected toon rows are already linked to another user',
      }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Unable to complete administration request';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}