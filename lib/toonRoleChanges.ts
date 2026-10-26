import { getAlternateToonSubrole, normalizeAuctionRole } from '@/lib/auctionRules';

/** Fixed Eastern Standard Time (UTC-05:00); this does not shift for daylight saving. */
export const ROLE_CHANGE_TIME_ZONE = 'Etc/GMT+5';
const EST_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface ToonRoleChangeState {
  owner: string;
  account: string;
  currentRole: string;
  updatedByUserId?: unknown;
  scheduledRole?: string;
  effectiveAt?: Date | string;
}

export interface ToonRoleChangeApproval {
  status: string;
  currentRole: string;
  requestedRole: string;
  effectiveAt: Date | string;
  decidedByUserId?: unknown;
  decidedAt?: Date | string;
}

/** Next calendar-month boundary at midnight fixed EST, independent of host TZ. */
export function getNextRoleChangeAt(now = new Date()) {
  const estNow = new Date(now.getTime() - EST_OFFSET_MS);
  const nextMonthMidnightAsUtc = Date.UTC(estNow.getUTCFullYear(), estNow.getUTCMonth() + 1, 1);
  return new Date(nextMonthMidnightAsUtc + EST_OFFSET_MS);
}

export function isApprovedToonRoleSchedule(change?: ToonRoleChangeState | null, approval?: ToonRoleChangeApproval | null) {
  if (!change?.scheduledRole || !change.effectiveAt || !approval) return false;
  const approved = approval.status === 'approved' || approval.status === 'applied';
  const decisionUserId = approval.decidedByUserId ? String(approval.decidedByUserId) : '';
  const scheduleUpdaterId = change.updatedByUserId ? String(change.updatedByUserId) : '';
  return approved && Boolean(decisionUserId) && Boolean(approval.decidedAt) && decisionUserId === scheduleUpdaterId &&
    normalizeAuctionRole(approval.currentRole) === normalizeAuctionRole(change.currentRole) &&
    normalizeAuctionRole(getAlternateToonSubrole(approval.currentRole) ?? '') === normalizeAuctionRole(approval.requestedRole) &&
    normalizeAuctionRole(approval.requestedRole) === normalizeAuctionRole(change.scheduledRole) &&
    new Date(approval.effectiveAt).getTime() === new Date(change.effectiveAt).getTime();
}

export function getEffectiveToonRole(
  sheetRole: string,
  change?: ToonRoleChangeState | null,
  at = new Date(),
  approval?: ToonRoleChangeApproval | null,
) {
  if (isApprovedToonRoleSchedule(change, approval) && change?.scheduledRole && change.effectiveAt &&
    new Date(change.effectiveAt).getTime() <= at.getTime()) {
    return change.scheduledRole;
  }
  return sheetRole;
}

