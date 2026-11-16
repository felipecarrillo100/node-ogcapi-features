import type { Request } from "express";
import type { Cql2Filter } from "ogc-cql2";
import { fromText } from "ogc-cql2/parse";
import { type SqlOptions, toSql } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";
import { CQL2_DECLARED } from "../conformance.ts";
import { type Collection, simpleQueryables } from "./collections.ts";
import { badRequest } from "./errors.ts";
import type { Where } from "./where.ts";

export const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";

/** The query parameters of Part 3 on `/items`. */
export const FILTER_PARAMS = ["filter", "filter-lang", "filter-crs"] as const;

// ogc-cql2 1.6.2's `SqlColumn` types `type` as a scalar only, though `toSql` reads `"array"` with `items` (its
// postgres dialect documents jsonb and native lists): the queryables are passed as its columns as they are.
const columns = (c: Collection) => c.queryables as unknown as SqlOptions["columns"];

const param = (req: Request, name: string): string | undefined => req.query[name] as string | undefined;

/** "message (code at path)", from an ogc-cql2 error. */
function reason(e: unknown): string {
  const err = e as Error & { code?: string; path?: string };
  const where = err.path ? ` at ${err.path}` : "";
  return err.code ? `${err.message} (${err.code}${where})` : err.message;
}

/** `filter` as CQL2-JSON: from CQL2-text (`filter-lang=cql2-text`, the default, Part 3) or as it comes. */
function parseFilter(req: Request): Cql2Filter | undefined {
  const filter = param(req, "filter");
  const lang = param(req, "filter-lang") ?? "cql2-text";
  if (lang !== "cql2-text" && lang !== "cql2-json")
    throw badRequest(`Invalid filter-lang "${lang}": cql2-text or cql2-json`);
  const crs = param(req, "filter-crs");
  if (crs !== undefined && crs !== CRS84)
    throw badRequest(`Invalid filter-crs "${crs}": this server reads ${CRS84} only`);
  if (filter === undefined) return undefined;
  if (lang === "cql2-json") {
    try {
      // `validate` checks it (addFilter).
      return JSON.parse(filter) as Cql2Filter;
    } catch {
      throw badRequest("Invalid filter: not valid JSON (filter-lang=cql2-json)");
    }
  }
  try {
    return fromText(filter);
  } catch (e) {
    throw badRequest(`Invalid filter: ${reason(e)}`);
  }
}

/**
 * Adds the condition of a CQL2 filter on collection `c`, the way ogc-cql2's guide says (`sql-backends.md`): first
 * `validate` against the declared CQL2 classes and the collection's queryables (400 with every problem), then `toSql`.
 * `label` names what the filter came from, for the error (`filter`, `bbox`, `datetime`, a queryable parameter).
 */
export function addFilter(where: Where, c: Collection, filter: unknown, label = "filter"): void {
  const result = validate(filter, { conformance: CQL2_DECLARED, queryables: c.queryables });
  if (!result.valid) {
    const problems = result.problems.map((p) => `${p.message} (${p.code}${p.path ? ` at ${p.path}` : ""})`);
    throw badRequest(`Invalid ${label}: ${problems.join("; ")}`);
  }
  let sql: ReturnType<typeof toSql>;
  try {
    sql = toSql(result.filter, { dialect: "postgres", columns: columns(c) });
  } catch (e) {
    throw badRequest(`Invalid ${label}: ${reason(e)}`);
  }
  where.addNumbered(sql.where, sql.params);
}

/** A query parameter's value, as its queryable's type reads it; `undefined` when it isn't one. */
function typed(value: string, type: string): string | number | boolean | undefined {
  if (type === "string") return value;
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : undefined;
  if (type === "integer") return /^-?\d+$/.test(value) ? Number(value) : undefined;
  const n = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The Part 3 conditions on `/items`: `filter` (with `filter-lang`, `filter-crs`), and each simple queryable given as a
 * query parameter (`?name=Brussels`), which selects the features whose value equals it. All combine with AND.
 */
export function addFilters(req: Request, c: Collection, where: Where): void {
  const filter = parseFilter(req);
  if (filter !== undefined) addFilter(where, c, filter);
  for (const [name, q] of simpleQueryables(c)) {
    const value = param(req, name);
    if (value === undefined) continue;
    const v = typed(value, String(q.type));
    if (v === undefined) throw badRequest(`Invalid ${name} "${value}": a value of type ${q.type}`);
    addFilter(where, c, { op: "=", args: [{ property: name }, v] }, name);
  }
}

/** The query parameters `/items` takes on collection `c`. */
export const itemsParams = (c: Collection): string[] => [
  "f",
  "limit",
  "offset",
  "bbox",
  "datetime",
  ...FILTER_PARAMS,
  ...simpleQueryables(c).map(([name]) => name),
];
