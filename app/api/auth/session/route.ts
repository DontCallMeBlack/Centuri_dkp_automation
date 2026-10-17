import { getSessionUser } from '@/lib/auth/session';
import { requestErrorResponse } from '@/lib/security/request';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    return Response.json({ success: true, user: {
      id: user._id.toString(), nickname: user.nickname, role: user.role,
      sheetRecordRows: (user.sheetRecords ?? []).flatMap((record) => typeof record.rowIndex === 'number' ? [record.rowIndex] : []),
    } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return requestErrorResponse(error, 'Unable to load your session. Please retry.'); }
}
