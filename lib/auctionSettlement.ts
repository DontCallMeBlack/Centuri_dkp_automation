export type SettlementStatus = 'active' | 'settling' | 'settlement-failed' | 'completed' | 'removing';

export function needsSettlementManualReview(input: {
  status: SettlementStatus;
  settlementAttemptId?: string;
  settlementDkpApplied?: boolean;
}) {
  return (input.status === 'settling' || input.status === 'settlement-failed') &&
    !input.settlementAttemptId &&
    !input.settlementDkpApplied;
}

export function isSettlementLeaseExpired(status: SettlementStatus, leaseUntil: Date | undefined, now: Date) {
  return status === 'settling' && (!leaseUntil || leaseUntil.getTime() <= now.getTime());
}

export function getAuctionSettlementMutationKey(auctionId: string) {
  return `auction-settlement:${auctionId}`;
}

export function canRetryAuctionSettlement(role: string, input: Parameters<typeof needsSettlementManualReview>[0]) {
  return (role === 'chief' || role === 'general') && input.status === 'settlement-failed' &&
    !needsSettlementManualReview(input);
}
