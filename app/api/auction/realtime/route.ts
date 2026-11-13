import { getSessionUser } from '@/lib/auth/session';
import { limitMemberRequests } from '@/lib/auth/rateLimit';
import { createAuctionSubscription } from '@/lib/auctionRealtime';
import { guardMutationRequest, requestErrorResponse } from '@/lib/security/request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const guard = guardMutationRequest(request);
  if (guard) return guard;
  try {
    const user = await getSessionUser();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    await limitMemberRequests(user._id.toString(), 'auction-read');
    const subscription = createAuctionSubscription(user._id.toString());
    return Response.json(subscription ?? { enabled: false }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) { return requestErrorResponse(error, 'Unable to connect live auction updates.'); }
}
