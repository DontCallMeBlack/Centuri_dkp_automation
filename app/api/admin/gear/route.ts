import { NextResponse } from 'next/server';
import { canManageClan, getSessionUser } from '@/lib/auth/session';
import { getSheetRosterSnapshot } from '@/lib/sheetRosterSnapshot';
import GearRequest from '@/lib/models/GearRequest';
import User from '@/lib/models/User';
import { getSheetRecordKey, getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';
import { writeGearAward, writeGearStatus } from '@/lib/googleSheets';
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
    const [snapshot, records, gearStatuses, members] = await Promise.all([
      getSheetRosterSnapshot({ fresh: true }),
      GearRequest.find().sort({ requestedAt: -1 }).lean(),
      readGearStatuses(),
      User.find({ status: 'approved' }).select('_id nickname sheetRecordName sheetRecords').lean(),
    ]);
    const requesterByRow = new Map<number, { id: string; nickname: string; toons: Array<{ rowIndex: number; owner: string; account: string }> }>();
    for (const member of members) {
      const memberToons = getLinkedSheetRecordRows(member, snapshot.roster).flatMap((row) => {
        const linkedToon = snapshot.roster.find((entry) => entry.rowIndex === row);
        return linkedToon ? [{ rowIndex: linkedToon.rowIndex, owner: linkedToon.owner, account: linkedToon.account }] : [];
      });
      const requester = { id: String(member._id), nickname: member.nickname, toons: memberToons };
      for (const linkedToon of memberToons) if (!requesterByRow.has(linkedToon.rowIndex)) requesterByRow.set(linkedToon.rowIndex, requester);
    }
    const latest = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const key = `${record.setType}:${getSheetRecordKey(record)}`;
      if (!latest.has(key)) latest.set(key, record);
    }
    const toons = snapshot.roster.map((toon) => ({
      ...toon,
      dg: gearStatuses[toon.rowIndex - 3]?.[0] ?? '',
      bdg: gearStatuses[toon.rowIndex - 3]?.[1] ?? '',
      requester: requesterByRow.get(toon.rowIndex) ? { id: requesterByRow.get(toon.rowIndex)!.id, nickname: requesterByRow.get(toon.rowIndex)!.nickname } : null,
      requesterToons: requesterByRow.get(toon.rowIndex)?.toons ?? [],
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
    const { action, setType, rowIndex, recipientRowIndex } = body;
    if (!validSetType(setType)) return NextResponse.json({ error: 'Choose DG or BDG.' }, { status: 400 });
    if (!['request', 'cancel', 'reveal', 'mailed'].includes(String(action))) return NextResponse.json({ error: 'Invalid gear action.' }, { status: 400 });

    if (action === 'reveal') {
      const [snapshot, gearStatuses, members] = await Promise.all([
        getSheetRosterSnapshot({ fresh: true }), readGearStatuses(),
        User.find({ status: 'approved' }).select('_id nickname sheetRecordName sheetRecords').lean(),
      ]);
      const records = await GearRequest.find({ setType }).sort({ requestedAt: -1 }).lean();
      const latest = new Map<string, (typeof records)[number]>();
      for (const record of records) {
        const key = getSheetRecordKey(record);
        if (!latest.has(key)) latest.set(key, record);
      }
      const requesterByRow = new Map<number, (typeof members)[number]>();
      for (const member of members) for (const linkedRow of getLinkedSheetRecordRows(member, snapshot.roster)) {
        if (!requesterByRow.has(linkedRow)) requesterByRow.set(linkedRow, member);
      }
      const scoreField = setType === 'DG' ? 'earned' : 'fiveWeekActivity';
      const candidates = snapshot.roster.flatMap((toon) => {
        const record = latest.get(getSheetRecordKey(toon));
        const score = toon[scoreField];
        const marker = gearStatuses[toon.rowIndex - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
        const requester = requesterByRow.get(toon.rowIndex);
        return record?.status === 'requested' && marker === 'R' && typeof score === 'number' && requester
          ? [{ record, toon, score, requester }]
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
          requesterId: String(candidate.requester._id), requesterNickname: candidate.requester.nickname,
          recipientToons: getLinkedSheetRecordRows(candidate.requester, snapshot.roster).flatMap((linkedRow) => {
            const recipient = snapshot.roster.find((entry) => entry.rowIndex === linkedRow);
            const recipientMarker = gearStatuses[linkedRow - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
            return recipient && (recipientMarker === '' || linkedRow === candidate.toon.rowIndex)
              ? [{ rowIndex: recipient.rowIndex, owner: recipient.owner, account: recipient.account }]
              : [];
          }),
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
      if (await GearRequest.exists({ setType, owner: toon.owner, account: toon.account, status: { $in: ['awarded', 'geared'] } })) {
        return NextResponse.json({ error: 'This toon has already spent its DKP on a set of this type. Use another toon.' }, { status: 409 });
      }
      if (currentStatus !== '' || current && current.status !== 'cancelled') return NextResponse.json({ error: 'This toon already has an active or completed gear record.' }, { status: 409 });
      const members = await User.find({ status: 'approved' }).select('_id nickname sheetRecordName sheetRecords').lean();
      const requester = members.find((member) => getLinkedSheetRecordRows(member, snapshot.roster).includes(toon.rowIndex));
      if (!requester) return NextResponse.json({ error: 'Link this requester toon to an approved account before adding a gear request.' }, { status: 409 });
      const score = setType === 'DG' ? toon.earned : toon.fiveWeekActivity;
      if (typeof score !== 'number') return NextResponse.json({ error: `The ${setType} ranking score for this toon is unavailable in the Sheet.` }, { status: 409 });
      const linkedStatus = await writeGearStatus({ rowIndex: Number(rowIndex), setType, status: 'R', expected: '', expectedIdentity: toon });
      const record = await GearRequest.create({ setType, rowIndex: Number(rowIndex), ...linkedStatus,
        requesterUserId: String(requester._id), status: 'requested', requestedBy: auth.user.nickname, requestedAt: new Date() });
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
      if (!current || current.status !== 'pending-mail') return NextResponse.json({ error: 'This toon is not pending mail.' }, { status: 409 });
      const selectedRecipientRow = typeof recipientRowIndex === 'number' ? recipientRowIndex : current.recipientRowIndex;
      if (typeof selectedRecipientRow !== 'number' || !Number.isInteger(selectedRecipientRow) || selectedRecipientRow < 3 || selectedRecipientRow > 1000) {
        return NextResponse.json({ error: 'Choose a toon to receive the gear.' }, { status: 400 });
      }
      const requester = current.requesterUserId
        ? await User.findOne({ _id: current.requesterUserId, status: 'approved' }).select('_id nickname sheetRecordName sheetRecords').lean()
        : (await User.find({ status: 'approved' }).select('_id nickname sheetRecordName sheetRecords').lean())
          .find((member) => getLinkedSheetRecordRows(member, snapshot.roster).includes(toon.rowIndex)) ?? null;
      if (!requester) return NextResponse.json({ error: 'The requester account is no longer active.' }, { status: 409 });
      const recipientIsLinked = getLinkedSheetRecordRows(requester, snapshot.roster).includes(selectedRecipientRow);
      const recipientToon = recipientIsLinked ? snapshot.roster.find((entry) => entry.rowIndex === selectedRecipientRow) : undefined;
      if (!recipientToon) return NextResponse.json({ error: 'Choose a toon linked to the requester account.' }, { status: 400 });
      const recipientStatus = gearStatuses[selectedRecipientRow - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
      const expectedAttribution = `X by ${toon.account || toon.owner}`;
      const sourceStatus = gearStatuses[toon.rowIndex - 3]?.[setType === 'DG' ? 0 : 1] ?? '';
      const awardAlreadyWritten = recipientStatus === expectedAttribution && (selectedRecipientRow === toon.rowIndex || sourceStatus === '');
      if (recipientStatus !== '' && selectedRecipientRow !== toon.rowIndex && !awardAlreadyWritten) return NextResponse.json({ error: 'That toon already has a request or a gear record for this set type.' }, { status: 409 });
      if (selectedRecipientRow !== toon.rowIndex && await GearRequest.exists({ setType, rowIndex: selectedRecipientRow, owner: recipientToon.owner, account: recipientToon.account, status: { $in: ['requested', 'pending-mail'] } })) {
        return NextResponse.json({ error: 'That toon has an active request of its own. Choose a different toon.' }, { status: 409 });
      }
      if (awardAlreadyWritten) {
        const terminalStatus = selectedRecipientRow === toon.rowIndex ? 'geared' : 'awarded';
        await GearRequest.updateOne({ _id: current._id, status: 'pending-mail' }, { $set: {
          status: terminalStatus, requesterUserId: String(requester._id), recipientRowIndex: selectedRecipientRow,
          recipientOwner: recipientToon.owner, recipientAccount: recipientToon.account, mailedAt: current.mailedAt ?? new Date(), mailedBy: current.mailedBy ?? auth.user.nickname,
        } });
        return NextResponse.json({ success: true, message: `${recipientToon.account || recipientToon.owner} marked as geared for ${setType} by ${toon.account || toon.owner}.` }, { headers: noStore });
      }
      if (sourceStatus !== 'R') return NextResponse.json({ error: 'The source request status changed. Refresh the gear list before confirming mail.' }, { status: 409 });
      await GearRequest.updateOne({ _id: current._id, status: 'pending-mail' }, { $set: {
        requesterUserId: String(requester._id), recipientRowIndex: selectedRecipientRow,
        recipientOwner: recipientToon.owner, recipientAccount: recipientToon.account,
      } });
      await writeGearAward({
        setType,
        source: { rowIndex: toon.rowIndex, owner: toon.owner, account: toon.account },
        recipient: { rowIndex: recipientToon.rowIndex, owner: recipientToon.owner, account: recipientToon.account },
      });
      await GearRequest.updateOne({ _id: current._id, status: 'pending-mail' }, { $set: {
        status: selectedRecipientRow === toon.rowIndex ? 'geared' : 'awarded', requesterUserId: String(requester._id), recipientRowIndex: selectedRecipientRow,
        recipientOwner: recipientToon.owner, recipientAccount: recipientToon.account,
        mailedAt: new Date(), mailedBy: auth.user.nickname,
      } });
      return NextResponse.json({ success: true, message: `${recipientToon.account || recipientToon.owner} marked as geared for ${setType} by ${toon.account || toon.owner}.` }, { headers: noStore });
    }

    return NextResponse.json({ error: 'Invalid gear action.' }, { status: 400 });
  } catch (error) {
    return requestErrorResponse(error, 'Unable to update gear tracking');
  }
}
