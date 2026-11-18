export const DG_PIECES = [
  { key: 'gloves', label: 'Gloves', pures: 1 },
  { key: 'boots', label: 'Boots', pures: 2 },
  { key: 'helm', label: 'Helm', pures: 3 },
  { key: 'pants', label: 'Pants', pures: 4 },
  { key: 'top', label: 'Top', pures: 5 },
] as const;

export type DgPiece = (typeof DG_PIECES)[number]['key'];

export function parseExcludedDgPieces(value: unknown): DgPiece[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const validPieces = new Set<string>(DG_PIECES.map((piece) => piece.key));
  if (value.some((piece) => typeof piece !== 'string' || !validPieces.has(piece)) || new Set(value).size !== value.length) return null;
  return value as DgPiece[];
}

export function dgPuresNeeded(excludedPieces: readonly DgPiece[] = []): number {
  const excluded = new Set(excludedPieces);
  return DG_PIECES.reduce((total, piece) => total + (excluded.has(piece.key) ? 0 : piece.pures), 0);
}

export function normalizedDgScore(dkp: number, excludedPieces: readonly DgPiece[] = []): number | null {
  const puresNeeded = dgPuresNeeded(excludedPieces);
  if (!Number.isFinite(dkp) || puresNeeded < 1) return null;
  return Math.ceil(dkp * 15 / puresNeeded);
}
