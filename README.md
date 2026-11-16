# node-ogcapi-features

A lightweight, standards-compliant OGC API - Features server implementation for Node.js, with a plain REST API beside
it on the same PostGIS data:

- the **REST API** (`/restapi/…`, below), which `FlexibleRestStore` (`@mapevolution/ria`) and its e2e tests use;
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

Everything under `/restapi`, one set of routes per table:

| Path | What |
|---|---|
| `/restapi/features…` | the `features` table (points, lines, polygons, with jsonb and native lists) |
| `/restapi/routes…` | the `routes` table (lines stored in EPSG:3857, served in CRS84) |
| `/restapi/features/:id/details` | `GET` / `PUT`: data kept apart from the feature (`feature_details`) |
| `/restapi/tile-features/:id/maintenance` | `GET` / `PUT`: maintenance records (`tile_feature_maintenance`) |
| `/restapi/conformance` | the CQL2 classes a filter may use |

The same operations on `features` and `routes`:
- `GET /restapi/features` — all features as a GeoJSON `FeatureCollection`
- `GET /restapi/features?bbox=minx,miny,maxx,maxy` — filtered via PostGIS's `&&` bounding-box operator
- `GET /restapi/features?filter=<CQL2-JSON>` — a server filter in CQL2-JSON (OGC 21-065r2), compiled to SQL by
  [`ogc-cql2`](https://www.npmjs.com/package/ogc-cql2)'s `toSql` (postgres dialect). Only the properties in
  `QUERYABLES` can be filtered on; any other answers 400 with the reason (`code`, `path`). Combines with `bbox` by AND.
  At startup the server creates (or replaces) ogc-cql2's `cql2_*` SQL functions in `public`, which CASEI, ACCENTI and
  dates need.
- `GET /restapi/features/queryables` — the filterable properties, as OGC API Features Part 3 queryables (`type`,
  `items`, `format`; the SQL-only keys left out)
- `GET /restapi/features/:id`, `POST /restapi/features`, `PUT /restapi/features/:id`, `DELETE /restapi/features/:id` —
  standard GeoJSON-Feature-in/out CRUD, `id` assigned by the database (`SERIAL`)

`/restapi/routes` differs only where its table does:
- it serves exactly what the OGC API's `routes` collection serves: the geometry in CRS84, and `departure` with
  milliseconds (`2024-05-01T08:00:00.000Z`). `bbox` and filters compare that served geometry;
- a filter is first checked by ogc-cql2's `validate` against the queryables (`name`, `departure`, `length_km`,
  `lanes`, `geometry`), so a filter that doesn't fit them, a number against a string say, answers 400 with every
  problem;
- `POST` and `PUT` take `{ "properties": …, "geometry": … }` in CRS84. The body is checked against the collection's
  schema: `name` required, the types, no other property, a LineString only. A failure answers 400 `{ "error" }`.

`GET /restapi/conformance` gives `{ "conformsTo": [...] }`: basic CQL2, advanced comparison operators,
case-insensitive and accent-insensitive comparison, property-property comparisons, array functions, and the three
spatial classes (basic spatial functions, with plus, and spatial functions), always first and in this order; then
temporal functions and arithmetic. Every CQL2 class but Functions is declared: a custom function answers 400
(`code: "invalid-filter"`). The OGC API has its own `/conformance` (below).

## Example

```bash
curl -s -X POST http://localhost:8020/restapi/features -H "Content-Type: application/json" -d '{
  "type": "Feature",
  "properties": { "name": "test point" },
  "geometry": { "type": "Point", "coordinates": [4.4, 50.8] }
}'

curl -s "http://localhost:8020/restapi/features?bbox=4,50,5,51"

# Names starting with "b", any case: {"op":"like","args":[{"op":"casei","args":[{"property":"name"}]},{"op":"casei","args":["b%"]}]}
curl -s "http://localhost:8020/restapi/features?filter=%7B%22op%22%3A%22like%22%2C%22args%22%3A%5B%7B%22op%22%3A%22casei%22%2C%22args%22%3A%5B%7B%22property%22%3A%22name%22%7D%5D%7D%2C%7B%22op%22%3A%22casei%22%2C%22args%22%3A%5B%22b%25%22%5D%7D%5D%7D"

# A list: services has both lift and toilets (Brussels, Cairo)
curl -s -G http://localhost:8020/restapi/features --data-urlencode 'filter={"op":"a_contains","args":[{"property":"services"},["lift","toilets"]]}'

# A native date list and a box: visited on 2024-06-01, inside Europe (Brussels)
curl -s -G http://localhost:8020/restapi/features --data-urlencode 'filter={"op":"and","args":[{"op":"a_overlaps","args":[{"property":"visits"},[{"date":"2024-06-01"}]]},{"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[-10,35,30,60]}]}]}'

# Routes with at least 2 lanes, around Brussels
curl -s -G http://localhost:8020/restapi/routes --data-urlencode 'bbox=4,50,5,51' --data-urlencode 'filter={"op":">=","args":[{"property":"lanes"},2]}'
```

## OGC API Features

Beside the REST API, on the same server. Implemented so far:
- **Part 1 Core** (OGC 17-069r4, 1.0.1), with the GeoJSON, HTML and OpenAPI 3.0 classes;
- **Part 3 Filtering** (OGC 19-079r2) with **CQL2** (OGC 21-065r2), in CQL2-text and CQL2-JSON;
- **Part 5 Schemas** (OGC 23-058r2): the queryables and the schema of each collection;
- **Part 4 Create, Replace, Update, Delete** (OGC 20-002r1, still a draft): editing, without optimistic locking;
- **Part 2 CRS by Reference** (OGC 18-058r1, 1.0.1): CRS84, EPSG:4326 and EPSG:3857, in answers, boxes, filters and
  bodies.

| Path | What |
|---|---|
| `/` | Landing page: links to the API definition, its documentation, the conformance classes and the collections |
| `/api` | The OpenAPI 3.0 document (`application/vnd.oai.openapi+json;version=3.0`), generated from the collections config |
| `/api.html` | Swagger UI on `/api` (also `/api?f=html`) |
| `/conformance` | The conformance classes: the CQL2 ones first, then the OGC API ones (the REST API has its own, above) |
| `/collections` | The collections, with their extent (spatial, and temporal when they have an instant) |
| `/collections/{id}` | One collection |
| `/collections/{id}/items` | Its features: `limit` (default 10, at most 10000), `offset`, `bbox`, `datetime`, `filter` (with `filter-lang`, `filter-crs`), and each simple queryable (`?name=…`) |
| `/collections/{id}/items/{featureId}` | One feature |
| `/collections/{id}/queryables` | What a filter may use (`application/schema+json`); any other property is refused |
| `/collections/{id}/schema` | The features' schema, what is served and what may be sent (Part 5's "returnables and receivables") |

Every resource is JSON (features: `application/geo+json`) or HTML: `f=json` / `f=html`, else the `Accept` header (JSON
unless HTML is preferred). Each links its other format (`alternate`). The HTML pages show a map (MapLibre GL JS,
OpenStreetMap tiles): the page's features, a feature, or a collection's extent. The items page also has:
- a **Limit** choice (10, 100, 1000, 10000), which keeps the page's other parameters and goes back to the first page;
- a **table** with one column per property (lists as their values, `[]` for an empty list, an empty cell for a missing
  property), which scrolls both ways when it doesn't fit.

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
- `bbox` takes 4 or 6 numbers, CRS84, and selects the features that intersect it. West above east crosses the
  antimeridian. It is compiled by ogc-cql2 as `S_INTERSECTS(geometry, BBOX(…))`, the map's own test: PostGIS's
  `ST_Intersects` can miss a point on an edge on arm64 (ogc-cql2's PostgreSQL guide);
- `datetime` takes an instant or an interval (`..` or empty for an open end), and a date stands for its whole day (UTC,
  its first to its last millisecond). It is compiled as `T_INTERSECTS(departure, …)`, compared to the millisecond.
  On `routes` it selects by `departure` (a feature without one never matches). `features` has no instant: there
  `datetime` selects every feature;
- the served values are what ogc-cql2's `postgresValue` SELECTs, so they are exactly what the SQL compares: instants in
  UTC with milliseconds (`2024-05-01T08:00:00.000Z`), numbers as double precision, native lists element by element.

Filtering (Part 3):
- `filter` is CQL2-text by default (`filter-lang=cql2-text`), or CQL2-JSON (`filter-lang=cql2-json`). It is read with
  ogc-cql2 (`fromText` for text) and compiled with its `toSql`, as the REST API does, on the collection's queryables;
- the declared CQL2 classes are every class but Functions: Basic, Advanced Comparison, Case- and Accent-insensitive,
  Property-Property, Array, the three Spatial classes, Temporal Functions and Arithmetic;
- `filter-crs` names the CRS of the filter's geometries (see CRS below);
- each queryable with a simple value (not a list, an instant or the geometry) is also a query parameter selecting by
  equality: `?name=Brussels`, `?lanes=2`;
- everything combines with `bbox` and `datetime` by AND;
- spatial filters and `bbox` compare **the geometry as served** (CRS84, 9 decimals), so the answer is what a client
  evaluating the served features selects. `routes`, stored in EPSG:3857, is served as `4.4 50.8`, not as the
  transform's `4.399999999999999 50.800000000000004`.

Every filter in the tests (`test/ogc-filter.test.ts`) is checked against ogc-cql2's `evaluate` on the served features:
the server selects exactly what the map selects. That includes the cases where ldproxy 4.8.2 fails: `NOT A_OVERLAPS` /
`NOT A_CONTAINS` on a missing property, `A_EQUALS` with a repeated value, an empty list, list against list, `DATE()` in
a list in CQL2-text, `CASEI` in CQL2-JSON.

Editing (Part 4), on both collections:

| Request | Answer |
|---|---|
| `POST /collections/{id}/items`, a GeoJSON Feature (`application/geo+json` or `application/json`) | 201, `Location` of the new feature, no body; the id is the database's |
| `PUT …/items/{featureId}`, the whole feature | 204; properties left out are removed; an `id` in the body is ignored; an unknown id is a 404 (no create-on-PUT) |
| `PATCH …/items/{featureId}`, `application/merge-patch+json` | 204. RFC 7396 on the feature as `/schema` describes it, flat (`{"lanes": 3}`), or GeoJSON-shaped (`{"properties": {…}}`). `null` unsets; a geometry replaces the geometry; the id can't change |
| `DELETE …/items/{featureId}` | 204; an unknown id is a 404 |
| `OPTIONS` on any OGC API resource | 200 with `Allow` (a method a resource doesn't take: 405 with `Allow`) |

- Every body is checked against the collection's `/schema`. A property of the wrong type (dates are real calendar
  days), the read-only `id`, an unknown property on `routes` (closed), a missing `name` on `routes`, or a geometry of
  another type (`routes` takes LineStrings) answers 400 (`InvalidRequestBody`).
- `features` takes any other property (into the jsonb). Its native lists go to their columns, as the REST API writes
  them.
- A `null` property is no value. Another media type answers 415. The body's geometry is read in the CRS its
  `Content-Crs` header names (CRS below).

```bash
curl -s "http://localhost:8020/collections/routes/items?bbox=4,50,5,51&datetime=2024-05-01/2024-06-30&limit=2"
curl -s -G http://localhost:8020/collections/routes/items --data-urlencode "filter=T_AFTER(departure, TIMESTAMP('2024-06-01T00:00:00Z')) AND lanes >= 2"
curl -s -G http://localhost:8020/collections/features/items --data-urlencode "filter=NOT A_OVERLAPS(tags, ('museum'))"
curl -s "http://localhost:8020/collections/routes/queryables"
curl -s -i -X POST http://localhost:8020/collections/routes/items -H "Content-Type: application/geo+json" \
  -d '{"type":"Feature","properties":{"name":"Paris–Lyon","lanes":2},"geometry":{"type":"LineString","coordinates":[[2.35,48.86],[4.83,45.76]]}}'
# …/items/<id>: the Location the POST answered
curl -s -X PATCH "http://localhost:8020/collections/routes/items/<id>" -H "Content-Type: application/merge-patch+json" -d '{"lanes":3}'
open "http://localhost:8020/collections/routes/items?f=html"   # the HTML page, with the map
open "http://localhost:8020/api.html"                          # Swagger UI
```

CRS (Part 2), the same on both collections:

| CRS | URI | Axes |
|---|---|---|
| CRS84 (the default) | `http://www.opengis.net/def/crs/OGC/1.3/CRS84` | longitude, latitude |
| EPSG:4326 | `http://www.opengis.net/def/crs/EPSG/0/4326` | **latitude, longitude**, as the CRS defines them |
| EPSG:3857 | `http://www.opengis.net/def/crs/EPSG/0/3857` | x, y in metres (Web Mercator) |

- `/collections` lists them (`crs`); each collection points to that list (`["#/crs"]`) and gives its `storageCrs`
  (`features`: CRS84; `routes`: EPSG:3857). Alone, `/collections/{id}` lists them itself.
- `crs` on `…/items` and `…/items/{featureId}`: the answer's geometries in that CRS, and `Content-Crs: <uri>` on every
  GeoJSON answer. EPSG:3857 of `routes` is the stored geometry itself; EPSG:4326 is CRS84 with its axes swapped.
- `bbox-crs`: `bbox`'s numbers in that CRS (EPSG:4326: minimum latitude, longitude, maximum latitude, longitude).
- `filter-crs`: the filter's geometry and BBOX literals in that CRS, in CQL2-text or CQL2-JSON.
- Both are compiled by ogc-cql2's `toSql` with `literals` (1.7.0): EPSG:4326 swaps its axes; EPSG:3857 is transformed
  to CRS84 by PostGIS. The comparison is then the same as in CRS84, on the served geometry.
- A coordinate outside the CRS's area of use answers 400, because PostGIS would silently wrap it around the world:
  - EPSG:3857: x within ±20037508.34 m, y within ±20048966.1 m;
  - EPSG:4326: latitude within ±90, longitude within ±180.
- A box running backwards (minimum above maximum) crosses the antimeridian in CRS84, and in EPSG:4326 in a filter. In
  EPSG:3857 it answers 400. A `bbox` with `bbox-crs` EPSG:4326 across the antimeridian is refused (400, "its south is
  above its north"): a known bug, see the CHANGELOG.
- `Content-Crs` on POST / PUT / PATCH: the body's geometry is read in that CRS and stored in the column's own. A
  `routes` feature sent in EPSG:3857 is stored exactly as sent.
- An unknown `crs`, `bbox-crs`, `filter-crs` or `Content-Crs` answers 400.
- The HTML page's map always fetches CRS84.

```bash
curl -s "http://localhost:8020/collections/routes/items/1?crs=http://www.opengis.net/def/crs/EPSG/0/3857"
curl -s "http://localhost:8020/collections/features/items?bbox=50,4,51,5&bbox-crs=http://www.opengis.net/def/crs/EPSG/0/4326"

# A CQL2-text filter in EPSG:3857 metres (a box around Belgium)
curl -s -G http://localhost:8020/collections/routes/items --data-urlencode "filter=S_INTERSECTS(geometry, BBOX(445278, 6446276, 556597, 6621294))" \
  --data-urlencode "filter-crs=http://www.opengis.net/def/crs/EPSG/0/3857"
```

Validated with OGC's official test suite, TEAM Engine `ets-ogcapi-features10` 1.9 (Docker image
`ogccite/ets-ogcapi-features10`), run headless against `http://host.docker.internal:8020/`, Parts 1 and 2.
- 260 tests: 248 passed, 10 skipped (fixed boxes with no data), and 2 failed.
- The 2 failures are the suite's: it sends an EPSG:4326 `bbox-crs` box longitude first. Its Proj4J transform ignores
  EPSG:4326's latitude-first axis order, which this server follows, as Part 2 says.
