import { FILTERABLE, PROPERTIES } from "../features/storage.ts";

/**
 * A collection of the OGC API, as both the routes and the OpenAPI document read it. Every SQL fragment works on the
 * collection's `source`, aliased `f`.
 */
export interface Collection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** `FROM` this: a table or a subquery, aliased `f`, with the columns the filters and properties read. */
  readonly source: string;
  /** The geometry column's SRID (`ST_Transform` to CRS84 when it isn't 4326). */
  readonly srid: number;
  /** Part 5's `format` of the geometry: what it may hold. */
  readonly geometryFormat: `geometry-${string}`;
  /** A json or jsonb expression: the feature's properties as served (a NULL value absent). */
  readonly properties: string;
  /** The column `datetime` compares with; without one, `datetime` selects every feature (Part 1). */
  readonly temporal?: string;
}

/** Text in UTC, ISO 8601 with a `Z`, as GeoJSON and CQL2 write instants. */
export const utc = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export const COLLECTIONS: readonly Collection[] = [
  {
    id: "features",
    title: "Features",
    description:
      "Points, lines and polygons around the world, with text and list properties: lists in a jsonb column " +
      "(services, zones, inspections) and as native arrays (tags, floors, visits). The same table as GET /features.",
    source: FILTERABLE,
    srid: 4326,
    geometryFormat: "geometry-any",
    properties: PROPERTIES,
  },
  {
    id: "routes",
    title: "Routes",
    description:
      "Lines between the cities of the features collection, with a departure instant, a length in kilometres and a " +
      "number of lanes. Stored in EPSG:3857.",
    source: "routes AS f",
    srid: 3857,
    geometryFormat: "geometry-linestring",
    // json, not jsonb, so the properties come in the columns' order.
    properties: `json_strip_nulls(json_build_object('name', f.name, 'departure', ${utc("f.departure")}, 'length_km', f.length_km, 'lanes', f.lanes))`,
    temporal: "f.departure",
  },
];

export const collectionById = (id: string): Collection | undefined => COLLECTIONS.find((c) => c.id === id);

/** The geometry in CRS84 (lon/lat, SRID 4326). */
export const geometry84 = (c: Collection): string => (c.srid === 4326 ? "f.geom" : "ST_Transform(f.geom, 4326)");
