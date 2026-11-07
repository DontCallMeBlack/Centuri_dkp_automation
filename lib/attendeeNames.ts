export const ATTENDEE_SIMILARITY_THRESHOLD = 0.8;
const MIN_MATCH_LEAD = 0.1;

export interface AttendeeRosterRecord {
  rowIndex: number;
  owner: unknown;
  account: unknown;
  subClass?: string;
}

const safeText = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function normalizeName(value: unknown) {
  const text = safeText(value);
  if (!text) return '';
  return text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
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

/** Bounded Damerau-Levenshtein (optimal string alignment) distance.
 * Only visit the small typo band, and count adjacent swaps as one edit. */
function typoDistance(a: string, b: string, limit: number) {
  let previousPrevious: number[] | undefined;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = Array<number>(b.length + 1).fill(Infinity);
    current[0] = i;
    let minimum = current[0];
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (previousPrevious && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
      }
      minimum = Math.min(minimum, current[j]);
    }
    if (minimum > limit) return limit + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/** Combine spelling edits with cosine evidence, within a length-based typo budget. */
export function toonNameMatchScore(left: string, right: string) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // A one-letter difference is too much evidence to lose in a tiny name.
  if (Math.min(a.length, b.length) < 4) return 0;
  const length = Math.max(a.length, b.length);
  const limit = Math.min(3, Math.floor(length * (1 - ATTENDEE_SIMILARITY_THRESHOLD) + 1e-9));
  if (Math.abs(a.length - b.length) > limit) return 0;
  const distance = typoDistance(a, b, limit);
  if (distance > limit) return 0;
  return Math.max(1 - distance / length, toonNameSimilarity(a, b));
}

export interface AttendeeNameMatches {
  rows: number[];
  matchedCount: number;
  fuzzy: Array<{ input: string; name: string; similarity: number }>;
  unmatched: string[];
  ambiguous: string[];
  remaining: string[];
}

export function matchAttendeeNames(text: string, roster: AttendeeRosterRecord[]): AttendeeNameMatches {
  const result: AttendeeNameMatches = { rows: [], matchedCount: 0, fuzzy: [], unmatched: [], ambiguous: [], remaining: [] };
  const nameOf = (record: AttendeeRosterRecord) => safeText(record.account) || safeText(record.owner);
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
      : roster.map((record) => ({ record, similarity: toonNameMatchScore(input, nameOf(record)) }))
        .filter(({ similarity }) => similarity >= ATTENDEE_SIMILARITY_THRESHOLD)
        .sort((left, right) => right.similarity - left.similarity);
    if (candidates.length === 0) { result.unmatched.push(input); result.remaining.push(input); continue; }
    if (candidates.length > 1 && candidates[0].similarity - candidates[1].similarity < MIN_MATCH_LEAD - 1e-9) {
      result.ambiguous.push(input); result.remaining.push(input); continue;
    }
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
  const matches = (record: T, name: string) =>
    [record.account, record.owner, record.subClass ?? ''].some((value) => normalizeName(value).includes(name)) ||
    toonNameMatchScore(name, safeText(record.account) || safeText(record.owner)) >= ATTENDEE_SIMILARITY_THRESHOLD;
  const fullMatches = roster.filter((record) => matches(record, normalized));
  const names = query.trim().split(/\s+/u).map(normalizeName);
  if (fullMatches.length || names.length === 1) return fullMatches;
  // Retained unresolved names should each show their possible roster matches.
  return roster.filter((record) => names.some((name) => matches(record, name)));
}
