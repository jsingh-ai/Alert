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

export function parseDateInputStart(value: unknown, fallback: Date, timeZone: string) {
  if (typeof value !== "string") return fallback;
  const match = value.match(dateInputPattern);
  if (!match) return parseDate(value, fallback);
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
