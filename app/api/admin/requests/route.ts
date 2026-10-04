import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { getAdminUser } from '@/lib/session';
import { getSheetRoster } from '@/lib/googleSheets';

export async function GET() {
  try {
    const admin = await getAdminUser();
    if (!admin) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

    await dbConnect();
    const [users, roster] = await Promise.all([
      User.find().select('_id nickname role status sheetRecordName createdAt').sort({ createdAt: -1 }).lean(),
      getSheetRoster(),
    ]);

    return NextResponse.json({
      success: true,
      users: users.map((user) => ({ ...user, _id: user._id.toString() })),
      roster: roster.map(({ owner, account }) => ({ owner, account })),
      adminRole: admin.role,
      currentUserId: admin.userId,
    });
  } catch (error) {
    console.error('Failed to load admin user management data:', error);
    return NextResponse.json({ error: 'Failed to load users or Google Sheets roster.' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const admin = await getAdminUser();
    if (!admin) return NextResponse.json({ error: 'Permission denied' }, { status: 403 });

    const body: unknown = await req.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { action, userId, sheetRecordName, role } = body as {
      action?: unknown;
      userId?: unknown;
      sheetRecordName?: unknown;
      role?: unknown;
    };
    if (typeof action !== 'string' || typeof userId !== 'string' || !mongoose.isValidObjectId(userId)) {
      return NextResponse.json({ error: 'A valid user and action are required.' }, { status: 400 });
    }

    await dbConnect();
    const targetUser = await User.findById(userId);
    if (!targetUser) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

    if (action === 'approve') {
      if (targetUser.status !== 'pending') {
        return NextResponse.json({ error: 'This signup is no longer pending.' }, { status: 409 });
      }
      if (sheetRecordName !== undefined && typeof sheetRecordName !== 'string') {
        return NextResponse.json({ error: 'Choose a valid Google Sheets record name.' }, { status: 400 });
      }
      if (typeof sheetRecordName === 'string' && sheetRecordName.trim()) {
        const linkedRecord = await validateSheetRecord(sheetRecordName, userId);
        if (linkedRecord instanceof NextResponse) return linkedRecord;
        targetUser.sheetRecordName = linkedRecord;
      }
      targetUser.status = 'approved';
      await targetUser.save();
      return NextResponse.json({ success: true, message: `${targetUser.nickname} approved.` });
    }

    if (action === 'reject') {
      if (targetUser.status !== 'pending') {
        return NextResponse.json({ error: 'Only pending signups can be rejected.' }, { status: 409 });
      }
      await targetUser.deleteOne();
      return NextResponse.json({ success: true, message: `${targetUser.nickname}'s signup was rejected.` });
    }

    if (action === 'link') {
      if (typeof sheetRecordName !== 'string') {
        return NextResponse.json({ error: 'Select a Sheet record or choose not linked.' }, { status: 400 });
      }
      const normalizedName = sheetRecordName.trim();
      if (normalizedName) {
        const linkedRecord = await validateSheetRecord(normalizedName, userId);
        if (linkedRecord instanceof NextResponse) return linkedRecord;
        targetUser.sheetRecordName = linkedRecord;
      } else {
        targetUser.sheetRecordName = undefined;
      }
      await targetUser.save();
      return NextResponse.json({
        success: true,
        message: normalizedName
          ? `${targetUser.nickname} linked to ${targetUser.sheetRecordName}.`
          : `${targetUser.nickname}'s Sheet link was removed.`,
      });
    }

    if (action === 'delete') {
      if (targetUser._id.toString() === admin.userId) {
        return NextResponse.json({ error: 'You cannot remove your own account.' }, { status: 400 });
      }
      if (targetUser.status === 'pending') {
        return NextResponse.json({ error: 'Reject pending signups instead of removing them.' }, { status: 409 });
      }
      if (targetUser.role === 'chief') {
        return NextResponse.json({ error: 'Chief accounts cannot be removed here.' }, { status: 403 });
      }
      await targetUser.deleteOne();
      return NextResponse.json({ success: true, message: `${targetUser.nickname}'s account was removed.` });
    }

    if (action === 'set-role') {
      if (admin.role !== 'chief') {
        return NextResponse.json({ error: 'Only the Chief can change user roles.' }, { status: 403 });
      }
      if (targetUser._id.toString() === admin.userId || targetUser.role === 'chief') {
        return NextResponse.json({ error: 'Chief accounts cannot be changed here.' }, { status: 403 });
      }
      if (role !== 'general' && role !== 'clansman') {
        return NextResponse.json({ error: 'Choose General or Member.' }, { status: 400 });
      }
      targetUser.role = role;
      await targetUser.save();
      return NextResponse.json({
        success: true,
        message: `${targetUser.nickname} is now a ${role === 'general' ? 'General' : 'Member'}.`,
      });
    }

    return NextResponse.json({ error: 'Unknown user-management action.' }, { status: 400 });
  } catch (error) {
    console.error('Failed to update managed user:', error);
    return NextResponse.json({ error: 'Failed to update the user.' }, { status: 500 });
  }
}

async function validateSheetRecord(name: string, userId: string): Promise<string | NextResponse> {
  const roster = await getSheetRoster();
  const record = roster.find((member) => member.owner.toLowerCase() === name.toLowerCase());
  if (!record) {
    return NextResponse.json({ error: 'That name is not present in the Google Sheets roster.' }, { status: 400 });
  }

  const existingLink = await User.findOne({
    _id: { $ne: userId },
    sheetRecordName: new RegExp(`^${escapeRegExp(record.owner)}$`, 'i'),
  }).select('_id nickname');
  if (existingLink) {
    return NextResponse.json({ error: `That Sheet record is already linked to ${existingLink.nickname}.` }, { status: 409 });
  }
  return record.owner;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
