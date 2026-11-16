import type { Request } from "express";
import type { SqlLiterals } from "ogc-cql2/sql";
import { badRequest } from "./errors.ts";

/** A CRS the server takes and gives (Part 2): its URI, its PostGIS SRID, and whether its axes are lat, lon. */
export interface Crs {
  readonly uri: string;
  readonly srid: number;
  /** EPSG:4326 is latitude, longitude (the CRS's own axis order); CRS84 is longitude, latitude. */
  readonly latLon: boolean;
}

export const CRS84: Crs = { uri: "http://www.opengis.net/def/crs/OGC/1.3/CRS84", srid: 4326, latLon: false };
export const EPSG_4326: Crs = { uri: "http://www.opengis.net/def/crs/EPSG/0/4326", srid: 4326, latLon: true };
export const EPSG_3857: Crs = { uri: "http://www.opengis.net/def/crs/EPSG/0/3857", srid: 3857, latLon: false };
/** CRS84 with heights, which a request body may declare (Part 4 Req 39); the same as CRS84 here. */
const CRS84H: Crs = { uri: "http://www.opengis.net/def/crs/OGC/0/CRS84h", srid: 4326, latLon: false };

/** The CRSs of every collection, CRS84 (the default) first: `/collections`' `crs`. */
export const CRS_LIST: readonly Crs[] = [CRS84, EPSG_4326, EPSG_3857];

/** The storage CRS of a collection stored in `srid`. */
export const storageCrs = (srid: number): Crs => (srid === 3857 ? EPSG_3857 : CRS84);

const byUri = (uri: string, list: readonly Crs[] = CRS_LIST) => list.find((c) => c.uri === uri);

/** The CRS a query parameter (`crs`, `bbox-crs`, `filter-crs`) names, CRS84 when absent; 400 for another. */
export function crsParam(req: Request, name: string): Crs {
  const value = req.query[name] as string | undefined;
  if (value === undefined) return CRS84;
  const crs = byUri(value);
  if (!crs) throw badRequest(`Unsupported ${name} "${value}": ${CRS_LIST.map((c) => c.uri).join(", ")}`);
  return crs;
}

/** The CRS a request body's `Content-Crs` header names (`<uri>`), CRS84 when absent; 400 for another (Part 4 Req 42). */
export function contentCrs(req: Request): Crs {
  const header = req.get("content-crs");
  if (header === undefined) return CRS84;
  const crs = byUri(header.trim().replace(/^<(.*)>$/, "$1"), [...CRS_LIST, CRS84H]);
  if (!crs) throw badRequest(`Unsupported Content-Crs ${header}: ${CRS_LIST.map((c) => `<${c.uri}>`).join(", ")}`);
  return crs;
}

/** The `Content-Crs` header value of an answer in `crs` (Part 2 Req 15–16). */
export const contentCrsHeader = (crs: Crs): string => `<${crs.uri}>`;

/**
 * The CRS of a filter's literals as ogc-cql2's `toSql` takes it (`literals`): EPSG:4326 latitude first (`yx`), EPSG:3857
 * reprojected to 4326 by PostGIS. CRS84 needs none.
 */
export const literalsOf = (crs: Crs): SqlLiterals | undefined =>
  crs === CRS84 ? undefined : { srid: crs.srid, ...(crs.latLon ? { yx: true } : {}) };

/** Each CRS's area of use as EPSG publishes it, on its own axes (x or the first axis, then y or the second). */
const AREAS: ReadonlyMap<Crs, { axes: [string, string]; limits: [number, number] }> = new Map([
  // EPSG:3857's projected bounds: x ±20037508.34 m (±180°), y ±20048966.1 m (±85.06°).
  [EPSG_3857, { axes: ["x", "y"], limits: [20037508.34, 20048966.1] }],
  // EPSG:4326 is latitude first.
  [EPSG_4326, { axes: ["latitude", "longitude"], limits: [90, 180] }],
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The positions (first two numbers each) of a GeoJSON coordinates array, at any depth. */
function positions(c: unknown): number[][] {
  if (!Array.isArray(c)) return [];
  if (typeof c[0] === "number") return [c as number[]];
  return c.flatMap(positions);
}

/** Every position of the geometry and BBOX literals in a CQL2-JSON filter (a box: its two corners). */
function literalPositions(node: unknown): number[][] {
  if (Array.isArray(node)) return node.flatMap(literalPositions);
  if (!isObject(node)) return [];
  if (Array.isArray(node.bbox) && node.bbox.every((n) => typeof n === "number")) {
    const b = node.bbox as number[];
    return b.length === 6
      ? ([
          [b[0], b[1]],
          [b[3], b[4]],
        ] as number[][])
      : ([
          [b[0], b[1]],
          [b[2], b[3]],
        ] as number[][]);
  }
  if (typeof node.type === "string" && "coordinates" in node) return positions(node.coordinates);
  return Object.values(node).flatMap(literalPositions);
}

/**
 * 400 for a literal of a filter (or a box) in `crs` outside that CRS's area of use: neither ogc-cql2 nor PostGIS can
 * tell (PostGIS wraps an EPSG:3857 x past ±20037508.34 to the other side of the world, silently), so the server
 * refuses it (ogc-cql2's guide, "Literals in another CRS"). CRS84's ranges ogc-cql2 checks itself.
 */
export function checkArea(crs: Crs, filter: unknown, label: string): void {
  const area = AREAS.get(crs);
  if (!area) return;
  for (const p of literalPositions(filter)) {
    for (const i of [0, 1] as const) {
      const v = p[i] as number;
      if (Math.abs(v) > area.limits[i]) {
        throw badRequest(
          `Invalid ${label}: ${area.axes[i]} ${v} is outside the area of use of ${crs.uri} (±${area.limits[i]})`,
        );
      }
    }
  }
}

/**
 * The SQL of a geometry sent as GeoJSON text (`param`) in `crs`, in the column's `srid`: straight from one to the other,
 * so a geometry sent in the storage CRS is stored exactly as sent. NULL stays NULL.
 */
export function geometryFromGeoJson(param: string, crs: Crs, srid: number): string {
  const read = `ST_SetSRID(ST_GeomFromGeoJSON(${param}), ${crs.srid})`;
  const ordered = crs.latLon ? `ST_FlipCoordinates(${read})` : read;
  return crs.srid === srid ? ordered : `ST_Transform(${ordered}, ${srid})`;
}

/**
 * The SQL of a collection's geometry in `crs`, for its GeoJSON answer: CRS84 as served (`served_geom`), EPSG:4326 the
 * same with its axes swapped, another CRS from the stored geometry (`geom`, in `storageSrid`), which is the stored
 * value itself in its own CRS.
 */
export function geometryIn(crs: Crs, storageSrid: number): string {
  if (crs === CRS84) return "f.served_geom";
  if (crs.latLon) return "ST_FlipCoordinates(f.served_geom)";
  return crs.srid === storageSrid ? "f.geom" : `ST_Transform(f.geom, ${crs.srid})`;
}
