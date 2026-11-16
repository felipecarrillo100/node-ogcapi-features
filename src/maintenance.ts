import { Router } from "express";
import type { Pool } from "pg";
import { body, route } from "./route.ts";

interface MaintenanceRow {
  assigned_to: string;
  status: string;
  last_maintenance_date: Date | null;
}

interface MaintenanceBody {
  assignedTo: string;
  status: string;
  lastMaintenanceDate: string | null;
}

/**
 * GET/PUT /tile-features/:id/maintenance, keyed by a 3D Tiles dataset's own FeatureID (the demo's "Maintenance"
 * entry). GET gives defaults when there is no row yet; PUT upserts.
 */
export function maintenanceRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/tile-features/:id/maintenance",
    route(async (req, res) => {
      const result = await pool.query<MaintenanceRow>(
        `SELECT assigned_to, status, last_maintenance_date FROM tile_feature_maintenance WHERE feature_id = $1`,
        [req.params.id],
      );
      const row = result.rows[0] ?? { assigned_to: "", status: "", last_maintenance_date: null };
      res.json({
        featureId: req.params.id,
        assignedTo: row.assigned_to,
        status: row.status,
        lastMaintenanceDate: row.last_maintenance_date,
      });
    }),
  );

  router.put(
    "/tile-features/:id/maintenance",
    route(async (req, res) => {
      const { assignedTo, status, lastMaintenanceDate } = body<MaintenanceBody>(req);
      const result = await pool.query<MaintenanceRow>(
        `INSERT INTO tile_feature_maintenance (feature_id, assigned_to, status, last_maintenance_date) VALUES ($1, $2, $3, $4)
       ON CONFLICT (feature_id) DO UPDATE SET assigned_to = $2, status = $3, last_maintenance_date = $4
       RETURNING assigned_to, status, last_maintenance_date`,
        [req.params.id, assignedTo ?? "", status ?? "", lastMaintenanceDate ?? null],
      );
      const row = result.rows[0] as MaintenanceRow;
      res.json({
        featureId: req.params.id,
        assignedTo: row.assigned_to,
        status: row.status,
        lastMaintenanceDate: row.last_maintenance_date,
      });
    }),
  );

  return router;
}
