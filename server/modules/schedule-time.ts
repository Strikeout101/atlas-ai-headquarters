/**
 * Time-of-day schedules: a 5-field cron rule (minute hour day-of-month month day-of-week) in an IANA time zone.
 * Supported: `*`, numbers, lists (1,3,5), ranges (1-5) and steps (*\/15, 8-18/2). Day names and month names are not
 * accepted, and anything that cannot be read exactly is refused rather than guessed.
 *
 * Like standard cron, when both day-of-month and day-of-week are restricted, a day matching either one runs.
 * Daylight-saving rules: a time that does not exist (spring forward) runs at the first real minute after it; a time that
 * happens twice (fall back) runs once, the first time.
 */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day_of_month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day_of_week", min: 0, max: 7 },
] as const;

export interface CronRule {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayWildcard: boolean;
  weekdayWildcard: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseField(text: string, field: (typeof FIELDS)[number]): { values: number[]; wildcard: boolean } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = part.match(/^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/);
    if (!match) fail(`invalid_schedule_${field.name}`);
    const step = match[2] ? Number(match[2]) : 1;
    if (step < 1) fail(`invalid_schedule_${field.name}`);
    let from: number = field.min;
    let to: number = field.max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(Number);
      from = a;
      to = b ?? (match[2] ? field.max : a);
    }
    if (from < field.min || to > field.max || from > to) fail(`invalid_schedule_${field.name}`);
    for (let value = from; value <= to; value += step)
      values.add(field.name === "day_of_week" && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((x, y) => x - y), wildcard: text === "*" };
}

export function parseCron(expression: unknown): CronRule {
  if (typeof expression !== "string") fail("invalid_schedule_cron");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) fail("invalid_schedule_cron");
  const [minute, hour, day, month, weekday] = parts.map((part, i) => parseField(part, FIELDS[i]));
  return {
    minutes: minute.values,
    hours: hour.values,
    days: new Set(day.values),
    months: new Set(month.values),
    weekdays: new Set(weekday.values),
    dayWildcard: day.wildcard,
    weekdayWildcard: weekday.wildcard,
  };
}

export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(zone, formatter);
  }
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) map[part.type] = part.value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: weekdays.indexOf(map.weekday),
  };
}

/** The UTC instant of a local wall-clock time; for a time that happens twice, the first one. */
function localToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const candidates: number[] = [];
  for (const offsetHours of [-14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14]) {
    // Search near the naive time for an instant whose local reading is exactly the wanted wall-clock time.
    const guess = naive - offsetHours * 3_600_000;
    for (const delta of [-3_600_000, -1_800_000, 0, 1_800_000, 3_600_000]) {
      const at = guess + delta;
      const p = parts(at, zone);
      if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute)
        candidates.push(at);
    }
  }
  if (candidates.length) return Math.min(...candidates);
  return Number.NaN; // the time does not exist that day (spring forward)
}

/**
 * The first run strictly after `after`. Looks up to 400 days ahead; a rule that never matches (31 February) fails.
 */
export function nextCronRun(expression: string, zone: string, after: number): number {
  if (!validTimeZone(zone)) fail("invalid_schedule_timezone");
  const rule = parseCron(expression);
  const start = parts(after, zone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < 400; i++, cursor += 86_400_000) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!rule.months.has(month)) continue;
    const weekday = date.getUTCDay();
    const dayMatch = rule.days.has(day);
    const weekdayMatch = rule.weekdays.has(weekday);
    const matches =
      rule.dayWildcard && rule.weekdayWildcard
        ? true
        : rule.dayWildcard
          ? weekdayMatch
          : rule.weekdayWildcard
            ? dayMatch
            : dayMatch || weekdayMatch;
    if (!matches) continue;
    for (const hour of rule.hours) {
      for (const minute of rule.minutes) {
        let at = localToUtc(year, month, day, hour, minute, zone);
        if (Number.isNaN(at)) {
          // Spring forward: run at the first real minute after the missing time.
          at = localToUtc(year, month, day, hour + 1, 0, zone);
          if (Number.isNaN(at)) continue;
        }
        if (at > after) return at;
      }
    }
  }
  return fail("invalid_schedule_never_runs");
}

/** Plain words for the owner: "Weekdays at 09:00 (America/New_York)" style, best effort. */
export function describeCron(expression: string, zone: string): string {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  const time =
    /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : null;
  const days =
    weekday === "1-5"
      ? "Weekdays"
      : weekday === "*" && day === "*"
        ? "Every day"
        : weekday !== "*"
          ? `Days ${weekday} (0=Sun)`
          : `Day ${day} of the month`;
  const months = month === "*" ? "" : ` in months ${month}`;
  return time ? `${days}${months} at ${time} (${zone})` : `${expression} (${zone})`;
}
