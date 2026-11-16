import { Router } from "express";
import type { Geometry } from "geojson";
import type { Cql2Filter } from "ogc-cql2";
import { type SqlOptions, toSql } from "ogc-cql2/sql";
import { requiredConformance } from "ogc-cql2/validate";
import type { Pool } from "pg";
import { CONFORMS_TO } from "../conformance.ts";
import { body, route } from "../route.ts";
import {
  type FeatureRow,
  FILTERABLE,
  NATIVE_COLUMNS,
  NATIVE_LISTS,
  nativeParams,
  QUERYABLES,
  rowToFeature,
  SELECT_FEATURE,
  splitProperties,
} from "./storage.ts";

// ogc-cql2 1.6.2's `SqlColumn` types `type` as a scalar only, though `toSql` reads `"array"` with `items` (its
// postgres dialect documents jsonb and native lists): the queryables are passed as its columns as they are.
const COLUMNS = QUERYABLES as unknown as SqlOptions["columns"];

interface FeatureBody {
  geometry: Geometry;
  properties: Record<string, unknown> | null;
}

/** GET/POST/PUT/DELETE /features[/:id], /features/queryables. */
export function featuresRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/features",
    route(async (req, res) => {
      const { bbox, filter } = req.query;
      const params: unknown[] = [];
      const conditions: string[] = [];

      if (bbox) {
        const [minx, miny, maxx, maxy] = String(bbox).split(",").map(Number);
        if ([minx, miny, maxx, maxy].some((n) => Number.isNaN(n))) {
          return res.status(400).json({ error: `Invalid bbox "${bbox}" — expected minx,miny,maxx,maxy` });
        }
        params.push(minx, miny, maxx, maxy);
        conditions.push(
          `geom && ST_MakeEnvelope($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, 4326)`,
        );
      }

      if (filter) {
        let parsed: Cql2Filter;
        try {
          // `toSql` validates the filter itself (`invalid-filter`), as before.
          parsed = JSON.parse(String(filter)) as Cql2Filter;
        } catch {
          return res.status(400).json({ error: "Invalid filter: not valid JSON" });
        }
        try {
          // toSql numbers its placeholders from $1: shift them past the bbox's.
          const { where, params: values } = toSql(parsed, { dialect: "postgres", columns: COLUMNS });
          const missing = requiredConformance(parsed).filter((uri) => !CONFORMS_TO.includes(uri));
          if (missing.length) {
            return res.status(400).json({
              error: `Invalid filter: this server doesn't support ${missing.join(", ")}`,
              code: "needs-conformance",
            });
          }
          const offset = params.length;
          conditions.push(`(${where.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + offset}`)})`);
          params.push(...values);
        } catch (e) {
          const err = e as Error & { code?: string; path?: string };
          return res.status(400).json({ error: `Invalid filter: ${err.message}`, code: err.code, path: err.path });
        }
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<FeatureRow>(`SELECT ${SELECT_FEATURE} FROM ${FILTERABLE} ${where}`, params);
      return res.json({ type: "FeatureCollection", features: result.rows.map(rowToFeature) });
    }),
  );

  router.get("/features/queryables", (_req, res) => {
    // The OGC part of each queryable; `sqlType` and `column` are this server's own business.
    const properties = Object.fromEntries(
      Object.entries(QUERYABLES).map(([name, { sqlType: _s, column: _c, ...q }]) => [name, q]),
    );
    res.json({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties });
  });

  router.get(
    "/features/:id",
    route(async (req, res) => {
      const result = await pool.query<FeatureRow>(`SELECT ${SELECT_FEATURE} FROM features WHERE id = $1`, [
        req.params.id,
      ]);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: `Feature ${req.params.id} not found` });
      return res.json(rowToFeature(row));
    }),
  );

  router.post(
    "/features",
    route(async (req, res) => {
      const { geometry, properties } = body<FeatureBody>(req);
      const split = splitProperties(properties ?? {});
      if (!split) return res.status(400).json({ error: `${Object.keys(NATIVE_LISTS).join(", ")} must be lists` });
      const result = await pool.query<FeatureRow>(
        `INSERT INTO features (properties, geom, ${NATIVE_COLUMNS}) VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), ${nativeParams(3)})
       RETURNING ${SELECT_FEATURE}`,
        [split.rest, JSON.stringify(geometry), ...split.lists],
      );
      return res.status(201).json(rowToFeature(result.rows[0] as FeatureRow));
    }),
  );

  router.put(
    "/features/:id",
    route(async (req, res) => {
      const { geometry, properties } = body<FeatureBody>(req);
      const split = splitProperties(properties ?? {});
      if (!split) return res.status(400).json({ error: `${Object.keys(NATIVE_LISTS).join(", ")} must be lists` });
      const result = await pool.query<FeatureRow>(
        `UPDATE features SET properties = $1, geom = ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), (${NATIVE_COLUMNS}) = ROW(${nativeParams(4)})
       WHERE id = $3 RETURNING ${SELECT_FEATURE}`,
        [split.rest, JSON.stringify(geometry), req.params.id, ...split.lists],
      );
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: `Feature ${req.params.id} not found` });
      return res.json(rowToFeature(row));
    }),
  );

  router.delete(
    "/features/:id",
    route(async (req, res) => {
      const result = await pool.query(`DELETE FROM features WHERE id = $1`, [req.params.id]);
      return res.json({ deleted: (result.rowCount ?? 0) > 0 });
    }),
  );

  return router;
}
