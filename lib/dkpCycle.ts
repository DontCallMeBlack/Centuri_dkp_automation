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

export function getDkpCycleRange(now = new Date()) {
  const localParts = getZonedParts(now);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: DKP_TIME_ZONE,
    weekday: 'short',
  }).format(now);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (weekdayIndex < 0) throw new Error('Unable to determine weekday for DKP cycle');

  const daysSinceSaturday = (weekdayIndex + 1) % 7;
  const currentLocalDate = new Date(Date.UTC(
    localParts.year,
    localParts.month - 1,
    localParts.day - daysSinceSaturday,
  ));
  const nextLocalDate = new Date(currentLocalDate.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    start: zonedMidnightToUtc(
      currentLocalDate.getUTCFullYear(),
      currentLocalDate.getUTCMonth() + 1,
      currentLocalDate.getUTCDate(),
    ),
    end: zonedMidnightToUtc(
      nextLocalDate.getUTCFullYear(),
      nextLocalDate.getUTCMonth() + 1,
      nextLocalDate.getUTCDate(),
    ),
  };
}
