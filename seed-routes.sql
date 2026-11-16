-- The `routes` collection (schema.sql): lines between the cities of `features`, written in lon/lat and stored in
-- EPSG:3857. Edge cases on purpose: a NULL departure (Cairo–Tokyo), a NULL lanes (Sydney–Auckland), departures at the
-- same instant (Brussels–Paris and Brussels–Amsterdam), a short line and a very long one. Idempotent (by name);
-- inserted in `seq` order, so on an empty table the ids are 1–10.
--   PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed-routes.sql
INSERT INTO routes (name, departure, length_km, lanes, geom)
SELECT v.name, v.departure::timestamptz, v.length_km, v.lanes, ST_Transform(ST_GeomFromText(v.wkt, 4326), 3857)
FROM (VALUES
  (1, 'Brussels–Paris',      '2024-05-01T08:00:00Z', 264.0,   3,    'LINESTRING(4.4 50.8, 2.35 48.86)'),
  (2, 'Brussels–Amsterdam',  '2024-05-01T08:00:00Z', 173.5,   2,    'LINESTRING(4.4 50.8, 4.9 52.37)'),
  (3, 'Brussels–Cairo',      '2024-05-02T06:30:00Z', 3216.2,  2,    'LINESTRING(4.4 50.8, 12.5 41.9, 31.2 30)'),
  (4, 'Cairo–Tokyo',         NULL,                   9580.0,  1,    'LINESTRING(31.2 30, 77.2 28.6, 139.7 35.7)'),
  (5, 'Tokyo–Sydney',        '2024-06-01T22:15:00Z', 7823.9,  1,    'LINESTRING(139.7 35.7, 151.2 -33.9)'),
  (6, 'Sydney–Auckland',     '2024-06-03T01:00:00Z', 2156.0,  NULL, 'LINESTRING(151.2 -33.9, 174.8 -36.8)'),
  (7, 'New York–Rio',        '2024-07-15T12:00:00Z', 7760.4,  2,    'LINESTRING(-74 40.7, -43.2 -22.9)'),
  (8, 'New York–Boston',     '2024-07-15T13:45:30Z', 306.0,   4,    'LINESTRING(-74 40.7, -71.06 42.36)'),
  (9, 'Rio–Brussels',        '2024-12-31T23:59:59Z', 9150.7,  1,    'LINESTRING(-43.2 -22.9, -9.1 38.7, 4.4 50.8)'),
  (10, 'Brussels ring',       '2025-01-01T00:00:00Z', 75.5,    6,    'LINESTRING(4.3 50.8, 4.4 50.9, 4.5 50.8, 4.4 50.7, 4.3 50.8)')
) AS v(seq, name, departure, length_km, lanes, wkt)
WHERE NOT EXISTS (SELECT 1 FROM routes r WHERE r.name = v.name)
ORDER BY v.seq;
