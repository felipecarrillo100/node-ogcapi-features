import type { Feature, Geometry } from "geojson";
import type { Queryable } from "ogc-cql2";

// Lists kept as native PostgreSQL arrays (schema.sql), beside those inside `properties`: served and written as
// properties of the feature like any other.
export const NATIVE_LISTS = { tags: "text[]", floors: "integer[]", visits: "date[]" } as const;

/** A queryable as OGC API Features Part 3 writes it, plus what `toSql` needs to find it (`sqlType`, `column`). */
export interface ServerQueryable extends Queryable {
  readonly sqlType?: string;
  readonly column?: string;
}

// The properties a filter may use, as OGC API Features Part 3 queryables, plus what `toSql` needs to find them
// (`sqlType`, `column`). Most live in the `properties` JSONB column, so the query reads them out as real columns of a
// subquery first: a text property as text (`->>`), a list as a JSON array (`->`, `jsonb`, compared element by element
// as its `items` say). The native lists and `geometry` (the `geom` column) are columns already. A property not listed
// here is refused (400).
export const QUERYABLES: Readonly<Record<string, ServerQueryable>> = {
  name: { type: "string" },
  services: { type: "array", items: { type: "string" }, sqlType: "jsonb" },
  zones: { type: "array", items: { type: "integer" }, sqlType: "jsonb" },
  inspections: { type: "array", items: { type: "string", format: "date" }, sqlType: "jsonb" },
  tags: { type: "array", items: { type: "string" }, sqlType: NATIVE_LISTS.tags, column: "tags" },
  floors: { type: "array", items: { type: "integer" }, sqlType: NATIVE_LISTS.floors, column: "floors" },
  visits: { type: "array", items: { type: "string", format: "date" }, sqlType: NATIVE_LISTS.visits, column: "visits" },
  geometry: { format: "geometry-any", column: "geom", sqlType: "geometry(Geometry, 4326)" },
};

export const sqlText = (s: string): string => s.replace(/'/g, "''");
export const sqlName = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export const FILTERABLE = `(SELECT features.*, ${Object.entries(QUERYABLES)
  .filter(([, q]) => q.column === undefined)
  .map(([name, q]) => `properties${q.sqlType === "jsonb" ? "->" : "->>"}'${sqlText(name)}' AS ${sqlName(name)}`)
  .join(", ")} FROM features) AS f`;

// A feature's properties as served: the jsonb ones and the native lists (a NULL list is absent, as a missing property).
export const PROPERTIES = `properties || jsonb_strip_nulls(jsonb_build_object(${Object.keys(NATIVE_LISTS)
  .map((name) => `'${name}', ${sqlName(name)}`)
  .join(", ")}))`;

export const SELECT_FEATURE = `id, ${PROPERTIES} AS properties, ST_AsGeoJSON(geom) AS geom_json`;

/** A row as `SELECT_FEATURE` reads it. */
export interface FeatureRow {
  id: number;
  properties: Record<string, unknown>;
  geom_json: string;
}

export interface SplitProperties {
  rest: Record<string, unknown>;
  lists: (unknown[] | null)[];
}

/**
 * A feature's properties as stored: the native lists taken out into their columns (absent: NULL), the rest for the
 * jsonb column. `null` when a native list isn't a list.
 */
export function splitProperties(properties: Record<string, unknown> = {}): SplitProperties | null {
  const rest = { ...properties };
  const lists: (unknown[] | null)[] = [];
  for (const name of Object.keys(NATIVE_LISTS)) {
    const value = rest[name];
    delete rest[name];
    if (value !== undefined && value !== null && !Array.isArray(value)) return null;
    lists.push(value ?? null);
  }
  return { rest, lists };
}

export const NATIVE_COLUMNS = Object.keys(NATIVE_LISTS).map(sqlName).join(", ");

/** `$n::type[], …` for the native lists, from placeholder `first` on. */
export const nativeParams = (first: number): string =>
  Object.values(NATIVE_LISTS)
    .map((type, i) => `$${first + i}::${type}`)
    .join(", ");

export function rowToFeature(row: FeatureRow): Feature<Geometry> & { id: number } {
  return { type: "Feature", id: row.id, properties: row.properties, geometry: JSON.parse(row.geom_json) as Geometry };
}
