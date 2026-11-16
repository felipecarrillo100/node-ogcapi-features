import express, { type NextFunction, type Request, type Response, Router } from "express";
import type { Pool } from "pg";
import { NATIVE_COLUMNS, nativeParams, splitProperties } from "../features/storage.ts";
import { type Collection, collectionById } from "./collections.ts";
import { type Crs, contentCrs, geometryFromGeoJson } from "./crs.ts";
import { invalidBody, notFound, OgcError, sendError } from "./errors.ts";
import { ogc } from "./handler.ts";
import { url } from "./links.ts";
import { checkParams } from "./params.ts";
import { applyPatch, type FeatureInput, readFeature } from "./validate.ts";

/** How a collection's features are written: its table's own SQL. */
export interface Writer {
  /** Adds the feature, its geometry sent in `crs`; its new id. */
  insert(pool: Pool, f: FeatureInput, crs: Crs): Promise<number>;
  /** Replaces the feature's properties, and its geometry (sent in `crs`) unless `undefined`; whether it was there. */
  update(
    pool: Pool,
    id: number,
    properties: Record<string, unknown>,
    geometry: FeatureInput["geometry"] | undefined,
    crs: Crs,
  ): Promise<boolean>;
  /** Deletes the feature; whether it was there. */
  remove(pool: Pool, id: number): Promise<boolean>;
}

/** The geometry from GeoJSON text in `crs` into the column's SRID; NULL stays NULL (the column keeps its value). */
const fromGeoJson = (param: string, crs: Crs, srid: number) => geometryFromGeoJson(param, crs, srid);
const geometryText = (g: FeatureInput["geometry"] | undefined) => (g === undefined ? null : JSON.stringify(g));

/** Each collection's writer; the REST API's /restapi/routes uses the `routes` one too. */
export const WRITERS: Record<string, Writer> = {
  // The REST API's storage: the native lists to their columns (splitProperties), the rest to the jsonb.
  features: {
    async insert(pool, f, crs) {
      const split = splitProperties(f.properties) as NonNullable<ReturnType<typeof splitProperties>>;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO features (properties, geom, ${NATIVE_COLUMNS}) VALUES ($1, ${fromGeoJson("$2", crs, 4326)}, ${nativeParams(3)}) RETURNING id`,
        [split.rest, geometryText(f.geometry), ...split.lists],
      );
      return (rows[0] as { id: number }).id;
    },
    async update(pool, id, properties, geometry, crs) {
      const split = splitProperties(properties) as NonNullable<ReturnType<typeof splitProperties>>;
      const { rowCount } = await pool.query(
        `UPDATE features SET properties = $1, geom = coalesce(${fromGeoJson("$2", crs, 4326)}, geom),
         (${NATIVE_COLUMNS}) = ROW(${nativeParams(4)}) WHERE id = $3`,
        [split.rest, geometryText(geometry), id, ...split.lists],
      );
      return (rowCount ?? 0) > 0;
    },
    async remove(pool, id) {
      return ((await pool.query("DELETE FROM features WHERE id = $1", [id])).rowCount ?? 0) > 0;
    },
  },
  // Real columns; the geometry stored in EPSG:3857.
  routes: {
    async insert(pool, f, crs) {
      const p = f.properties;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO routes (name, departure, length_km, lanes, geom)
         VALUES ($1, $2::timestamptz, $3, $4, ${fromGeoJson("$5", crs, 3857)}) RETURNING id`,
        [p.name, p.departure ?? null, p.length_km ?? null, p.lanes ?? null, geometryText(f.geometry)],
      );
      return (rows[0] as { id: number }).id;
    },
    async update(pool, id, p, geometry, crs) {
      const { rowCount } = await pool.query(
        `UPDATE routes SET name = $1, departure = $2::timestamptz, length_km = $3, lanes = $4,
         geom = coalesce(${fromGeoJson("$5", crs, 3857)}, geom) WHERE id = $6`,
        [p.name, p.departure ?? null, p.length_km ?? null, p.lanes ?? null, geometryText(geometry), id],
      );
      return (rowCount ?? 0) > 0;
    },
    async remove(pool, id) {
      return ((await pool.query("DELETE FROM routes WHERE id = $1", [id])).rowCount ?? 0) > 0;
    },
  },
};

/** 415 unless the body's media type is one of `types`. */
function checkMediaType(req: Request, types: string[]): void {
  if (!req.is(types)) {
    throw new OgcError(
      415,
      "UnsupportedMediaType",
      `The body must be ${types.join(" or ")} (Content-Type: ${req.get("content-type") ?? "none"})`,
    );
  }
}

function collectionOf(req: Request): Collection & { writer: Writer } {
  const c = collectionById(String(req.params.collectionId));
  const writer = c ? WRITERS[c.id] : undefined;
  if (!c || !writer) throw notFound(`No collection "${req.params.collectionId}"`);
  return { ...c, writer };
}

/** The feature id of the path (SERIAL), or a 404. */
function idOf(req: Request, c: Collection): number {
  const id = String(req.params.featureId);
  if (!/^\d{1,10}$/.test(id) || Number(id) > 2147483647) throw notFound(`No feature "${id}" in collection "${c.id}"`);
  return Number(id);
}

const FEATURE_TYPES = ["application/geo+json", "application/json"];

/**
 * Part 4, Create, Replace, Update, Delete: POST on `/items`, PUT / PATCH / DELETE on `/items/{featureId}`. Bodies are
 * checked against `/schema`; success answers 201 with `Location` (POST) or 204, with no body.
 */
export function writesRouter(pool: Pool): Router {
  const router = Router();
  // application/json is parsed by the app already (the REST API's parser); these two only here.
  router.use(express.json({ type: ["application/geo+json", "application/merge-patch+json"] }));

  router.post(
    "/collections/:collectionId/items",
    ogc(async (req, res) => {
      const c = collectionOf(req);
      checkParams(req, []);
      checkMediaType(req, FEATURE_TYPES);
      const id = await c.writer.insert(pool, readFeature(c, req.body), contentCrs(req));
      res
        .status(201)
        .location(url(req, `/collections/${c.id}/items/${id}`))
        .end();
    }),
  );

  router.put(
    "/collections/:collectionId/items/:featureId",
    ogc(async (req, res) => {
      const c = collectionOf(req);
      const id = idOf(req, c);
      checkParams(req, []);
      checkMediaType(req, FEATURE_TYPES);
      const crs = contentCrs(req);
      // An "id" in the body is ignored (Part 4 Req 45): the path names the feature.
      const f = readFeature(c, req.body);
      if (!(await c.writer.update(pool, id, f.properties, f.geometry, crs)))
        throw notFound(`No feature "${id}" in collection "${c.id}"`);
      res.status(204).end();
    }),
  );

  router.patch(
    "/collections/:collectionId/items/:featureId",
    ogc(async (req, res) => {
      const c = collectionOf(req);
      const id = idOf(req, c);
      checkParams(req, []);
      checkMediaType(req, ["application/merge-patch+json"]);
      const crs = contentCrs(req);
      const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
        `SELECT ${c.properties} AS properties FROM ${c.source} WHERE f.id = $1`,
        [id],
      );
      const current = rows[0];
      if (!current) throw notFound(`No feature "${id}" in collection "${c.id}"`);
      const patched = applyPatch(c, id, current.properties, req.body);
      if (!(await c.writer.update(pool, id, patched.properties, patched.geometry, crs)))
        throw notFound(`No feature "${id}" in collection "${c.id}"`);
      res.status(204).end();
    }),
  );

  router.delete(
    "/collections/:collectionId/items/:featureId",
    ogc(async (req, res) => {
      const c = collectionOf(req);
      const id = idOf(req, c);
      checkParams(req, []);
      if (!(await c.writer.remove(pool, id))) throw notFound(`No feature "${id}" in collection "${c.id}"`);
      res.status(204).end();
    }),
  );

  return router;
}

/** The methods each OGC API resource takes (`Allow`; Part 4 Req 1, 15, 16). */
export const ALLOW = {
  items: "GET, HEAD, POST, OPTIONS",
  item: "GET, HEAD, PUT, PATCH, DELETE, OPTIONS",
  read: "GET, HEAD, OPTIONS",
} as const;

const RESOURCES: [string, keyof typeof ALLOW][] = [
  ["/collections/:collectionId/items", "items"],
  ["/collections/:collectionId/items/:featureId", "item"],
  ["/", "read"],
  ["/api", "read"],
  ["/api.html", "read"],
  ["/collections", "read"],
  ["/collections/:collectionId", "read"],
  ["/collections/:collectionId/queryables", "read"],
  ["/collections/:collectionId/schema", "read"],
];

/**
 * OPTIONS on each OGC API resource: 200 with `Allow` (Part 4 Req 16), the CORS headers as for every route. Mounted
 * before the app's CORS middleware, which answers OPTIONS 204 on the REST API, as before.
 */
export function optionsRouter(corsMiddleware: express.RequestHandler): Router {
  const router = Router();
  for (const [path, kind] of RESOURCES) {
    router.options(path, (req, res, next) => {
      if (req.params.collectionId !== undefined && !collectionById(String(req.params.collectionId))) {
        return sendError(req, res, notFound(`No collection "${req.params.collectionId}"`), false);
      }
      res.setHeader("Allow", ALLOW[kind]);
      return corsMiddleware(req, res, next);
    });
  }
  return router;
}

/** 405 with `Allow` for a method an OGC API resource doesn't take. Mounted after every OGC API route. */
export function methodNotAllowedRouter(): Router {
  const router = Router();
  for (const [path, kind] of RESOURCES) {
    router.all(path, (req, res) => {
      res.setHeader("Allow", ALLOW[kind]);
      sendError(
        req,
        res,
        new OgcError(405, "MethodNotAllowed", `${req.method} isn't allowed here: ${ALLOW[kind]}`),
        false,
      );
    });
  }
  return router;
}

/**
 * A body the JSON parser couldn't read, on an OGC API path: a 400 as an OGC exception. Elsewhere (the REST API), the
 * error goes on to Express's own answer, as before.
 */
export function ogcBodyErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; status?: number; message?: string };
  if (!req.path.startsWith("/collections")) {
    next(err);
  } else if (e.type === "entity.parse.failed") {
    sendError(req, res, invalidBody("The body isn't valid JSON"), false);
  } else if (e.status && e.status < 500) {
    sendError(req, res, new OgcError(e.status, "InvalidRequest", e.message ?? "Invalid request"), false);
  } else {
    next(err);
  }
}
