export const BOSS_DKP_POINTS: Record<string, number> = {
  Base: 1,
  Prime: 2,
  Bt: 5,
  Gele: 6,
  Dino: 7,
  Crom: 12,
};

export function isRosterRowArray(value: unknown, allowEmpty = false): value is number[] {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((rowIndex): rowIndex is number =>
      typeof rowIndex === 'number' && Number.isInteger(rowIndex)
    ) &&
    new Set(value).size === value.length;
}
