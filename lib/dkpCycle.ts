const DKP_TIME_ZONE = 'America/New_York';

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
