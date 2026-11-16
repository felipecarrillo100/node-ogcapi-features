-- Minimal schema for testing FlexibleRestStore.spatialQuery's bbox filtering.
-- One table, one mixed-geometry column: Point / LineString / Polygon all fit here,
-- matching the 3 basic GeoJSON geometry types this test is scoped to.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS features (
  id SERIAL PRIMARY KEY,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom GEOMETRY(Geometry, 4326) NOT NULL
);

-- GiST index makes the `&&` bounding-box operator (used by the bbox query) fast.
CREATE INDEX IF NOT EXISTS features_geom_idx ON features USING GIST (geom);

-- One row per feature, holding data unrelated to its geometry/properties — exercised by the
-- demo's "Details" context-menu entry (country name + history), edited and committed separately
-- from the feature itself via /features/:id/details.
CREATE TABLE IF NOT EXISTS feature_details (
  feature_id INTEGER PRIMARY KEY REFERENCES features(id) ON DELETE CASCADE,
  country_name TEXT NOT NULL DEFAULT '',
  history TEXT NOT NULL DEFAULT ''
);

-- Keyed by an OGC 3D Tiles dataset's own batch-table FeatureID — a completely separate id space
-- from `features.id` above, so deliberately no foreign key. Exercised by the "Maintenance"
-- context-menu entry on the outback_PBR_Draco sample tileset.
CREATE TABLE IF NOT EXISTS tile_feature_maintenance (
  feature_id INTEGER PRIMARY KEY,
  assigned_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  last_maintenance_date DATE
);

-- Lists as native PostgreSQL arrays, beside the ones inside `properties` (jsonb): ogc-cql2's toSql has a path for each.
-- Served inside a feature's `properties` (a NULL column is absent); the GIN index on `tags` is in seed-lists.sql, as it
-- needs ogc-cql2's `cql2_text_array`, which the server creates at startup.
ALTER TABLE features ADD COLUMN IF NOT EXISTS tags text[], ADD COLUMN IF NOT EXISTS floors integer[], ADD COLUMN IF NOT EXISTS visits date[];

-- A second collection for the OGC API (/collections/routes): lines between the cities, every property a real column, the
-- geometry stored in EPSG:3857 (so its storage CRS isn't CRS84). Seeded by seed-routes.sql.
CREATE TABLE IF NOT EXISTS routes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  departure TIMESTAMPTZ,
  length_km DOUBLE PRECISION,
  lanes INTEGER,
  geom GEOMETRY(LineString, 3857) NOT NULL
);
CREATE INDEX IF NOT EXISTS routes_geom_idx ON routes USING GIST (geom);
