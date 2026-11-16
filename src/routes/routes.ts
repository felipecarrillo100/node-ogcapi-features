import { type Request, type Response, Router } from "express";
import type { Feature, Geometry } from "geojson";
import { type SqlOptions, toSql } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";
import type { Pool } from "pg";
import { REST_CONFORMS_TO } from "../conformance.ts";
import { type Collection, collectionById } from "../ogc/collections.ts";
import { CRS84 } from "../ogc/crs.ts";
import { OgcError } from "../ogc/errors.ts";
import { checkGeometry, checkProperties } from "../ogc/validate.ts";
import { Where } from "../ogc/where.ts";
import { WRITERS } from "../ogc/writes.ts";
import { body, route } from "../route.ts";

// The OGC API's `routes` collection: the same table, the same served values and geometry, the same queryables, so the
// REST and OGC answers on routes can't differ.
const ROUTES = collectionById("routes") as Collection;
const WRITER = WRITERS.routes as NonNullable<(typeof WRITERS)["routes"]>;

// ogc-cql2 1.6.2's `SqlColumn` types `type` as a scalar only (see features/routes.ts): passed as they are.
const COLUMNS = ROUTES.queryables as unknown as SqlOptions["columns"];

/** The features' SELECT: the properties as `postgresValue` serves them, the geometry as served (CRS84, 9 decimals). */
const SELECT = `SELECT f.id, ${ROUTES.properties} AS properties, ST_AsGeoJSON(f.served_geom, 9, 0) AS geom_json
  FROM ${ROUTES.source}`;

interface Row {
  id: number;
  properties: Record<string, unknown>;
  geom_json: string;
}

const toFeature = (row: Row): Feature<Geometry> & { id: number } => ({
  type: "Feature",
  id: row.id,
  properties: row.properties,
  geometry: JSON.parse(row.geom_json) as Geometry,
});

interface RouteBody {
  geometry: unknown;
  properties: unknown;
}

/** The path's id (SERIAL), or `undefined` when it can't be one. */
function idOf(req: Request): number | undefined {
  const id = String(req.params.id);
  return /^\d{1,10}$/.test(id) && Number(id) <= 2147483647 ? Number(id) : undefined;
}

const notFound = (res: Response, id: string) => res.status(404).json({ error: `Route ${id} not found` });

async function feature(pool: Pool, id: number): Promise<Row | undefined> {
  return (await pool.query<Row>(`${SELECT} WHERE f.id = $1`, [id])).rows[0];
}

/** The body's properties and geometry, checked against the collection's schema (as the OGC API's writes are). */
function readBody(req: Request): { properties: Record<string, unknown>; geometry: Geometry } {
  const { geometry, properties } = body<RouteBody>(req);
  if (properties !== undefined && properties !== null && (typeof properties !== "object" || Array.isArray(properties)))
    throw new OgcError(400, "InvalidRequestBody", "The properties must be an object");
  return {
    properties: checkProperties(ROUTES, (properties ?? {}) as Record<string, unknown>),
    geometry: checkGeometry(ROUTES, geometry),
  };
}

/** A route whose `OgcError` (a refused body) answers `{ error }` with its status, as the REST API answers. */
const restRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  route(async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!(e instanceof OgcError)) throw e;
      res.status(e.status).json({ error: e.message });
    }
  });

/** GET/POST/PUT/DELETE /routes[/:id], /routes/queryables (mounted at /restapi): the `routes` table, in CRS84. */
export function routesRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/routes",
    route(async (req, res) => {
      const { bbox, filter } = req.query;
      const where = new Where();

      if (bbox) {
        const box = String(bbox).split(",").map(Number);
        if (box.length !== 4 || box.some((n) => Number.isNaN(n))) {
          return res.status(400).json({ error: `Invalid bbox "${bbox}" — expected minx,miny,maxx,maxy` });
        }
        where.conditions.push(`f.served_geom && ST_MakeEnvelope(${box.map((n) => where.value(n)).join(", ")}, 4326)`);
      }

      if (filter) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(filter));
        } catch {
          return res.status(400).json({ error: "Invalid filter: not valid JSON" });
        }
        // ogc-cql2's order (its sql-backends guide): validate against the declared classes and the queryables, then toSql.
        const result = validate(parsed, { conformance: REST_CONFORMS_TO, queryables: ROUTES.queryables });
        if (!result.valid) {
          const [first] = result.problems;
          const all = result.problems.map((p) => `${p.message}${p.path ? ` (at ${p.path})` : ""}`).join("; ");
          return res.status(400).json({ error: `Invalid filter: ${all}`, code: first?.code, path: first?.path });
        }
        try {
          const sql = toSql(result.filter, { dialect: "postgres", columns: COLUMNS });
          where.addNumbered(sql.where, sql.params);
        } catch (e) {
          const err = e as Error & { code?: string; path?: string };
          return res.status(400).json({ error: `Invalid filter: ${err.message}`, code: err.code, path: err.path });
        }
      }

      const { rows } = await pool.query<Row>(`${SELECT} ${where} ORDER BY f.id`, where.params);
      return res.json({ type: "FeatureCollection", features: rows.map(toFeature) });
    }),
  );

  router.get("/routes/queryables", (_req, res) => {
    // The OGC part of each queryable, as /features/queryables writes it.
    const properties = Object.fromEntries(
      Object.entries(ROUTES.queryables).map(([name, { sqlType: _s, column: _c, ...q }]) => [name, q]),
    );
    res.json({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties });
  });

  router.get(
    "/routes/:id",
    route(async (req, res) => {
      const id = idOf(req);
      const row = id === undefined ? undefined : await feature(pool, id);
      if (!row) return notFound(res, String(req.params.id));
      return res.json(toFeature(row));
    }),
  );

  router.post(
    "/routes",
    restRoute(async (req, res) => {
      const id = await WRITER.insert(pool, readBody(req), CRS84);
      return res.status(201).json(toFeature((await feature(pool, id)) as Row));
    }),
  );

  router.put(
    "/routes/:id",
    restRoute(async (req, res) => {
      const id = idOf(req);
      const input = readBody(req);
      if (id === undefined || !(await WRITER.update(pool, id, input.properties, input.geometry, CRS84))) {
        return notFound(res, String(req.params.id));
      }
      return res.json(toFeature((await feature(pool, id)) as Row));
    }),
  );

  router.delete(
    "/routes/:id",
    route(async (req, res) => {
      const id = idOf(req);
      return res.json({ deleted: id !== undefined && (await WRITER.remove(pool, id)) });
    }),
  );

  return router;
}
