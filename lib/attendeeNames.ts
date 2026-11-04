export const ATTENDEE_SIMILARITY_THRESHOLD = 0.8;

export interface AttendeeRosterRecord {
  rowIndex: number;
  owner: string;
  account: string;
  subClass?: string;
}

function normalizeName(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

/** Cosine similarity of character-bigram counts; character order and digits matter. */
export function toonNameSimilarity(left: string, right: string) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (value: string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const gram = value.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  };
  const first = bigrams(a);
  const second = bigrams(b);
  let dot = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (const [gram, count] of first) {
    dot += count * (second.get(gram) ?? 0);
    firstNorm += count * count;
  }
  for (const count of second.values()) secondNorm += count * count;
  return Math.min(1, dot / Math.sqrt(firstNorm * secondNorm));
}

export interface AttendeeNameMatches {
  rows: number[];
  matchedCount: number;
  fuzzy: Array<{ input: string; name: string; similarity: number }>;
  unmatched: string[];
  ambiguous: string[];
}

export function matchAttendeeNames(text: string, roster: AttendeeRosterRecord[]): AttendeeNameMatches {
  const result: AttendeeNameMatches = { rows: [], matchedCount: 0, fuzzy: [], unmatched: [], ambiguous: [] };
  const nameOf = (record: AttendeeRosterRecord) => record.account.trim() || record.owner.trim();
  // Preserve an exact toon name containing spaces when pasted on its own.
  const fullName = normalizeName(text);
  const inputs = roster.some((record) => normalizeName(nameOf(record)) === fullName)
    ? [text.trim()]
    : text.trim().split(/\s+/u).filter(Boolean);
  const seenNames = new Set<string>();
  const rows = new Set<number>();
  for (const input of inputs) {
    const key = normalizeName(input);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    const exact = roster.filter((record) => normalizeName(nameOf(record)) === key);
    const candidates = exact.length ? exact.map((record) => ({ record, similarity: 1 }))
      : roster.map((record) => ({ record, similarity: toonNameSimilarity(input, nameOf(record)) }))
        .filter(({ similarity }) => similarity >= ATTENDEE_SIMILARITY_THRESHOLD);
    if (candidates.length === 0) { result.unmatched.push(input); continue; }
    if (candidates.length > 1) { result.ambiguous.push(input); continue; }
    const { record, similarity } = candidates[0];
    rows.add(record.rowIndex);
    result.matchedCount += 1;
    if (!exact.length) result.fuzzy.push({ input, name: nameOf(record), similarity });
  }
  result.rows = [...rows];
  return result;
}

export function filterAttendeeRoster<T extends AttendeeRosterRecord>(roster: T[], query: string): T[] {
  const normalized = normalizeName(query);
  if (!normalized) return roster;
  return roster.filter((record) =>
    [record.account, record.owner, record.subClass ?? ''].some((value) => normalizeName(value).includes(normalized)) ||
    toonNameSimilarity(normalized, record.account.trim() || record.owner) >= ATTENDEE_SIMILARITY_THRESHOLD);
}
