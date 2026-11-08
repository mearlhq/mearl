interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const parseInputParts = (value: string): DateTimeParts | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return null;
  }
  return parts;
};

const getPartsInTimezone = (timestamp: number, timezone: string): DateTimeParts => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  );
  return values as unknown as DateTimeParts;
};

const partsEqual = (left: DateTimeParts, right: DateTimeParts): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second;

const toInputValue = (parts: DateTimeParts): string =>
  `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;

/** 把设置页输入的墙上时间换算为对应时区中的绝对时间。 */
export const parseCustomTime = (value: string, timezone: string): number | null => {
  const desired = parseInputParts(value);
  if (!desired) return null;

  if (!timezone) {
    const timestamp = new Date(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
      desired.second,
    ).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const actual = new Date(timestamp);
    return partsEqual(desired, {
      year: actual.getFullYear(),
      month: actual.getMonth() + 1,
      day: actual.getDate(),
      hour: actual.getHours(),
      minute: actual.getMinutes(),
      second: actual.getSeconds(),
    })
      ? timestamp
      : null;
  }

  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  let timestamp = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = getPartsInTimezone(timestamp, timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    timestamp += desiredUtc - actualAsUtc;
  }
  return partsEqual(getPartsInTimezone(timestamp, timezone), desired) ? timestamp : null;
};

/** 按页面正在模拟的时区回显 datetime-local 输入值。 */
export const formatCustomTime = (timestamp: number, timezone: string): string => {
  if (!Number.isFinite(timestamp)) return '';
  if (timezone) return toInputValue(getPartsInTimezone(timestamp, timezone));
  const date = new Date(timestamp);
  return toInputValue({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  });
};
