import { revokeSession } from '@/lib/auth/session';
import { guardMutationRequest, requestErrorResponse } from '@/lib/security/request';

export async function POST(request: Request) {
  const denied = guardMutationRequest(request);
  if (denied) return denied;
  try {
    await revokeSession();
    return Response.json({ success: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return requestErrorResponse(error, 'Unable to sign out. Please retry.'); }
}
