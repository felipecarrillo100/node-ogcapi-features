import type { Request } from "express";
import { isDate, isDateTime } from "./dates.ts";
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

/**
 * `bbox`: 4 numbers, or 6 with heights, in CRS84, as a CQL2 BBOX literal takes them. West above east crosses the
 * antimeridian.
 */
export function parseBbox(req: Request): number[] | undefined {
  const value = param(req, "bbox");
  if (value === undefined) return undefined;
  const n = value.split(",").map((s) => (s.trim() === "" ? Number.NaN : Number(s)));
  if ((n.length !== 4 && n.length !== 6) || n.some((x) => !Number.isFinite(x))) {
    throw badRequest(`Invalid bbox "${value}": 4 or 6 numbers, comma-separated`);
  }
  const [south, north] = n.length === 4 ? [n[1], n[3]] : [n[1], n[4]];
  if ((south as number) > (north as number)) throw badRequest(`Invalid bbox "${value}": its south is above its north`);
  return n;
}

/** A CQL2 temporal literal: an instant (`{ timestamp }`) or an interval of UTC timestamps, `".."` for an open end. */
export type TemporalLiteral = { timestamp: string } | { interval: [string, string] };

/**
 * An RFC 3339 date-time as CQL2 writes a timestamp: UTC, with milliseconds (CQL2 compares to the millisecond). A leap
 * second (`…:60`) is the last millisecond of its minute, as ogc-cql2 reads it.
 */
function utcTimestamp(value: string): string {
  const leap = value.replace(/:60(\.\d+)?(?=Z|[+-]\d{2}:\d{2}$)/i, ":59.999");
  return new Date(leap).toISOString();
}

/** One end of `datetime`: a day stands for its first or its last millisecond (UTC); an instant for itself. */
function end(value: string, side: "start" | "end", whole: string): string {
  if (isDate(value)) return side === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
  if (isDateTime(value)) return utcTimestamp(value);
  throw badRequest(
    `Invalid datetime "${whole}": an RFC 3339 date-time or date, or an interval of them ("../.." for open ends)`,
  );
}

/**
 * `datetime` (Part 1) as a CQL2 temporal literal, for `T_INTERSECTS` with the collection's instant: an instant, or an
 * interval `start/end` with `..` or nothing for an open end. A date stands for its whole day (UTC), since CQL2 never
 * compares a date with a timestamp.
 */
export function datetimeLiteral(req: Request): TemporalLiteral | undefined {
  const value = param(req, "datetime");
  if (value === undefined) return undefined;
  const parts = value.split("/");
  if (parts.length === 1) {
    return isDate(value)
      ? { interval: [end(value, "start", value), end(value, "end", value)] }
      : { timestamp: end(value, "start", value) };
  }
  if (parts.length !== 2) throw badRequest(`Invalid datetime "${value}"`);
  const [a, b] = parts as [string, string];
  const open = (s: string) => s === "" || s === "..";
  const start = open(a) ? ".." : end(a, "start", value);
  const stop = open(b) ? ".." : end(b, "end", value);
  if (start !== ".." && stop !== ".." && start > stop) {
    throw badRequest(`Invalid datetime "${value}": its start is after its end`);
  }
  return { interval: [start, stop] };
}
