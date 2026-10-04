import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRoster } from '@/lib/googleSheets';

const MEMBER_ROLES = ['clansman', 'guardian'] as const;

export async function GET() {
  const manager = await getSessionUser();
  if (!manager) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canManageClan(manager.role)) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

  try {
    await dbConnect();
    const [pendingUsers, members, roster] = await Promise.all([
      User.find({ status: 'pending' }).select('_id nickname role status sheetRecordName').sort({ createdAt: 1 }).lean(),
      User.find({ status: 'approved', role: { $in: MEMBER_ROLES } })
        .select('_id nickname role status sheetRecordName')
        .sort({ nickname: 1 })
        .lean(),
      getSheetRoster(),
    ]);

    return NextResponse.json({ success: true, pendingUsers, members, roster });
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

    if (action === 'link' && (target.status !== 'approved' || !(MEMBER_ROLES as readonly string[]).includes(target.role))) {
      return NextResponse.json({ error: 'Only approved clan member accounts can be linked' }, { status: 400 });
    }
    if (action === 'approve' && target.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending requests can be approved' }, { status: 400 });
    }

    const requestedName = typeof body.sheetRecordName === 'string' ? body.sheetRecordName.trim() : '';
    const roster = await getSheetRoster();
    const sheetRecord = roster.find((entry) => entry.owner.toLowerCase() === requestedName.toLowerCase());
    if (!sheetRecord) {
      return NextResponse.json({ error: 'Select a name that exists in the Google Sheets roster' }, { status: 400 });
    }

    const linkedUsers = await User.find({
      _id: { $ne: target._id },
      status: 'approved',
      sheetRecordName: { $exists: true, $ne: '' },
    }).select('sheetRecordName').lean();
    if (linkedUsers.some((user) => user.sheetRecordName?.toLowerCase() === sheetRecord.owner.toLowerCase())) {
      return NextResponse.json({ error: 'That sheet record is already linked to another user' }, { status: 409 });
    }

    target.sheetRecordName = sheetRecord.owner;
    if (action === 'approve') target.status = 'approved';
    await target.save();

    return NextResponse.json({
      success: true,
      message: action === 'approve' ? 'Request approved and linked' : 'User linked to the sheet record',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to complete administration request';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}