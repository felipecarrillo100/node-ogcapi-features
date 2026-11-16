# node-ogcapi-features

A lightweight, standards-compliant OGC API - Features server implementation for Node.js, with a plain REST API beside
it on the same PostGIS data:

- the **REST API** (`/features…`, below), which `FlexibleRestStore` (`@mapevolution/ria`) and its e2e tests use;
- an **OGC API Features** server (`/`, `/collections…`), described by an OpenAPI 3.0 document (`/api`, shown in
  Swagger UI at `/api.html`), every resource also as an HTML page with a map.

Point / LineString / Polygon, GeoJSON in and out. Filters are compiled to SQL with
[`ogc-cql2`](https://www.npmjs.com/package/ogc-cql2), the package that evaluates them on the map.

## Requirements

| What | Minimum | Tested with | Why |
|---|---|---|---|
| Node.js | 24 | 24.15.0 | runs the TypeScript in `src/` directly (`npm run dev`); `package.json` `engines` |
| npm | comes with Node | 12.0.1 | installs and runs the scripts |
| PostgreSQL | 13 | 17.10 (Postgres.app) | the tests drop their database with `DROP DATABASE … WITH (FORCE)` (13+) |
| PostGIS | 3 (only 3.5.6 tested) | 3.5.6 | the `geometry` column, `ST_*` functions, the GiST index (`schema.sql`: `CREATE EXTENSION postgis`) |

Everything else (Express, pg, ogc-cql2, TypeScript, Biome, Vitest) is installed by `npm install`.

Defaults: Postgres on localhost:5432, user and password `postgres`, database `spatial_rest_test`; the server on port
8020. The database user must be able to:
- create functions in `public`: at every start the server creates or replaces ogc-cql2's `cql2_*` functions;
- create and drop databases, for the tests only (`spatial_rest_test_vitest`).

## Setup

```bash
# One-time: create the DB, the schema and the base rows (already done for this environment)
PGPASSWORD=postgres createdb -h localhost -U postgres spatial_rest_test
PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f schema.sql
PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed.sql

npm install
npm start   # builds to dist/, then listens on http://localhost:8020

# Lists on the seed rows (after the first start: its GIN index uses ogc-cql2's cql2_text_array). Safe to run again.
PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed-lists.sql

# The routes collection's lines (the routes table is in schema.sql). Safe to run again.
PGPASSWORD=postgres psql -h localhost -U postgres -d spatial_rest_test -f seed-routes.sql
```

`PORT` and `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` override the defaults above.

## Development

TypeScript in `src/`. In development Node runs it as is (Node's own type stripping); for production `tsc` compiles it to
`dist/`.

| Script | Does |
|---|---|
| `npm run dev` | runs `src/server.ts`, restarting on every change |
| `npm run build` | compiles `src/` to `dist/` (TypeScript 7) |
| `npm start` | builds, then runs `dist/server.js` |
| `npm run typecheck` | type-checks `src/` and `test/` |
| `npm run lint` / `npm run format` | Biome: checks / fixes formatting, lint and import order |
| `npm test` / `npm run test:watch` | Vitest, once / on every change |
| `npm run test:coverage` | Vitest with a coverage report (`coverage/`) |
| `npm run check` | typecheck, lint and tests |

The tests (`test/`) start the app against their own database, `spatial_rest_test_vitest`, which each run drops and
rebuilds from `schema.sql`, `seed.sql`, `seed-lists.sql` and `seed-routes.sql` on the same Postgres. The dev database is
never touched.

## Properties and lists

Every property is served inside the feature's `properties`. The queryables (`src/features/storage.ts` `QUERYABLES`):

| Property | Kind | Stored as |
|---|---|---|
| `name` | text | in the `properties` jsonb |
| `services`, `zones`, `inspections` | lists of text, integers, dates | in the `properties` jsonb, as JSON arrays |
| `tags`, `floors`, `visits` | lists of text, integers, dates | native columns `text[]`, `integer[]`, `date[]` (GIN index on `tags`) |
| `geometry` | the geometry | the `geom` column (PostGIS, SRID 4326, GiST index) |

The two storages are there on purpose: ogc-cql2's `toSql` has a path for each. POST and PUT write `tags`, `floors` and
`visits` to their columns (absent: NULL; not a list: 400) and everything else to the jsonb. A NULL column is absent
from the served properties, as a missing property is.

## REST API

- `GET /features` — all features as a GeoJSON `FeatureCollection`
- `GET /features?bbox=minx,miny,maxx,maxy` — filtered via PostGIS's `&&` bounding-box operator
- `GET /features?filter=<CQL2-JSON>` — a server filter in CQL2-JSON (OGC 21-065r2), compiled to SQL by
  [`ogc-cql2`](https://www.npmjs.com/package/ogc-cql2)'s `toSql` (postgres dialect). Only the properties in
  `QUERYABLES` can be filtered on; any other answers 400 with the reason (`code`, `path`). Combines with `bbox` by AND.
  At startup the server creates (or replaces) ogc-cql2's `cql2_*` SQL functions in `public`, which CASEI, ACCENTI and
  dates need.
- `GET /features/queryables` — the filterable properties, as OGC API Features Part 3 queryables (`type`, `items`,
  `format`; the SQL-only keys left out)
- `GET /conformance` — the CQL2 classes a filter may use, as OGC API's `{ "conformsTo": [...] }`: basic CQL2, advanced
  comparison operators, case-insensitive and accent-insensitive comparison, property-property comparisons, array
  functions, and the three spatial classes (basic spatial functions, with plus, and spatial functions). Not temporal
  functions nor arithmetic. A filter needing another class answers 400 with `code: "needs-conformance"`. The same
  resource serves the OGC API: after these 9 CQL2 classes (always first, in this order) come the OGC API classes
  (below). A request with an unknown query parameter answers 400 there.
- `GET /features/:id`, `POST /features`, `PUT /features/:id`, `DELETE /features/:id` — standard
  GeoJSON-Feature-in/out CRUD, `id` assigned by the database (`SERIAL`)

## Example

```bash
curl -s -X POST http://localhost:8020/features -H "Content-Type: application/json" -d '{
  "type": "Feature",
  "properties": { "name": "test point" },
  "geometry": { "type": "Point", "coordinates": [4.4, 50.8] }
}'

curl -s "http://localhost:8020/features?bbox=4,50,5,51"

# Names starting with "b", any case: {"op":"like","args":[{"op":"casei","args":[{"property":"name"}]},{"op":"casei","args":["b%"]}]}
curl -s "http://localhost:8020/features?filter=%7B%22op%22%3A%22like%22%2C%22args%22%3A%5B%7B%22op%22%3A%22casei%22%2C%22args%22%3A%5B%7B%22property%22%3A%22name%22%7D%5D%7D%2C%7B%22op%22%3A%22casei%22%2C%22args%22%3A%5B%22b%25%22%5D%7D%5D%7D"

# A list: services has both lift and toilets (Brussels, Cairo)
curl -s -G http://localhost:8020/features --data-urlencode 'filter={"op":"a_contains","args":[{"property":"services"},["lift","toilets"]]}'

# A native date list and a box: visited on 2024-06-01, inside Europe (Brussels)
curl -s -G http://localhost:8020/features --data-urlencode 'filter={"op":"and","args":[{"op":"a_overlaps","args":[{"property":"visits"},[{"date":"2024-06-01"}]]},{"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[-10,35,30,60]}]}]}'
```

## OGC API Features

Beside the REST API, on the same server. Implemented so far: **Part 1 Core** (OGC 17-069r4, 1.0.1), with the GeoJSON,
HTML and OpenAPI 3.0 classes. Filtering (Part 3), schemas (Part 5), editing (Part 4) and CRS (Part 2) follow
(`OGC-API-TASK.md`, `CHANGELOG.md`).

| Path | What |
|---|---|
| `/` | Landing page: links to the API definition, its documentation, the conformance classes and the collections |
| `/api` | The OpenAPI 3.0 document (`application/vnd.oai.openapi+json;version=3.0`), generated from the collections config |
| `/api.html` | Swagger UI on `/api` (also `/api?f=html`) |
| `/conformance` | The conformance classes (shared with the REST API, above) |
| `/collections` | The collections, with their extent (spatial, and temporal when they have an instant) |
| `/collections/{id}` | One collection |
| `/collections/{id}/items` | Its features: `limit` (default 10, at most 10000), `offset`, `bbox`, `datetime` |
| `/collections/{id}/items/{featureId}` | One feature |

Every resource is JSON (features: `application/geo+json`) or HTML: `f=json` / `f=html`, else the `Accept` header (JSON
unless HTML is preferred). Each links its other format (`alternate`). The HTML pages show a map (MapLibre GL JS,
OpenStreetMap tiles): the page's features, a feature, or a collection's extent.

The collections (`src/ogc/collections.ts`):

| Collection | Table | Geometry | Properties |
|---|---|---|---|
| `features` | `features`, as the REST API serves it | Point / LineString / Polygon, stored in EPSG:4326 | as above (jsonb and native lists) |
| `routes` | `routes` (`seed-routes.sql`) | LineString, stored in **EPSG:3857** | `name`, `departure` (instant, UTC), `length_km`, `lanes`; a NULL one is absent |

The rules, as Part 1 sets them:
- an unknown or repeated query parameter, or an invalid value, answers 400 as an OGC exception (`{ code, description }`);
- a missing collection or feature answers 404;
- `limit` above 10000 is 10000 (not an error);
- paging is by `offset`, in id order, with `next` and `prev` links; `numberMatched`, `numberReturned` and `timeStamp`
  on every page;
- `bbox` takes 4 or 6 numbers (heights ignored), CRS84, and selects the features that intersect it. West above east
  crosses the antimeridian;
- `datetime` takes an instant or an interval (`..` or empty for an open end), and a date stands for its whole day (UTC).
  On `routes` it selects by `departure` (a feature without one never matches). `features` has no instant: there
  `datetime` selects every feature.

```bash
curl -s "http://localhost:8020/collections/routes/items?bbox=4,50,5,51&datetime=2024-05-01/2024-06-30&limit=2"
open "http://localhost:8020/collections/routes/items?f=html"   # the HTML page, with the map
open "http://localhost:8020/api.html"                          # Swagger UI
```

Validated with OGC's official test suite, TEAM Engine `ets-ogcapi-features10` 1.9 (Docker image
`ogccite/ets-ogcapi-features10`), run headless against `http://host.docker.internal:8020/`.
