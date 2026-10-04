import { NextResponse } from 'next/server';
import { Types } from 'mongoose';
import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { getSheetRoster } from '@/lib/googleSheets';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

async function getChiefSession() {
  const token = (await cookies()).get('token')?.value;
  if (!token) return null;

  try {
    const session = jwt.verify(token, JWT_SECRET) as { userId: string; role: string };
    return session.role === 'chief' ? session : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const session = await getChiefSession();
  if (!session) {
    return NextResponse.json({ error: 'Chief access required' }, { status: 403 });
  }

  try {
    await dbConnect();
    const [pendingUsers, roster] = await Promise.all([
      User.find({ status: 'pending' }).select('nickname role status').lean(),
      getSheetRoster(),
    ]);

    return NextResponse.json({
      success: true,
      pendingUsers: pendingUsers.map((user) => ({
        ...user,
        _id: user._id.toString(),
      })),
      roster,
    });
  } catch (error) {
    console.error('Failed to load sign-up requests:', error);
    return NextResponse.json({ error: 'Failed to load sign-up requests' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getChiefSession();
  if (!session) {
    return NextResponse.json({ error: 'Chief access required' }, { status: 403 });
  }

  try {
    const { userId, action, sheetRecordName } = await req.json();
    if (typeof userId !== 'string' || !Types.ObjectId.isValid(userId)) {
      return NextResponse.json({ error: 'A valid user ID is required' }, { status: 400 });
    }

    await dbConnect();
    const user = await User.findOne({ _id: userId, status: 'pending' });
    if (!user) {
      return NextResponse.json({ error: 'Pending request not found' }, { status: 404 });
    }

    if (action === 'approve') {
      if (typeof sheetRecordName !== 'string' || !sheetRecordName.trim()) {
        return NextResponse.json({ error: 'A sheet record must be selected' }, { status: 400 });
      }

      const roster = await getSheetRoster();
      const matchedRecord = roster.find((member) => member.owner === sheetRecordName);
      if (!matchedRecord) {
        return NextResponse.json({ error: 'Selected sheet record was not found' }, { status: 400 });
      }

      user.status = 'approved';
      user.sheetRecordName = matchedRecord.owner;
      await user.save();
      return NextResponse.json({ success: true });
    }

    if (action === 'reject') {
      user.status = 'rejected';
      await user.save();
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Failed to update sign-up request:', error);
    return NextResponse.json({ error: 'Failed to update sign-up request' }, { status: 500 });
  }
}
