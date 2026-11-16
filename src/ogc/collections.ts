import { postgresValue, type SqlColumn } from "ogc-cql2/sql";
import { FILTERABLE, NATIVE_LISTS, QUERYABLES, type ServerQueryable } from "../features/storage.ts";

/**
 * A collection of the OGC API, as the routes, the queryables, the schema and the OpenAPI document read it. Every SQL
 * fragment works on the collection's `source`, aliased `f`.
 */
export interface Collection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /**
   * `FROM` this, aliased `f`: the table's columns the filters and properties read, plus `served_geom`, the geometry
   * exactly as it is served (see {@link served}).
   */
  readonly source: string;
  /** The SRID the geometry is stored in. */
  readonly srid: number;
  /** A json or jsonb expression: the feature's properties as served (a NULL value absent). */
  readonly properties: string;
  /** The column `datetime` compares with; without one, `datetime` selects every feature (Part 1). */
  readonly temporal?: string;
  /**
   * The properties a filter may use, as Part 3 queryables, plus what `toSql` needs (`sqlType`, `column`). `geometry`
   * is the feature's geometry. A property not here is refused (400).
   */
  readonly queryables: Readonly<Record<string, ServerQueryable>>;
  /** More JSON Schema keywords for a property in `/queryables` and `/schema` (titles, units). */
  readonly annotations: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The temporal queryable, which Part 5 marks `primary-instant`. */
  readonly instant?: string;
  /** Whether a feature may carry properties not in `queryables` (`/schema`'s `additionalProperties`). */
  readonly openProperties: boolean;
  /** The properties every feature has (NOT NULL columns): `/schema`'s `required`, and refused when missing on writes. */
  readonly required: readonly string[];
  /** The GeoJSON geometry types the geometry column takes. */
  readonly geometryTypes: readonly string[];
}

const ANY_GEOMETRY = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
];

/**
 * `source` (aliased `f`, its geometry `geom` in `srid`) with one more column, `served_geom`: the geometry exactly as it
 * is served, the CRS84 GeoJSON that `ST_AsGeoJSON` writes (9 decimals) read back. Filters and `bbox` compare it, so the
 * server selects what a client evaluating the served features selects (ogc-cql2's `evaluate`, on the map). Stored in
 * EPSG:3857, Brussels comes back from the transform as 4.399999999999999 50.800000000000004; it is served, and
 * compared, as 4.4 50.8.
 */
function served(source: string, srid: number): string {
  const crs84 = srid === 4326 ? "f.geom" : "ST_Transform(f.geom, 4326)";
  return `(SELECT f.*, ST_GeomFromGeoJSON(ST_AsGeoJSON(${crs84})) AS served_geom FROM ${source}) AS f`;
}

/** The `geometry` queryable on `served_geom` (CRS84). */
const SERVED_GEOMETRY = (type: string): ServerQueryable => ({
  format: "geometry-any",
  column: "served_geom",
  sqlType: `geometry(${type}, 4326)`,
});

const ROUTES_QUERYABLES: Readonly<Record<string, ServerQueryable>> = {
  name: { type: "string", sqlType: "text" },
  departure: { type: "string", format: "date-time", sqlType: "timestamp with time zone" },
  length_km: { type: "number", sqlType: "double precision" },
  lanes: { type: "integer", sqlType: "integer" },
  geometry: { ...SERVED_GEOMETRY("LineString"), format: "geometry-linestring" },
};

/** Text in UTC, ISO 8601 with milliseconds and a `Z`, as `postgresValue` serves instants. */
export const utc = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * `pairs` of a property and its queryable as a json(b) object: each value as ogc-cql2's `postgresValue` SELECTs it, so
 * that what is served is exactly what the SQL compares (instants in UTC with milliseconds, numbers as double precision,
 * native arrays element by element; ogc-cql2's PostgreSQL guide). A NULL is left out, as a missing property.
 */
function servedValues(
  kind: "json" | "jsonb",
  queryables: Readonly<Record<string, ServerQueryable>>,
  names: string[],
): string {
  const pairs = names.map((name) => {
    const q = queryables[name] as ServerQueryable;
    // ogc-cql2's SqlColumn types `type` as a scalar only (the array gap, see filter.ts): passed as it is.
    return `'${name}', ${postgresValue(q.column ?? name, q as unknown as SqlColumn)}`;
  });
  return `${kind}_strip_nulls(${kind}_build_object(${pairs.join(", ")}))`;
}

export const COLLECTIONS: readonly Collection[] = [
  {
    id: "features",
    title: "Features",
    description:
      "Points, lines and polygons around the world, with text and list properties: lists in a jsonb column " +
      "(services, zones, inspections) and as native arrays (tags, floors, visits). The same table as GET /features.",
    source: served(FILTERABLE, 4326),
    srid: 4326,
    // The jsonb properties as they are; the native lists as postgresValue serves them (the REST API keeps its own).
    properties: `properties || ${servedValues("jsonb", QUERYABLES, Object.keys(NATIVE_LISTS))}`,
    // The REST API's own queryables, but the geometry as served (the REST API compares the stored one).
    queryables: { ...QUERYABLES, geometry: SERVED_GEOMETRY("Geometry") },
    annotations: {
      name: { title: "Name" },
      services: { title: "Services (a list in the jsonb column)" },
      zones: { title: "Zones (a list in the jsonb column)" },
      inspections: { title: "Inspection days (a list in the jsonb column)" },
      tags: { title: "Tags (a native text[] column)" },
      floors: { title: "Floors (a native integer[] column)" },
      visits: { title: "Visit days (a native date[] column)" },
      geometry: { title: "Geometry" },
    },
    // The jsonb column takes any property.
    openProperties: true,
    required: ["geometry"],
    // geometry(Geometry, 4326): any type.
    geometryTypes: ANY_GEOMETRY,
  },
  {
    id: "routes",
    title: "Routes",
    description:
      "Lines between the cities of the features collection, with a departure instant, a length in kilometres and a " +
      "number of lanes. Stored in EPSG:3857.",
    source: served("routes AS f", 3857),
    srid: 3857,
    // json, not jsonb, so the properties come in the columns' order.
    properties: servedValues("json", ROUTES_QUERYABLES, ["name", "departure", "length_km", "lanes"]),
    temporal: "f.departure",
    queryables: ROUTES_QUERYABLES,
    annotations: {
      name: { title: "Name" },
      departure: { title: "Departure (UTC)" },
      length_km: { title: "Length", "x-ogc-unit": "km" },
      lanes: { title: "Lanes" },
      geometry: { title: "Geometry" },
    },
    instant: "departure",
    openProperties: false,
    required: ["name", "geometry"],
    // geometry(LineString, 3857).
    geometryTypes: ["LineString"],
  },
];

export const collectionById = (id: string): Collection | undefined => COLLECTIONS.find((c) => c.id === id);

/** The geometry as served (CRS84), for the output, `bbox` and the extent: the `served_geom` column of the source. */
export const geometry84 = (_c: Collection): string => "f.served_geom";

/** The queryable that is the geometry. */
export const GEOMETRY = "geometry";

/**
 * The queryables with a simple value (string, number, integer, boolean; not an instant), each also a query parameter
 * of `/items` (Part 3, Queryables as Query Parameters).
 */
export function simpleQueryables(c: Collection): [string, ServerQueryable][] {
  return Object.entries(c.queryables).filter(
    ([, q]) => ["string", "number", "integer", "boolean"].includes(String(q.type)) && q.format === undefined,
  );
}
