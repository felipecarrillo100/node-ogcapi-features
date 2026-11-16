import type { Geometry } from "geojson";
import type { ServerQueryable } from "../features/storage.ts";
import { type Collection, GEOMETRY } from "./collections.ts";
import { isDate, isDateTime } from "./dates.ts";
import { invalidBody } from "./errors.ts";

/** A feature as written: its properties (a missing or `null` one left out) and its geometry. */
export interface FeatureInput {
  properties: Record<string, unknown>;
  geometry: Geometry;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const validDate = isDate;
const validDateTime = isDateTime;

/** Why `v` doesn't fit the JSON Schema `q` (`type`, `format`, `items`), or `undefined` when it does. */
function misfit(v: unknown, q: { type?: unknown; format?: unknown; items?: unknown }): string | undefined {
  switch (q.type) {
    case "string":
      if (typeof v !== "string") return "a string";
      if (q.format === "date" && !validDate(v)) return "a date (YYYY-MM-DD)";
      if (q.format === "date-time" && !validDateTime(v)) return "an RFC 3339 date-time";
      return undefined;
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "a number";
    case "integer":
      return Number.isInteger(v) && Math.abs(v as number) <= 2147483647 ? undefined : "an integer";
    case "boolean":
      return typeof v === "boolean" ? undefined : "true or false";
    case "array": {
      if (!Array.isArray(v)) return "a list";
      const items = q.items as typeof q | undefined;
      if (!items) return undefined;
      const bad = v.map((x) => misfit(x, items)).find((m) => m !== undefined);
      return bad ? `a list, each value ${bad}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Positions nested `depth` levels (1: one position), each 2 or 3 finite numbers. */
function positions(c: unknown, depth: number): boolean {
  if (!Array.isArray(c)) return false;
  if (depth === 1)
    return (c.length === 2 || c.length === 3) && c.every((x) => typeof x === "number" && Number.isFinite(x));
  return c.every((x) => positions(x, depth - 1));
}

const DEPTH: Record<string, number> = {
  Point: 1,
  MultiPoint: 2,
  LineString: 2,
  MultiLineString: 3,
  Polygon: 3,
  MultiPolygon: 4,
};

/** Why `g` isn't a GeoJSON geometry of an allowed type, or `undefined` when it is. */
function geometryMisfit(g: unknown, allowed: readonly string[]): string | undefined {
  if (!isObject(g) || typeof g.type !== "string") return "a GeoJSON geometry (an object with a type)";
  if (!allowed.includes(g.type)) return `a GeoJSON geometry of type ${allowed.join(" or ")}`;
  if (g.type === "GeometryCollection") {
    const parts = g.geometries;
    return Array.isArray(parts) && parts.every((p) => geometryMisfit(p, Object.keys(DEPTH)) === undefined)
      ? undefined
      : "a GeometryCollection of GeoJSON geometries";
  }
  const depth = DEPTH[g.type] as number;
  if (!positions(g.coordinates, depth)) return `a ${g.type} with valid coordinates`;
  const coords = g.coordinates as unknown[];
  if (g.type === "LineString" && coords.length < 2) return "a LineString of at least 2 positions";
  const rings = g.type === "Polygon" ? [coords] : g.type === "MultiPolygon" ? coords : [];
  for (const polygon of rings as number[][][][]) {
    for (const ring of polygon) {
      const [first, last] = [ring[0], ring[ring.length - 1]];
      if (ring.length < 4 || JSON.stringify(first) !== JSON.stringify(last)) {
        return "a polygon whose rings are closed and have at least 4 positions";
      }
    }
  }
  return undefined;
}

/**
 * A feature's properties, checked against the collection's schema (`/schema`: its queryables, `required`,
 * `additionalProperties`), Part 4 Req 43. A `null` property is no value: left out. Refused (400): a property of the
 * wrong type, the read-only `id` among the properties, an unknown property on a closed collection, a missing required
 * one.
 */
export function checkProperties(c: Collection, properties: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (name === "id") throw invalidBody('Invalid property "id": the id is read-only (the server assigns it)');
    if (name === GEOMETRY)
      throw invalidBody(`Invalid property "${GEOMETRY}": the geometry is the feature's own member`);
    if (value === null || value === undefined) continue;
    const q = c.queryables[name] as ServerQueryable | undefined;
    if (!q && !c.openProperties) {
      throw invalidBody(
        `Unknown property "${name}": ${c.id} takes ${Object.keys(c.queryables).join(", ")} (additionalProperties: false)`,
      );
    }
    const bad = q ? misfit(value, q) : undefined;
    if (bad) throw invalidBody(`Invalid property "${name}": ${bad}`);
    kept[name] = value;
  }
  for (const name of c.required) {
    if (name !== GEOMETRY && kept[name] === undefined) throw invalidBody(`Missing property "${name}": it is required`);
  }
  return kept;
}

/** A feature's geometry: required, and a GeoJSON geometry of one of the collection's types (400 otherwise). */
export function checkGeometry(c: Collection, geometry: unknown): Geometry {
  if (geometry === null || geometry === undefined) throw invalidBody("Missing geometry: it is required");
  const bad = geometryMisfit(geometry, c.geometryTypes);
  if (bad) throw invalidBody(`Invalid geometry: ${bad}`);
  return geometry as Geometry;
}

/** A GeoJSON Feature from a request body (POST, PUT): `type` "Feature", `properties` an object or null. */
export function readFeature(c: Collection, body: unknown): FeatureInput {
  if (!isObject(body)) throw invalidBody("The body must be a GeoJSON Feature");
  if (body.type !== "Feature") {
    throw invalidBody(
      body.type === "FeatureCollection"
        ? "One GeoJSON Feature at a time, not a FeatureCollection"
        : 'The body must be a GeoJSON Feature ("type": "Feature")',
    );
  }
  if (body.properties !== undefined && body.properties !== null && !isObject(body.properties)) {
    throw invalidBody("The feature's properties must be an object");
  }
  return {
    properties: checkProperties(c, (body.properties ?? {}) as Record<string, unknown>),
    geometry: checkGeometry(c, body.geometry),
  };
}

/** JSON Merge Patch (RFC 7396): `patch` applied to `target`; `null` removes a member. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete result[k];
    else result[k] = mergePatch(result[k], v);
  }
  return result;
}

/**
 * A PATCH (`application/merge-patch+json`, Part 4 Req 44) applied to the feature as served. The patch is read against
 * the feature as its schema describes it, every property flat (`{ "lanes": 3, "geometry": {…} }`); a patch shaped like
 * GeoJSON (`{ "properties": {…}, "geometry": {…} }`, with or without `"type": "Feature"`) is read as that. The id
 * can't change (Req 44 B); a geometry replaces the geometry (Req 44 C); `null` unsets (Req 44 D). `geometry` is
 * `undefined` when the patch leaves it.
 */
export function applyPatch(
  c: Collection,
  id: number,
  current: Record<string, unknown>,
  patch: unknown,
): { properties: Record<string, unknown>; geometry?: Geometry } {
  if (!isObject(patch)) throw invalidBody("The body must be a JSON object (a JSON Merge Patch)");
  const geojson = "properties" in patch || "type" in patch;
  if (geojson && patch.type !== undefined && patch.type !== "Feature")
    throw invalidBody('A patch\'s "type" can only be "Feature"');
  if (geojson && patch.properties !== undefined && patch.properties !== null && !isObject(patch.properties)) {
    throw invalidBody("The patch's properties must be an object");
  }
  const { id: newId, geometry, type: _t, properties: patchProperties, ...flat } = patch;
  if (newId !== undefined && newId !== id && String(newId) !== String(id)) {
    throw invalidBody("The id can't be changed (x-ogc-role id)");
  }
  const changes = geojson ? ((patchProperties ?? {}) as Record<string, unknown>) : flat;
  if (geojson && Object.keys(flat).length) {
    throw invalidBody(
      `Unknown member${Object.keys(flat).length > 1 ? "s" : ""} ${Object.keys(flat).join(", ")} in a GeoJSON patch`,
    );
  }
  if (geometry === null) throw invalidBody("The geometry can't be removed: it is required");
  // The patched feature, as a whole, must fit the schema.
  const properties = checkProperties(c, mergePatch(current, changes) as Record<string, unknown>);
  return geometry === undefined ? { properties } : { properties, geometry: checkGeometry(c, geometry) };
}
