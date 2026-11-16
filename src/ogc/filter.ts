import type { Request } from "express";
import { fromText } from "ogc-cql2/parse";
import { type SqlOptions, toSql } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";
import { CQL2_DECLARED } from "../conformance.ts";
import { type Collection, simpleQueryables } from "./collections.ts";
import { CRS84, type Crs, checkArea, crsParam, literalsOf } from "./crs.ts";
import { badRequest } from "./errors.ts";
import type { Where } from "./where.ts";

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

/**
 * `filter` as CQL2-JSON, from CQL2-text (`filter-lang=cql2-text`, the default, Part 3) or as it comes, and the CRS its
 * literals are in (`filter-crs`). The literals are left in that CRS: `toSql` transforms them (`literals`).
 */
function parseFilter(req: Request): { filter: unknown; crs: Crs } | undefined {
  const filter = param(req, "filter");
  const lang = param(req, "filter-lang") ?? "cql2-text";
  if (lang !== "cql2-text" && lang !== "cql2-json")
    throw badRequest(`Invalid filter-lang "${lang}": cql2-text or cql2-json`);
  const crs = crsParam(req, "filter-crs");
  if (filter === undefined) return undefined;
  if (lang === "cql2-json") {
    try {
      // `validate` checks it (addFilter).
      return { filter: JSON.parse(filter), crs };
    } catch {
      throw badRequest("Invalid filter: not valid JSON (filter-lang=cql2-json)");
    }
  }
  try {
    // Outside CRS84, the coordinates aren't checked against CRS84's ranges (crs84: false); checkArea checks them.
    return { filter: fromText(filter, { crs84: crs === CRS84 }), crs };
  } catch (e) {
    throw badRequest(`Invalid filter: ${reason(e)}`);
  }
}

/**
 * Adds the condition of a CQL2 filter on collection `c`, the way ogc-cql2's guide says (`sql-backends.md`): first
 * `validate` against the declared CQL2 classes and the collection's queryables (400 with every problem), then `toSql`.
 * `label` names what the filter came from, for the error (`filter`, `bbox`, `datetime`, a queryable parameter); `crs`
 * is the CRS of its geometry and BBOX literals (`filter-crs`, `bbox-crs`), which `toSql` transforms to CRS84 in
 * PostGIS (ogc-cql2's `literals`).
 */
export function addFilter(where: Where, c: Collection, filter: unknown, label = "filter", crs: Crs = CRS84): void {
  const result = validate(filter, { conformance: CQL2_DECLARED, queryables: c.queryables, crs84: crs === CRS84 });
  if (!result.valid) {
    const problems = result.problems.map((p) => `${p.message} (${p.code}${p.path ? ` at ${p.path}` : ""})`);
    throw badRequest(`Invalid ${label}: ${problems.join("; ")}`);
  }
  checkArea(crs, result.filter, label);
  let sql: ReturnType<typeof toSql>;
  try {
    sql = toSql(result.filter, { dialect: "postgres", columns: columns(c), literals: literalsOf(crs) });
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
  const parsed = parseFilter(req);
  if (parsed !== undefined) addFilter(where, c, parsed.filter, "filter", parsed.crs);
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
  "bbox-crs",
  "crs",
  "datetime",
  ...FILTER_PARAMS,
  ...simpleQueryables(c).map(([name]) => name),
];
