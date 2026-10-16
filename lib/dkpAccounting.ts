export type DkpAdjustmentMode = 'balance' | 'weekly-earned' | 'auction-spend';

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

function readCell(row: string[], index: number, column: string, rowIndex: number) {
  const value = row[index];
  if (value === undefined || value === '' || value === '-') return 0;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(parsed)) throw new Error(`Cannot adjust DKP: ${column}${rowIndex} is not numeric.`);
  return parsed;
}

export function buildDkpAdjustmentUpdates(input: DkpAdjustmentInput) {
  const { rowIndex, points, mode, row, owner, account, sheetName } = input;
  if (!Number.isInteger(rowIndex) || rowIndex < 3 || rowIndex > 1000) {
    throw new Error(`Invalid Google Sheets roster row: ${rowIndex}`);
  }
  if (!Number.isFinite(points)) throw new Error('DKP adjustment must be a finite number.');
  if (!row || !row[0]) throw new Error(`Google Sheets roster row ${rowIndex} could not be read.`);
  if (
    (owner !== undefined && row[0].trim().toLowerCase() !== owner.trim().toLowerCase()) ||
    (account !== undefined && (row[1] || '').trim().toLowerCase() !== account.trim().toLowerCase())
  ) {
    throw new Error(`Google Sheets roster row ${rowIndex} changed; reload the roster and retry.`);
  }

  if (points < 0 && mode !== 'weekly-earned') {
    const heldPoints = input.heldPoints ?? 0;
    const reservedPointsToConsume = input.reservedPointsToConsume ?? 0;
    if (
      reservedPointsToConsume < 0 ||
      reservedPointsToConsume > heldPoints ||
      readCell(row, 7, 'H', rowIndex) + points < heldPoints - reservedPointsToConsume
    ) {
      throw new Error(`Cannot reduce DKP for row ${rowIndex} below its ${heldPoints} held auction points.`);
    }
  }

  if (mode === 'weekly-earned') {
    return [
      { range: `${sheetName}!D${rowIndex}`, values: [[readCell(row, 3, 'D', rowIndex) + points]] },
      { range: `${sheetName}!I${rowIndex}`, values: [[readCell(row, 8, 'I', rowIndex) + points]] },
    ];
  }
  if (mode === 'auction-spend') {
    if (points > 0) throw new Error('Auction spending adjustments must not add DKP.');
    return [
      { range: `${sheetName}!E${rowIndex}`, values: [[readCell(row, 4, 'E', rowIndex) - points]] },
      { range: `${sheetName}!G${rowIndex}`, values: [[readCell(row, 6, 'G', rowIndex) - points]] },
      { range: `${sheetName}!H${rowIndex}`, values: [[readCell(row, 7, 'H', rowIndex) + points]] },
    ];
  }
  return [
    { range: `${sheetName}!F${rowIndex}`, values: [[readCell(row, 5, 'F', rowIndex) + points]] },
    { range: `${sheetName}!H${rowIndex}`, values: [[readCell(row, 7, 'H', rowIndex) + points]] },
  ];
}

export function canAffordBid(amount: number, heldPoints: number, available: number) {
  return Number.isSafeInteger(amount) && amount > 0 && heldPoints >= 0 && available >= 0 && amount + heldPoints <= available;
}

