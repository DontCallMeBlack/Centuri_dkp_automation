import { DkpIntegrityError } from './dkpAccounting.ts';

const DKP_TIME_ZONE = 'America/New_York';

export interface WeeklyDkpRosterRow {
  rowIndex: number;
  owner: string;
  account: string;
  weeklyEarned: number;
  earned: number | null;
  available: number | null;
  fiveWeekActivity: number;
}

export interface WeeklyDkpActivityHistory {
  rowIndex: number;
  owner: string;
  account: string;
  weeks: number[];
}

function identityKey(record: { owner: string; account: string }) {
  return JSON.stringify([record.owner.trim().toLowerCase(), record.account.trim().toLowerCase()]);
}

export function buildWeeklyDkpResetPlan(
  roster: WeeklyDkpRosterRow[],
  sheetName: string,
  previousHistory: WeeklyDkpActivityHistory[] = [],
  elapsedWeeks = 1,
) {
  if (!Number.isSafeInteger(elapsedWeeks) || elapsedWeeks < 1) throw new Error('Invalid elapsed DKP weeks.');
  const nextHistory = roster.map((record) => {
    const matches = previousHistory.filter((entry) => identityKey(entry) === identityKey(record));
    const prior = matches.find((entry) => entry.rowIndex === record.rowIndex)
      ?? (matches.length === 1 ? matches[0] : undefined);
    // If I already had a value before history tracking was introduced, keep it
    // as one legacy bucket. It will age out after five Sunday rollovers.
    const existingWeeks = prior?.weeks ?? (record.fiveWeekActivity === 0 ? [] : [record.fiveWeekActivity]);
    const weeks = elapsedWeeks > 5
      ? [0, 0, 0, 0, 0]
      : [...existingWeeks, record.weeklyEarned, ...Array(elapsedWeeks - 1).fill(0)].slice(-5);
    return { rowIndex: record.rowIndex, owner: record.owner, account: record.account, weeks };
  });
  const historyByRow = new Map(nextHistory.map((entry) => [entry.rowIndex, entry]));
  const updates = roster.flatMap((record) => {
    const history = historyByRow.get(record.rowIndex)!;
    if (record.weeklyEarned !== 0 && (record.earned === null || record.available === null)) {
      throw new DkpIntegrityError(`Weekly rollover needs valid earned and available DKP in F${record.rowIndex} and H${record.rowIndex}. Correct this toon’s balances first.`);
    }
    return [
      { range: `${sheetName}!D${record.rowIndex}`, values: [[0]] },
      { range: `${sheetName}!E${record.rowIndex}`, values: [[0]] },
      { range: `${sheetName}!I${record.rowIndex}`, values: [[history.weeks.reduce((sum, points) => sum + points, 0)]] },
      ...(record.weeklyEarned === 0 ? [] : [
        { range: `${sheetName}!F${record.rowIndex}`, values: [[record.earned! + record.weeklyEarned]] },
        { range: `${sheetName}!H${record.rowIndex}`, values: [[record.available! + record.weeklyEarned]] },
      ]),
    ];
  });
  return { updates, weeklyActivityHistory: nextHistory };
}

export function initializeWeeklyDkpActivityHistory(roster: Pick<WeeklyDkpRosterRow, 'rowIndex' | 'owner' | 'account' | 'fiveWeekActivity'>[]): WeeklyDkpActivityHistory[] {
  return roster.map((record) => ({
    rowIndex: record.rowIndex,
    owner: record.owner,
    account: record.account,
    weeks: record.fiveWeekActivity === 0 ? [] : [record.fiveWeekActivity],
  }));
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DKP_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

function getZonedParts(date: Date) {
  const parts = dateTimeFormatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`Missing ${type} while calculating DKP cycle`);
    return Number(value);
  };

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second'),
  };
}

function zonedMidnightToUtc(year: number, month: number, day: number) {
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let timestamp = localMidnightAsUtc;

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const localParts = getZonedParts(new Date(timestamp));
    const representedAsUtc = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second,
    );
    timestamp = localMidnightAsUtc - (representedAsUtc - timestamp);
  }

  return new Date(timestamp);
}

export function getPreviousDkpWeekRange(now = new Date()) {
  const localParts = getZonedParts(now);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: DKP_TIME_ZONE,
    weekday: 'short',
  }).format(now);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (weekdayIndex < 0) throw new Error('Unable to determine weekday for DKP activity period');

  const daysSinceSunday = weekdayIndex;
  const currentWeekStartLocalDate = new Date(Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day - daysSinceSunday,
  ));
  const previousWeekStartLocalDate = new Date(
    currentWeekStartLocalDate.getTime() - 7 * 24 * 60 * 60 * 1000,
  );

  return {
    start: zonedMidnightToUtc(
      previousWeekStartLocalDate.getUTCFullYear(),
      previousWeekStartLocalDate.getUTCMonth() + 1,
      previousWeekStartLocalDate.getUTCDate(),
    ),
    end: zonedMidnightToUtc(
      currentWeekStartLocalDate.getUTCFullYear(),
      currentWeekStartLocalDate.getUTCMonth() + 1,
      currentWeekStartLocalDate.getUTCDate(),
    ),
  };
}

export function getCurrentDkpWeekStart(now = new Date()) {
  const localParts = getZonedParts(now);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: DKP_TIME_ZONE,
    weekday: 'short',
  }).format(now);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (weekdayIndex < 0) throw new Error('Unable to determine weekday for DKP activity period');

  const currentWeekStartLocalDate = new Date(Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day - weekdayIndex,
  ));

  return zonedMidnightToUtc(
    currentWeekStartLocalDate.getUTCFullYear(),
    currentWeekStartLocalDate.getUTCMonth() + 1,
    currentWeekStartLocalDate.getUTCDate(),
  );
}

export function getNextDkpWeekStart(now = new Date()) {
  const currentWeekStart = getCurrentDkpWeekStart(now);
  const localParts = getZonedParts(currentWeekStart);
  const nextWeekLocalDate = new Date(Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day + 7,
  ));

  return zonedMidnightToUtc(
    nextWeekLocalDate.getUTCFullYear(),
    nextWeekLocalDate.getUTCMonth() + 1,
    nextWeekLocalDate.getUTCDate(),
  );
}

/** Calendar weeks, including 167/169-hour weeks at daylight saving changes. */
export function getDkpElapsedWeeks(start: Date, end: Date) {
  const first = getZonedParts(getCurrentDkpWeekStart(start));
  const last = getZonedParts(getCurrentDkpWeekStart(end));
  return Math.round((Date.UTC(last.year, last.month - 1, last.day) - Date.UTC(first.year, first.month - 1, first.day)) / (7 * 86_400_000));
}

/** Correct the completed week's bucket when attendance is edited after rollover. */
export function buildHistoricalDkpActivityCorrection(
  roster: Array<{ rowIndex: number; owner: string; account: string; fiveWeekActivity: number | null }>,
  history: WeeklyDkpActivityHistory[],
  adjustments: Array<{ rowIndex: number; points: number }>,
  earnedAt: Date,
  now: Date,
  sheetName: string,
) {
  const offset = getDkpElapsedWeeks(earnedAt, now);
  if (offset < 1 || offset > 5) return { updates: [], weeklyActivityHistory: history };
  const nextHistory = history.map((entry) => ({ ...entry, weeks: [...entry.weeks] }));
  const updates = adjustments.map(({ rowIndex, points }) => {
    const record = roster.find((entry) => entry.rowIndex === rowIndex);
    if (!record) throw new Error('Roster changed while correcting historical DKP activity.');
    if (record.fiveWeekActivity === null) throw new DkpIntegrityError(`DKP cell I${rowIndex} must be corrected before changing this toon’s historical attendance.`);
    const matches = nextHistory.filter((entry) => identityKey(entry) === identityKey(record));
    let entry = matches.find((candidate) => candidate.rowIndex === rowIndex) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!entry) {
      entry = { rowIndex, owner: record.owner, account: record.account, weeks: [] };
      nextHistory.push(entry);
    }
    // Preserve an existing legacy total in its latest known bucket. Earlier
    // missing buckets are zero until a correction gives them a known value.
    while (entry.weeks.length < offset) entry.weeks.unshift(0);
    entry.weeks[entry.weeks.length - offset] += points;
    return { range: `${sheetName}!I${rowIndex}`, values: [[record.fiveWeekActivity + points]] };
  });
  return { updates, weeklyActivityHistory: nextHistory };
}
