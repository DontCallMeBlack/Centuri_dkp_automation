import { NextResponse } from 'next/server';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRosterSnapshot } from '@/lib/sheetRosterSnapshot';
import GearRequest from '@/lib/models/GearRequest';
import { getSheetRecordKey } from '@/lib/sheetRecordLinks';
import { writeGearStatus } from '@/lib/googleSheets';
import { readGearStatuses } from '@/lib/googleSheetsRead';
import { guardMutationRequest, readJsonObject, requestErrorResponse } from '@/lib/security/request';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const noStore = { 'Cache-Control': 'private, no-store' };
type SetType = 'DG' | 'BDG';
const validSetType = (value: unknown): value is SetType => value === 'DG' || value === 'BDG';

async function requireManager() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!canManageClan(user.role)) return { ok: false as const, response: NextResponse.json({ error: 'This page is limited to Chief and General accounts.' }, { status: 403 }) };
  return { ok: true as const, user };
}

export async function GET() {
  try {
    const auth = await requireManager();
    if (!auth.ok) return auth.response;
    const [snapshot, records, gearStatuses] = await Promise.all([
      getSheetRosterSnapshot({ fresh: true }),
      GearRequest.find().sort({ requestedAt: -1 }).lean(),
      readGearStatuses(),
    ]);
    const latest = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const key = `${record.setType}:${getSheetRecordKey(record)}`;
      if (!latest.has(key)) latest.set(key, record);
    }
    const toons = snapshot.roster.map((toon) => ({
      ...toon,
      dg: gearStatuses[toon.rowIndex - 3]?.[0] ?? '',
      bdg: gearStatuses[toon.rowIndex - 3]?.[1] ?? '',
      dgRequest: latest.get(`DG:${getSheetRecordKey(toon)}`) ?? null,
      bdgRequest: latest.get(`BDG:${getSheetRecordKey(toon)}`) ?? null,
    }));
    return NextResponse.json({ success: true, toons }, { headers: noStore });
  } catch (error) {
    return requestErrorResponse(error, 'Unable to load gear requests');
  }
}

export async function POST(request: Request) {
  const rejected = guardMutationRequest(request);
  if (rejected) return rejected;
  try {
    const auth = await requireManager();
    if (!auth.ok) return auth.response;
    const body = await readJsonObject(request);
    const { action, setType, rowIndex } = body;
    if (!validSetType(setType)) return NextResponse.json({ error: 'Choose DG or BDG.' }, { status: 400 });
    if (!['request', 'cancel', 'reveal', 'mailed'].includes(String(action))) return NextResponse.json({ error: 'Invalid gear action.' }, { status: 400 });

    if (action === 'reveal') {
      const [snapshot, gearStatuses] = await Promise.all([getSheetRosterSnapshot({ fresh: true }), readGearStatuses()]);
      const records = await GearRequest.find({ setType }).sort({ requestedAt: -1 }).lean();
      const latest = new Map<string, (typeof records)[number]>();
      for (const record of records) {
        const key = getSheetRecordKey(record);
        if (!latest.has(key)) latest.set(key, record);
      }
      const scoreField = setType === 'DG' ? 'earned' : 'fiveWeekActivity';
      const candidates = snapshot.roster.flatMap((toon) => {
        const record = latest.get(getSheetRecordKey(toon));
        const score = toon[scoreField];
        const marker = gearStatuses[toon.rowIndex - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
        return record?.status === 'requested' && marker === 'R' && typeof score === 'number'
          ? [{ record, toon, score }]
          : [];
      }).sort((a, b) => b.score - a.score || a.record.requestedAt.getTime() - b.record.requestedAt.getTime());
      for (const candidate of candidates) {
        const claimed = await GearRequest.findOneAndUpdate(
          { _id: candidate.record._id, status: 'requested' },
          { $set: { status: 'pending-mail', winnerRevealedAt: new Date() } },
          { returnDocument: 'after' },
        ).lean();
        if (claimed) return NextResponse.json({ success: true, winner: {
          rowIndex: candidate.toon.rowIndex, owner: candidate.toon.owner, account: candidate.toon.account,
          score: candidate.score, requestedAt: claimed.requestedAt, requestId: String(claimed._id),
        }, message: `${candidate.toon.account || candidate.toon.owner} is the next ${setType} winner and is pending mail.` }, { headers: noStore });
      }
      return NextResponse.json({ error: `There are no eligible ${setType} requests to reveal.` }, { status: 409, headers: noStore });
    }

    if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
      return NextResponse.json({ error: 'Choose a valid roster toon.' }, { status: 400 });
    }
    const snapshot = await getSheetRosterSnapshot({ fresh: true });
    const toon = snapshot.roster.find((item) => item.rowIndex === Number(rowIndex));
    if (!toon) return NextResponse.json({ error: 'That toon is no longer on the roster.' }, { status: 404 });
    const gearStatuses = await readGearStatuses();
    const currentStatus = gearStatuses[toon.rowIndex - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
    const current = await GearRequest.findOne({ setType, rowIndex: Number(rowIndex), owner: toon.owner, account: toon.account }).sort({ requestedAt: -1 }).lean();

    if (action === 'request') {
      if (currentStatus !== '' || current && current.status !== 'cancelled') return NextResponse.json({ error: 'This toon already has an active or completed gear record.' }, { status: 409 });
      const score = setType === 'DG' ? toon.earned : toon.fiveWeekActivity;
      if (typeof score !== 'number') return NextResponse.json({ error: `The ${setType} ranking score for this toon is unavailable in the Sheet.` }, { status: 409 });
      const linkedStatus = await writeGearStatus({ rowIndex: Number(rowIndex), setType, status: 'R', expected: '', expectedIdentity: toon });
      const record = await GearRequest.create({ setType, rowIndex: Number(rowIndex), ...linkedStatus,
        status: 'requested', requestedBy: auth.user.nickname, requestedAt: new Date() });
      return NextResponse.json({ success: true, message: `${linkedStatus.account || linkedStatus.owner} added to ${setType} requests.`, requestId: String(record._id) }, { headers: noStore });
    }

    if (action === 'cancel') {
      if (!current || !['requested', 'cancelled'].includes(current.status) || currentStatus !== 'R') return NextResponse.json({ error: 'Only a request that has not won can be removed.' }, { status: 409 });
      if (current.status === 'requested') {
        const cancelled = await GearRequest.findOneAndUpdate({ _id: current._id, status: 'requested' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' }).lean();
        if (!cancelled) return NextResponse.json({ error: 'This request was already claimed as a winner. Refresh the gear list.' }, { status: 409 });
      }
      await writeGearStatus({ rowIndex: Number(rowIndex), setType, status: '', expected: 'R', expectedIdentity: toon });
      return NextResponse.json({ success: true, message: `${toon.account || toon.owner} removed from ${setType} requests.` }, { headers: noStore });
    }

    if (action === 'mailed') {
      if (!current || current.status !== 'pending-mail' || currentStatus !== 'R') return NextResponse.json({ error: 'This toon is not pending mail.' }, { status: 409 });
      await writeGearStatus({ rowIndex: Number(rowIndex), setType, status: 'X', expected: 'R', expectedIdentity: toon });
      await GearRequest.updateOne({ _id: current._id, status: 'pending-mail' }, { $set: { status: 'geared', mailedAt: new Date(), mailedBy: auth.user.nickname } });
      return NextResponse.json({ success: true, message: `${toon.account || toon.owner} marked as geared for ${setType}.` }, { headers: noStore });
    }

    return NextResponse.json({ error: 'Invalid gear action.' }, { status: 400 });
  } catch (error) {
    return requestErrorResponse(error, 'Unable to update gear tracking');
  }
}
