import { Router } from "express";
import type { Pool } from "pg";
import { body, route } from "./route.ts";

interface DetailsRow {
  country_name: string;
  history: string;
}

/**
 * GET/PUT /features/:id/details: data unrelated to the feature's geometry and properties (the demo's "Details"
 * entry), edited and saved apart from the feature. GET gives defaults when there is no row yet; PUT upserts.
 */
export function detailsRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/features/:id/details",
    route(async (req, res) => {
      const result = await pool.query<DetailsRow>(
        `SELECT country_name, history FROM feature_details WHERE feature_id = $1`,
        [req.params.id],
      );
      const row = result.rows[0] ?? { country_name: "", history: "" };
      res.json({ featureId: req.params.id, countryName: row.country_name, history: row.history });
    }),
  );

  router.put(
    "/features/:id/details",
    route(async (req, res) => {
      const { countryName, history } = body<{ countryName: string; history: string }>(req);
      const result = await pool.query<DetailsRow>(
        `INSERT INTO feature_details (feature_id, country_name, history) VALUES ($1, $2, $3)
       ON CONFLICT (feature_id) DO UPDATE SET country_name = $2, history = $3
       RETURNING country_name, history`,
        [req.params.id, countryName ?? "", history ?? ""],
      );
      const row = result.rows[0] as DetailsRow;
      res.json({ featureId: req.params.id, countryName: row.country_name, history: row.history });
    }),
  );

  return router;
}
