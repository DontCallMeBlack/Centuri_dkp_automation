import { getSessionUser } from '@/lib/auth/session';
import { requestErrorResponse } from '@/lib/security/request';
import SheetRosterCache from '@/lib/models/SheetRosterCache';
import { getLinkedSheetRecordRows } from '@/lib/sheetRecordLinks';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    // Session/role checks must not depend on Google Sheets availability.
    // Resolve against the shared roster snapshot rather than stale saved rows.
    const cache = await SheetRosterCache.findOne({ cacheKey: process.env.GOOGLE_SHEET_ID?.trim() })
      .select('roster.rowIndex roster.owner roster.account').lean();
    const roster = cache?.roster ?? [];
    return Response.json({ success: true, user: {
      id: user._id.toString(), nickname: user.nickname, role: user.role,
      sheetRecordRows: getLinkedSheetRecordRows(user, roster),
    } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return requestErrorResponse(error, 'Unable to load your session. Please retry.'); }
}
