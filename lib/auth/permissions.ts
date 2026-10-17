export const CLAN_ROLES = ['chief', 'general', 'guardian', 'clansman'] as const;
export type ClanRole = (typeof CLAN_ROLES)[number];
export function isClanRole(value: unknown): value is ClanRole { return typeof value === 'string' && (CLAN_ROLES as readonly string[]).includes(value); }
export function canChangeMemberRole(actorRole: string, targetRole: string, nextRole: string, isSelf: boolean, chiefCount: number) {
  if (isSelf || !isClanRole(targetRole) || !isClanRole(nextRole) || targetRole === nextRole) return false;
  if (actorRole !== 'chief' && !(actorRole === 'general' && ['guardian', 'clansman'].includes(targetRole) && ['guardian', 'clansman'].includes(nextRole))) return false;
  return targetRole !== 'chief' || nextRole === 'chief' || chiefCount > 1;
}
export function validRosterRows(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 998 &&
    value.every((row) => typeof row === 'number' && Number.isInteger(row) && row >= 3 && row <= 1000) && new Set(value).size === value.length;
}
