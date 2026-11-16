-- List properties on the seed rows, for the Array Functions (A_OVERLAPS, A_CONTAINS, A_CONTAINEDBY, A_EQUALS):
-- `services` (text), `zones` (integers), `inspections` (dates as YYYY-MM-DD). Matched by name; idempotent (`||`
-- replaces the keys it sets). Edge cases on purpose: an empty list (Sydney's services), a repeated value (Cairo's
-- services), and rows without the properties (New York, Rio de Janeiro, the line). Native arrays below.
--   PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed-lists.sql
UPDATE features SET properties = properties || '{"services": ["lift", "toilets", "parking"], "zones": [1, 2], "inspections": ["2024-02-29", "2024-03-01"]}'::jsonb WHERE properties->>'name' = 'Brussels';
UPDATE features SET properties = properties || '{"services": ["lift", "bikes"], "zones": [3], "inspections": ["2024-03-01"]}'::jsonb WHERE properties->>'name' = 'Tokyo';
UPDATE features SET properties = properties || '{"services": [], "zones": [4, 5], "inspections": ["2023-12-31", "2024-01-15"]}'::jsonb WHERE properties->>'name' = 'Sydney';
UPDATE features SET properties = properties || '{"services": ["toilets", "lift", "lift"], "zones": [2], "inspections": ["2024-03-02"]}'::jsonb WHERE properties->>'name' = 'Cairo';
UPDATE features SET properties = properties || '{"services": ["parking"], "zones": [1], "inspections": []}'::jsonb WHERE properties->>'name' = 'Brussels area polygon';

-- The same kinds of list as native arrays (schema.sql's `tags`, `floors`, `visits`), with other values, so a filter on
-- one storage never passes by accident on the other. Edge cases: Tokyo's empty tags, Sydney's repeated tag, NULL
-- (absent) on the rows not named. Run after the server has started once (its `cql2_text_array` serves the index).
UPDATE features SET tags = '{museum,station}', floors = '{0,1,2}', visits = '{2024-05-01,2024-06-01}' WHERE properties->>'name' = 'Brussels';
UPDATE features SET tags = '{}', floors = '{3}', visits = '{2024-05-01}' WHERE properties->>'name' = 'Tokyo';
UPDATE features SET tags = '{harbour,station,station}', floors = '{0}', visits = '{}' WHERE properties->>'name' = 'Sydney';
UPDATE features SET tags = '{museum}', floors = '{1,2}', visits = '{2024-06-01,2024-07-15}' WHERE properties->>'name' = 'New York';
UPDATE features SET tags = '{station,museum}', floors = NULL, visits = '{2024-05-01}' WHERE properties->>'name' = 'Europe-Africa line';
CREATE INDEX IF NOT EXISTS features_tags_gin ON features USING gin (cql2_text_array(tags));
