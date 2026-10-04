import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import User from '@/lib/models/User';
import { getAuthenticatedUser } from '@/lib/auth/session';
import { getSheetRoster } from '@/lib/googleSheets';

function isAdmin(role: string) {
  return role === 'chief' || role === 'general';
}

async function getAdmin() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  if (!isAdmin(user.role)) {
    return { response: NextResponse.json({ error: 'Permission denied' }, { status: 403 }) };
  }
  return { user };
}

export async function GET() {
  try {
    const admin = await getAdmin();
    if (admin.response) return admin.response;

    await dbConnect();
    const [users, roster] = await Promise.all([
      User.find({})
        .select('nickname role status createdAt linkedRosterRow linkedRosterOwner linkedRosterAccount linkedRosterSubClass')
        .sort({ createdAt: 1 })
        .lean(),
      getSheetRoster(),
    ]);

    return NextResponse.json({
      success: true,
      users: users.map((user) => ({
        id: user._id.toString(),
        nickname: user.nickname,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        linkedRosterRow: user.linkedRosterRow ?? null,
        linkedRosterOwner: user.linkedRosterOwner ?? '',
        linkedRosterAccount: user.linkedRosterAccount ?? '',
        linkedRosterSubClass: user.linkedRosterSubClass ?? '',
      })),
      roster,
    });
  } catch (error) {
    console.error('Admin list error:', error);
    return NextResponse.json({ error: 'Unable to load account administration data' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const admin = await getAdmin();
    if (admin.response) return admin.response;

    const body = await req.json();
    const { action, userId, rosterRowIndex } = body;
    if (!['approve', 'link'].includes(action) ||
      typeof userId !== 'string' ||
      !/^[a-f\d]{24}$/i.test(userId) ||
      !Number.isInteger(rosterRowIndex)) {
      return NextResponse.json({ error: 'Invalid account or roster selection' }, { status: 400 });
    }

    await dbConnect();
    const target = await User.findById(userId);
    if (!target) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (action === 'approve' && target.status !== 'pending') {
      return NextResponse.json({ error: 'Only pending accounts can be approved' }, { status: 400 });
    }
    if (action === 'link' && target.status !== 'approved') {
      return NextResponse.json({ error: 'Only approved accounts can be linked' }, { status: 400 });
    }

    const roster = await getSheetRoster();
    const rosterMember = roster.find((member) => member.rowIndex === rosterRowIndex);
    if (!rosterMember) {
      return NextResponse.json({ error: 'That record is no longer on the Google Sheets roster' }, { status: 400 });
    }

    const linkedUser = await User.findOne({
      linkedRosterRow: rosterRowIndex,
      _id: { $ne: target._id },
    }).select('nickname');
    if (linkedUser) {
      return NextResponse.json({
        error: `This roster record is already linked to ${linkedUser.nickname}`,
      }, { status: 409 });
    }

    target.linkedRosterRow = rosterMember.rowIndex;
    target.linkedRosterOwner = rosterMember.owner;
    target.linkedRosterAccount = rosterMember.account;
    target.linkedRosterSubClass = rosterMember.subClass;
    if (action === 'approve') target.status = 'approved';
    await target.save();

    return NextResponse.json({
      success: true,
      message: action === 'approve' ? `${target.nickname} was approved and linked` : `${target.nickname}'s roster link was updated`,
    });
  } catch (error) {
    console.error('Admin account update error:', error);
    return NextResponse.json({ error: 'Unable to update this account' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const admin = await getAdmin();
    if (admin.response) return admin.response;

    const body = await req.json();
    const { userId } = body;
    if (typeof userId !== 'string' || !/^[a-f\d]{24}$/i.test(userId)) {
      return NextResponse.json({ error: 'Invalid account selection' }, { status: 400 });
    }
    if (userId === admin.user.id) {
      return NextResponse.json({ error: 'You cannot remove your own account' }, { status: 400 });
    }

    await dbConnect();
    const target = await User.findById(userId).select('nickname role');
    if (!target) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (admin.user.role !== 'chief' && target.role !== 'clansman') {
      return NextResponse.json({ error: 'Only the Chief can remove another administrator' }, { status: 403 });
    }

    await target.deleteOne();
    return NextResponse.json({ success: true, message: `${target.nickname}'s account was removed` });
  } catch (error) {
    console.error('Admin account removal error:', error);
    return NextResponse.json({ error: 'Unable to remove this account' }, { status: 500 });
  }
}
