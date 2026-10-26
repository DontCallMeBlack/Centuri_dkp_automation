export type DkpAdjustmentMode = 'balance' | 'available' | 'weekly-earned' | 'auction-spend';

export interface DkpAdjustmentInput {
  rowIndex: number;
  points: number;
  mode: DkpAdjustmentMode;
  row: string[] | undefined;
  owner?: string;
  account?: string;
  heldPoints?: number;
  reservedPointsToConsume?: number;
  sheetName: string;
}

/** Safe to show to a manager; the operation has stopped rather than guessing. */
export class DkpIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DkpIntegrityError';
  }
}

export function readDkpCell(value: unknown, column: string, rowIndex: number) {
  const text = String(value ?? '').trim().replace(/^\u2212/, '-');
  if (text === '' || /^[-\u2013\u2014]$/.test(text)) return 0;
  const normalized = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text;
  const parsed = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    throw new DkpIntegrityError(`DKP cell ${column}${rowIndex} is not numeric or exceeds the safe numeric range. Correct this cell in Google Sheets before retrying.`);
  }
  return parsed;
}

function readCell(row: string[], index: number, column: string, rowIndex: number) {
  return readDkpCell(row[index], column, rowIndex);
}

function adjustedCell(row: string[], index: number, column: string, rowIndex: number, points: number) {
  const next = readCell(row, index, column, rowIndex) + points;
  if (!Number.isFinite(next) || Math.abs(next) > Number.MAX_SAFE_INTEGER) {
    throw new DkpIntegrityError(`Cannot adjust DKP: ${column}${rowIndex} would exceed the safe numeric range.`);
  }
  return next;
}

export function buildDkpAdjustmentUpdates(input: DkpAdjustmentInput) {
  const { rowIndex, points, mode, row, owner, account, sheetName } = input;
  if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
    throw new DkpIntegrityError(`Invalid Google Sheets roster row: ${rowIndex}`);
  }
  if (!Number.isFinite(points) || Math.abs(points) > Number.MAX_SAFE_INTEGER) {
    throw new DkpIntegrityError('DKP adjustment must be a finite number within the safe numeric range.');
  }
  if (!['balance', 'available', 'weekly-earned', 'auction-spend'].includes(mode)) throw new DkpIntegrityError('Unknown DKP adjustment mode.');
  if (!row || !row[0]) throw new DkpIntegrityError(`Google Sheets roster row ${rowIndex} could not be read.`);
  if (
    (owner !== undefined && row[0].trim().toLowerCase() !== owner.trim().toLowerCase()) ||
    (account !== undefined && (row[1] || '').trim().toLowerCase() !== account.trim().toLowerCase())
  ) {
    throw new DkpIntegrityError(`Google Sheets roster row ${rowIndex} changed; reload the roster and retry.`);
  }

  if (points < 0 && mode !== 'weekly-earned') {
    const heldPoints = input.heldPoints ?? 0;
    const reservedPointsToConsume = input.reservedPointsToConsume ?? 0;
    if (
      !Number.isFinite(heldPoints) || heldPoints < 0 ||
      !Number.isFinite(reservedPointsToConsume) || reservedPointsToConsume < 0 ||
      reservedPointsToConsume > heldPoints ||
      readCell(row, 7, 'H', rowIndex) + points < heldPoints - reservedPointsToConsume
    ) {
      throw new DkpIntegrityError(`Cannot reduce DKP for row ${rowIndex} below its ${heldPoints} held auction points.`);
    }
  }

  if (mode === 'weekly-earned') {
    return [
      { range: `${sheetName}!D${rowIndex}`, values: [[adjustedCell(row, 3, 'D', rowIndex, points)]] },
      { range: `${sheetName}!I${rowIndex}`, values: [[adjustedCell(row, 8, 'I', rowIndex, points)]] },
    ];
  }
  if (mode === 'auction-spend') {
    if (points > 0) throw new DkpIntegrityError('Auction spending adjustments must not add DKP.');
    return [
      { range: `${sheetName}!E${rowIndex}`, values: [[adjustedCell(row, 4, 'E', rowIndex, -points)]] },
      { range: `${sheetName}!G${rowIndex}`, values: [[adjustedCell(row, 6, 'G', rowIndex, -points)]] },
      { range: `${sheetName}!H${rowIndex}`, values: [[adjustedCell(row, 7, 'H', rowIndex, points)]] },
    ];
  }
  if (mode === 'available') return [
    { range: `${sheetName}!H${rowIndex}`, values: [[adjustedCell(row, 7, 'H', rowIndex, points)]] },
  ];
  return [
    { range: `${sheetName}!F${rowIndex}`, values: [[adjustedCell(row, 5, 'F', rowIndex, points)]] },
    { range: `${sheetName}!H${rowIndex}`, values: [[adjustedCell(row, 7, 'H', rowIndex, points)]] },
  ];
}

export function canAffordBid(amount: number, heldPoints: number, available: number) {
  return Number.isSafeInteger(amount) && amount > 0 &&
    Number.isFinite(heldPoints) && heldPoints >= 0 && heldPoints <= Number.MAX_SAFE_INTEGER &&
    Number.isFinite(available) && available >= 0 && available <= Number.MAX_SAFE_INTEGER &&
    amount + heldPoints <= Number.MAX_SAFE_INTEGER && amount + heldPoints <= available;
}

export interface DkpCellSnapshot { range: string; values: number[][] }

/** An interrupted absolute write is replayable only from its recorded before/after state. */
export function getDkpReplayState(
  before: DkpCellSnapshot[],
  after: DkpCellSnapshot[],
  rows: string[][],
) {
  if (before.length !== after.length) throw new DkpIntegrityError('Incomplete DKP recovery record; a manager must review the sheet.');
  let allBefore = true;
  let allAfter = true;
  for (let index = 0; index < after.length; index += 1) {
    const update = after[index];
    const match = /!([D-I])(\d+)$/.exec(update.range);
    if (!match || before[index].range !== update.range) throw new DkpIntegrityError('Invalid DKP recovery record; a manager must review the sheet.');
    const rowIndex = Number(match[2]);
    const actual = readCell(rows[rowIndex - 3] ?? [], match[1].charCodeAt(0) - 65, match[1], rowIndex);
    const previous = before[index].values[0]?.[0];
    const next = update.values[0]?.[0];
    if (![previous, next].every((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)) {
      throw new DkpIntegrityError('Unsafe DKP recovery values; a manager must review the sheet.');
    }
    allBefore &&= actual === previous;
    allAfter &&= actual === next;
  }
  if (allAfter) return 'applied';
  if (allBefore) return 'pending';
  throw new DkpIntegrityError('Sheet balances changed during an interrupted DKP operation. A manager must reconcile it before more points can be changed.');
}

export function snapshotDkpCells(updates: DkpCellSnapshot[], rows: string[][]): DkpCellSnapshot[] {
  return updates.map(({ range }) => {
    const match = /!([D-I])(\d+)$/.exec(range);
    if (!match) throw new DkpIntegrityError('Invalid DKP sheet range.');
    const rowIndex = Number(match[2]);
    return { range, values: [[readCell(rows[rowIndex - 3] ?? [], match[1].charCodeAt(0) - 65, match[1], rowIndex)]] };
  });
}

