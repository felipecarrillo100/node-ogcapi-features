import type { Request } from "express";
import { badRequest } from "./errors.ts";

/**
 * Refuses (400) a query parameter the route doesn't define (Part 1 `/req/core/query-param-unknown`) and a parameter
 * given twice.
 */
export function checkParams(req: Request, allowed: readonly string[]): void {
  for (const [name, value] of Object.entries(req.query)) {
    if (!allowed.includes(name)) {
      throw badRequest(
        `Unknown query parameter "${name}"; this resource takes ${allowed.map((a) => `"${a}"`).join(", ")}`,
      );
    }
    if (typeof value !== "string")
      throw badRequest(`The query parameter "${name}" must be given once, as a single value`);
  }
}

const param = (req: Request, name: string): string | undefined => req.query[name] as string | undefined;

export const LIMIT = { default: 10, minimum: 1, maximum: 10000 } as const;

/** `limit`: default 10, at least 1; above 10000 it is 10000 (Part 1: not an error). */
export function parseLimit(req: Request): number {
  const value = param(req, "limit");
  if (value === undefined) return LIMIT.default;
  if (!/^\d+$/.test(value) || Number(value) < LIMIT.minimum) {
    throw badRequest(`Invalid limit "${value}": an integer from ${LIMIT.minimum}`);
  }
  return Math.min(Number(value), LIMIT.maximum);
}

/** `offset`: how many features to skip, for paging; default 0. */
export function parseOffset(req: Request): number {
  const value = param(req, "offset");
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw badRequest(`Invalid offset "${value}": an integer from 0`);
  return Number(value);
}

/** `bbox`: 4 numbers, or 6 with heights (ignored), in CRS84. West above east crosses the antimeridian. */
export function parseBbox(req: Request): [number, number, number, number] | undefined {
  const value = param(req, "bbox");
  if (value === undefined) return undefined;
  const n = value.split(",").map((s) => (s.trim() === "" ? Number.NaN : Number(s)));
  if ((n.length !== 4 && n.length !== 6) || n.some((x) => !Number.isFinite(x))) {
    throw badRequest(`Invalid bbox "${value}": 4 or 6 numbers, comma-separated`);
  }
  const [minx, miny, maxx, maxy] = (n.length === 4 ? n : [n[0], n[1], n[3], n[4]]) as [number, number, number, number];
  if (miny > maxy) throw badRequest(`Invalid bbox "${value}": its south is above its north`);
  return [minx, miny, maxx, maxy];
}

/** One end of a `datetime` interval, as an instant `timestamptz` reads, or `undefined` for an open end. */
type Bound = string | undefined;

export interface DatetimeFilter {
  /** Inclusive. */
  from: Bound;
  /** Inclusive, or exclusive (`before`) for a date, which covers its whole day. */
  to: Bound;
  toExclusive: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function instant(value: string, whole: string): { start: string; next?: string } {
  if (DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    const next = new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString();
    return { start: `${value}T00:00:00Z`, next };
  }
  if (DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))) return { start: value };
  throw badRequest(
    `Invalid datetime "${whole}": an RFC 3339 date-time or date, or an interval of them ("../.." for open ends)`,
  );
}

/**
 * `datetime` (Part 1): an instant or an interval `start/end`, `..` or empty for an open end. A date stands for its
 * whole day (UTC).
 */
export function parseDatetime(req: Request): DatetimeFilter | undefined {
  const value = param(req, "datetime");
  if (value === undefined) return undefined;
  const parts = value.split("/");
  if (parts.length === 1) {
    const i = instant(value, value);
    return i.next
      ? { from: i.start, to: i.next, toExclusive: true }
      : { from: i.start, to: i.start, toExclusive: false };
  }
  if (parts.length !== 2) throw badRequest(`Invalid datetime "${value}"`);
  const [a, b] = parts as [string, string];
  const open = (s: string) => s === "" || s === "..";
  const start = open(a) ? undefined : instant(a, value);
  const end = open(b) ? undefined : instant(b, value);
  if (start && end && Date.parse(start.start) > Date.parse(end.start)) {
    throw badRequest(`Invalid datetime "${value}": its start is after its end`);
  }
  return {
    from: start?.start,
    to: end ? (end.next ?? end.start) : undefined,
    toExclusive: end?.next !== undefined,
  };
}
