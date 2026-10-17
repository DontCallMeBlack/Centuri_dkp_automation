import { getSheetRecordKey, type SheetRecordIdentity } from '../sheetRecordLinks.ts';

export interface ReservationSubject {
  identities: SheetRecordIdentity[];
  rows?: number[];
  /** Old account links that granted access to every toon under an owner. */
  legacyOwners?: string[];
  /** Retained identities are unaffected when narrowing an old owner-wide link. */
  ignoredIdentities?: SheetRecordIdentity[];
  /** An unidentified hold could belong to a moved, currently unassigned toon. */
  rejectUnverifiedLegacyHolds?: boolean;
}

export interface ProtectedHold {
  rowIndex: number;
  heldPoints: number;
  owner?: string;
  account?: string;
}

interface ProtectedBid { rowIndex?: number; owner?: string; account?: string }
export interface ProtectedAuction {
  status: string;
  deliveryStatus?: string;
  highBid?: ProtectedBid;
  winner?: ProtectedBid;
}

export function getChangedLinkIdentities(current: SheetRecordIdentity[], selected: SheetRecordIdentity[]) {
  const currentKeys = new Set(current.map(getSheetRecordKey));
  const selectedKeys = new Set(selected.map(getSheetRecordKey));
  return {
    removed: current.filter((record) => !selectedKeys.has(getSheetRecordKey(record))),
    added: selected.filter((record) => !currentKeys.has(getSheetRecordKey(record))),
  };
}

/** Match both identities and their old/current physical rows. Unknown legacy
 * ownership fails closed when granting access to a newly linked toon. */
export function getReservationConflict(
  subject: ReservationSubject,
  holds: ProtectedHold[],
  auctions: ProtectedAuction[],
): 'reserved-toon' | 'unverified-legacy-hold' | null {
  const keys = new Set(subject.identities.map(getSheetRecordKey));
  const ignored = new Set((subject.ignoredIdentities ?? []).map(getSheetRecordKey));
  const rows = new Set([
    ...(subject.rows ?? []),
    ...subject.identities.flatMap((record) => record.rowIndex === undefined ? [] : [record.rowIndex]),
  ]);
  const normalize = (value: string) => value.trim().toLowerCase();
  const owners = new Set((subject.legacyOwners ?? []).map(normalize).filter(Boolean));
  const identityOwners = new Set(subject.identities.map((record) => normalize(record.owner)));
  const matches = (record: ProtectedBid) => {
    if (typeof record.owner === 'string' && typeof record.account === 'string' && ignored.has(getSheetRecordKey({ owner: record.owner, account: record.account }))) return false;
    if (record.rowIndex !== undefined && rows.has(record.rowIndex)) return true;
    if (typeof record.owner !== 'string') return false;
    if (owners.has(normalize(record.owner))) return true;
    if (typeof record.account !== 'string') return identityOwners.has(normalize(record.owner));
    return keys.has(getSheetRecordKey({ owner: record.owner, account: record.account }));
  };
  for (const hold of holds) {
    if (hold.heldPoints === 0) continue;
    if (matches(hold)) return 'reserved-toon';
    if (subject.rejectUnverifiedLegacyHolds && (typeof hold.owner !== 'string' || !hold.owner.trim() || typeof hold.account !== 'string')) {
      return 'unverified-legacy-hold';
    }
  }
  for (const auction of auctions) {
    if (['active', 'settling', 'settlement-failed', 'removing'].includes(auction.status) && auction.highBid && matches(auction.highBid)) {
      return 'reserved-toon';
    }
    if (auction.status === 'completed' && auction.deliveryStatus === 'pending' && auction.winner && matches(auction.winner)) {
      return 'reserved-toon';
    }
  }
  return null;
}
