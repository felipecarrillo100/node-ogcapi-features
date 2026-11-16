-- The base rows (ids 7–14): their names and geometries, as in the dev database on 2026-11-16. The lists on them are in
-- seed-lists.sql, run after this. Idempotent (an existing id is left as it is).
--   PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed.sql
INSERT INTO features (id, properties, geom) VALUES (7, '{"name": "Brussels"}', ST_GeomFromText('POINT(4.4 50.8)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (8, '{"name": "Tokyo"}', ST_GeomFromText('POINT(139.7 35.7)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (9, '{"name": "New York"}', ST_GeomFromText('POINT(-74 40.7)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (10, '{"name": "Sydney"}', ST_GeomFromText('POINT(151.2 -33.9)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (11, '{"name": "Cairo"}', ST_GeomFromText('POINT(31.2 30)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (12, '{"name": "Rio de Janeiro"}', ST_GeomFromText('POINT(-43.2 -22.9)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (13, '{"name": "Europe-Africa line"}', ST_GeomFromText('LINESTRING(4.4 50.8,31.2 30)', 4326)) ON CONFLICT (id) DO NOTHING;
INSERT INTO features (id, properties, geom) VALUES (14, '{"name": "Brussels area polygon"}', ST_GeomFromText('POLYGON((3.5 50.2,5.5 50.2,5.5 51.2,3.5 51.2,3.5 50.2))', 4326)) ON CONFLICT (id) DO NOTHING;
SELECT setval('features_id_seq', GREATEST((SELECT max(id) FROM features), (SELECT last_value FROM features_id_seq)));
