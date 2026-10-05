import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster } from '@/lib/googleSheets';
import { getLinkedSheetRecordRows, getSheetRecordKey } from '@/lib/sheetRecordLinks';

const MEMBER_ROLES = ['clansman', 'guardian'] as const;

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
    const [pendingUsers, members, roster] = await Promise.all([
      User.find({ status: 'pending' }).select('_id nickname role status sheetRecordName sheetRecords').sort({ createdAt: 1 }).lean(),
      User.find({ status: 'approved' })
        .select('_id nickname role status sheetRecordName sheetRecords')
        .sort({ nickname: 1 })
        .lean(),
      getSheetRoster(),
    ]);

    const includeLinkedRows = (user: (typeof members)[number]) => ({
      ...user,
      sheetRecordRows: getLinkedSheetRecordRows(user, roster),
    });

    return NextResponse.json({
      success: true,
      pendingUsers: pendingUsers.map(includeLinkedRows),
      members: members.map(includeLinkedRows),
      roster,
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

    if (!['approve', 'deny', 'link', 'remove'].includes(action) || !mongoose.isValidObjectId(userId)) {
      return NextResponse.json({ error: 'Invalid administration request' }, { status: 400 });
    }

    const target = await User.findById(userId);
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

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
      await target.deleteOne();
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
    const selectedKeys = new Set(validSelectedRecords.map(getSheetRecordKey));
    const occupiedKeys = new Set(
      linkedUsers.flatMap((user) => {
        if (user.sheetRecords?.length) return user.sheetRecords.map(getSheetRecordKey);
        const legacyOwner = user.sheetRecordName?.trim().toLowerCase();
        if (!legacyOwner) return [];
        return roster
          .filter((record) => record.owner.trim().toLowerCase() === legacyOwner)
          .map(getSheetRecordKey);
      }),
    );
    if ([...selectedKeys].some((key) => occupiedKeys.has(key))) {
      return NextResponse.json({ error: 'One or more selected toon rows are already linked to another user' }, { status: 409 });
    }

    target.sheetRecords = validSelectedRecords.map(({ owner, account }) => ({ owner, account }));
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
    const message = error instanceof Error ? error.message : 'Unable to complete administration request';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}