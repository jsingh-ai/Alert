export function elapsedSeconds(date: Date) {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
}

export function parseDate(value: unknown, fallback: Date) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const dateInputPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function zonedOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number, timeZone: string) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let i = 0; i < 3; i += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - zonedOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

/** A moment as local time in a zone with its offset, e.g. 2026-11-16T10:58:02-06:00 (still a valid ISO time anywhere). */
export function formatInTimeZone(date: Date, timeZone: string) {
  const offsetMs = zonedOffsetMs(date, timeZone);
  const local = new Date(date.getTime() + offsetMs).toISOString().slice(0, 19);
  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  const sign = offsetMs < 0 ? "-" : "+";
  return `${local}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A time typed into a request. A plain date, or a date and time with no Z or offset, means that wall-clock
 * time in the zone (so "2026-11-16T08:00" is 8 AM Central); one with Z or an offset is taken as written.
 * null = nothing given, undefined = not a date.
 */
export function parseZonedInput(value: unknown, timeZone: string, boundary: "start" | "end"): Date | null | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const dateOnly = text.match(dateInputPattern);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    // The end of a day is one millisecond before the next midnight in the zone
    return boundary === "start"
      ? zonedDateTimeToUtc(y, m, d, 0, 0, 0, 0, timeZone)
      : new Date(zonedDateTimeToUtc(y, m, d + 1, 0, 0, 0, 0, timeZone).getTime() - 1);
  }
  const wall = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (wall) return zonedDateTimeToUtc(Number(wall[1]), Number(wall[2]), Number(wall[3]), Number(wall[4]), Number(wall[5]), Number(wall[6] ?? 0), 0, timeZone);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseDateInputStart(value: unknown, fallback: Date, timeZone: string) {
  if (typeof value !== "string") return fallback;
  const match = value.match(dateInputPattern);
  if (!match) return parseDate(value, fallback);
  return zonedDateTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0, 0, timeZone);
}

export function startOfDayInTimeZone(date: Date, timeZone: string) {
  const key = dayKeyInTimeZone(date, timeZone);
  const match = key.match(dateInputPattern);
  if (!match) return new Date(date);
  return zonedDateTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0, 0, timeZone);
}

export function parseDateInputEnd(value: unknown, fallback: Date, timeZone: string) {
  if (typeof value !== "string") return fallback;
  const match = value.match(dateInputPattern);
  if (!match) return parseDate(value, fallback);
  return zonedDateTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]), 23, 59, 59, 999, timeZone);
}

export function dayKeyInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
