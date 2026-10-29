export const BOSS_DKP_POINTS: Record<string, number> = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

export const BOSS_ATTENDANCE_REMOVAL_REASONS = [
  'underperforming',
  'afk',
  'not helping with boss mechanics',
  "didn't attend",
  'other',
] as const;

export type BossAttendanceRemovalReason = (typeof BOSS_ATTENDANCE_REMOVAL_REASONS)[number];

export function isBossAttendanceRemovalReason(value: unknown): value is BossAttendanceRemovalReason {
  return typeof value === 'string' &&
    (BOSS_ATTENDANCE_REMOVAL_REASONS as readonly string[]).includes(value);
}

export function isRosterRowArray(value: unknown, allowEmpty = false): value is number[] {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((rowIndex): rowIndex is number =>
      typeof rowIndex === 'number' && Number.isInteger(rowIndex) && rowIndex >= 3 && rowIndex <= 1000
    ) &&
    new Set(value).size === value.length;
}

export function isDkpRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getBossRequestFingerprint(kind: string, bossName: string, selectedRows: number[]) {
  return JSON.stringify([kind, bossName, [...selectedRows].sort((a, b) => a - b)]);
}
