/** Fixed Eastern Standard Time (UTC-05:00); this does not shift for daylight saving. */
export const ROLE_CHANGE_TIME_ZONE = 'Etc/GMT+5';
const EST_OFFSET_MS = 5 * 60 * 60 * 1000;

export interface ToonRoleChangeState {
  owner: string;
  account: string;
  currentRole: string;
  scheduledRole?: string;
  effectiveAt?: Date | string;
}

/** Next calendar-month boundary at midnight fixed EST, independent of host TZ. */
export function getNextRoleChangeAt(now = new Date()) {
  const estNow = new Date(now.getTime() - EST_OFFSET_MS);
  const nextMonthMidnightAsUtc = Date.UTC(estNow.getUTCFullYear(), estNow.getUTCMonth() + 1, 1);
  return new Date(nextMonthMidnightAsUtc + EST_OFFSET_MS);
}

export function getEffectiveToonRole(sheetRole: string, change?: ToonRoleChangeState | null, at = new Date()) {
  if (!change) return sheetRole;
  if (change.scheduledRole && change.effectiveAt && new Date(change.effectiveAt).getTime() <= at.getTime()) {
    return change.scheduledRole;
  }
  return change.currentRole || sheetRole;
}

