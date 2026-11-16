const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i;

/**
 * An RFC 3339 full-date (`YYYY-MM-DD`) that is a day of the calendar: not `2024-02-30` (which `Date.parse` takes,
 * rolling it over to March 1).
 */
export function isDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

/** An RFC 3339 date-time with its offset (`…Z`, `…+02:00`), its date a calendar day and its time a time of day. */
export function isDateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [hh, mm, ss] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const offsetOk = m[7] === undefined || (Number(m[7]) < 24 && Number(m[8]) < 60);
  // 60 seconds: a leap second, which RFC 3339 allows.
  return isDate(m[1] as string) && hh < 24 && mm < 60 && ss <= 60 && offsetOk;
}
