const DKP_TIME_ZONE = 'America/New_York';

export interface WeeklyDkpRosterRow {
  rowIndex: number;
  owner: string;
  account: string;
  weeklyEarned: number;
  earned: number;
  available: number;
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
) {
  const nextHistory = roster.map((record) => {
    const matches = previousHistory.filter((entry) => identityKey(entry) === identityKey(record));
    const prior = matches.find((entry) => entry.rowIndex === record.rowIndex)
      ?? (matches.length === 1 ? matches[0] : undefined);
    // If I already had a value before history tracking was introduced, keep it
    // as one legacy bucket. It will age out after five Sunday rollovers.
    const existingWeeks = prior?.weeks ?? (record.fiveWeekActivity === 0 ? [] : [record.fiveWeekActivity]);
    const weeks = [...existingWeeks, record.weeklyEarned].slice(-5);
    return { rowIndex: record.rowIndex, owner: record.owner, account: record.account, weeks };
  });
  const historyByRow = new Map(nextHistory.map((entry) => [entry.rowIndex, entry]));
  const updates = roster.flatMap((record) => {
    const history = historyByRow.get(record.rowIndex)!;
    return [
      { range: `${sheetName}!D${record.rowIndex}`, values: [[0]] },
      { range: `${sheetName}!E${record.rowIndex}`, values: [[0]] },
      ...(record.weeklyEarned === 0 ? [] : [
        { range: `${sheetName}!F${record.rowIndex}`, values: [[record.earned + record.weeklyEarned]] },
        { range: `${sheetName}!H${record.rowIndex}`, values: [[record.available + record.weeklyEarned]] },
      ]),
      { range: `${sheetName}!I${record.rowIndex}`, values: [[history.weeks.reduce((sum, points) => sum + points, 0)]] },
    ];
  });
  return { updates, weeklyActivityHistory: nextHistory };
}

export function initializeWeeklyDkpActivityHistory(roster: WeeklyDkpRosterRow[]): WeeklyDkpActivityHistory[] {
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
