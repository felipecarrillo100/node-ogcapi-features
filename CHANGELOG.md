# Changelog

All notable changes to this server. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- ogc-cql2's own PostgreSQL rules (its `postgresql.md` / `sql-backends.md` guides), everywhere the OGC API reads or
  compares:
  - `bbox` is `S_INTERSECTS(geometry, BBOX(…))` compiled by `toSql` (`&&` plus `ST_Relate`), not PostGIS's
    `ST_Intersects`, which can miss a point on an edge on arm64. A box across the antimeridian is one literal; 6
    numbers keep their heights;
  - `datetime` is `T_INTERSECTS(departure, …)` compiled by `toSql`, to the millisecond; a date is its first to its
    last millisecond (UTC);
  - the served values are `postgresValue`'s. `departure` gains milliseconds (`2024-05-01T08:00:00.000Z`), and so
    does the temporal extent;
  - every filter (and the queryable parameters, bbox, datetime) is first `validate`d against the declared CQL2
    classes and the collection's queryables, and a 400 lists every problem with its path. New refusals follow
    (`type-mismatch`): an instant against a date (`T_BEFORE(departure, DATE(…))`), a number against a string;
  - tests: points and a line exactly on a box's edge and corner, a departure at .0004 s, and the served values
    against `postgresValue` (137 tests). TEAM Engine and the REST API are as before.
- OGC API Phase 3, 2026-11-16: **Part 4 Create, Replace, Update, Delete** (OGC 20-002r1, a draft), on both
  collections:
  - `POST …/items` (201, `Location`, no body), `PUT` / `PATCH` / `DELETE …/items/{featureId}` (204; 404 for an
    unknown id; no create-on-PUT);
  - PATCH is JSON Merge Patch (`application/merge-patch+json`, RFC 7396) on the feature as `/schema` describes it, flat
    (Req 44), or GeoJSON-shaped. `null` unsets, a geometry replaces, the id can't change; a patch that leaves the
    geometry keeps it exactly as stored;
  - every body is checked against `/schema` (400 `InvalidRequestBody`): types, calendar dates, read-only `id`,
    `routes`' closed properties and required `name`, the column's geometry type. 415 for another media type, 400
    for a `Content-Crs` other than CRS84;
  - `OPTIONS` on every OGC API resource answers 200 with `Allow`; a method a resource doesn't take, 405 with
    `Allow`;
  - `/schema` gets `required` (`routes`: `name`, `geometry`); the OpenAPI document gets the write operations;
    `/conformance` gets `create-replace-delete`, `update`, `features` (Part 4). No optimistic locking (your decision).
- Checks: 129 tests (29 of them for editing); TEAM Engine 214 / 179 passed / 0 failed / 35 skipped, as before; the REST
  API answers as in Phase 2.
- OGC API Phase 2, 2026-11-16: **Part 3 Filtering** (OGC 19-079r2) with CQL2, and **Part 5 Schemas** (OGC 23-058r2):
  - `filter` on `…/items`, in CQL2-text (the default) or CQL2-JSON (`filter-lang`), read and compiled with ogc-cql2,
    as the REST API does; `filter-crs` (CRS84 only until Part 2);
  - each simple queryable as a query parameter (`?name=…`, `?lanes=…`), selecting by equality;
  - `/collections/{id}/queryables` and `/collections/{id}/schema` (JSON Schema 2020-12, with Part 5's `x-ogc-role`
    for the id, the geometry and the instant, and the units), in JSON and HTML, linked from each collection;
  - the OpenAPI document gets the filter parameters, the queryable parameters and the two new paths per collection.
- Spatial filters and `bbox` on the OGC API compare the geometry **as served** (CRS84 GeoJSON, 9 decimals), so the
  server selects what a client evaluating the served features selects. The REST API is unchanged.
- The HTML items page (your requests):
  - a **Limit** form (10, 100, 1000, 10000; plain HTML, it keeps the page's other parameters and drops `offset`);
  - a **table**, one column per property, values as text (lists as "a, b", `[]` for an empty list), in a box that
    scrolls both ways with its header in view.

  A feature's own page formats its values the same way.
- Checks: every test filter is compared with ogc-cql2's `evaluate` on the same served features (100 tests in all),
  including the ldproxy 4.8.2 failures from `OGC-API-TASK.md`. Every served feature fits its `/schema` (ajv).
  TEAM Engine: 214 tests, 179 passed, 0 failed, 35 skipped (as in Phase 1).
- OGC API Phase 1, 2026-11-16: an **OGC API Features** server beside the REST API. It implements Part 1 Core (OGC
  17-069r4, 1.0.1) with GeoJSON, HTML and OpenAPI 3.0:
  - `/`, `/conformance`, `/collections`, `/collections/{id}`, `…/items` (`limit`, `offset`, `bbox`, `datetime`) and
    `…/items/{featureId}`;
  - JSON or HTML on every resource (`f`, or `Accept`), linked to each other;
  - HTML pages with a MapLibre GL JS map on OpenStreetMap tiles;
  - `/api`, the OpenAPI 3.0 document, generated from the collections config, and `/api.html`, Swagger UI (stock,
    served from this server).
- A second collection, `routes`: lines stored in EPSG:3857, with `name`, `departure` (instant), `length_km` and
  `lanes` as real columns. The table is in `schema.sql`; `seed-routes.sql` adds 10 rows.
- Dependencies: `swagger-ui-express` 5.0.1, `maplibre-gl` 6.18.0.
- TEAM Engine (`ets-ogcapi-features10` 1.9): 214 tests, 179 passed, 0 failed, 35 skipped. The skips are the 25 CRS
  tests (Part 2 comes in Phase 4) and 10 bbox tests whose fixed boxes (UK, Ecuador, Bering Strait, the poles) hold
  no data.
- Phase 0, 2026-11-16:
  - tests: Vitest 5 against their own database, `spatial_rest_test_vitest`, rebuilt for each run (31 tests at
    Phase 0; 54 after Phase 1);
  - `seed.sql`: the 8 base rows (Brussels … Brussels area polygon), which until then were only in the dev database;
  - Biome 2.6 for lint and format, and the scripts `dev`, `build`, `typecheck`, `lint`, `format`, `test`,
    `test:watch`, `test:coverage`, `check`;
  - a clean exit on Ctrl-C / SIGTERM (closes the database pool), and `.gitignore`;
  - README: Requirements and Development sections.

### Changed
- OGC API Phase 2 (the owner's decision): **Temporal Functions and Arithmetic are declared**, for the REST API too.
  - On `GET /features` a T_* or arithmetic filter now runs. Before, it answered 400 `needs-conformance`.
  - Every CQL2 class but Functions is declared, and a custom function answers 400 `invalid-filter`, so
    `needs-conformance` no longer occurs.
  - `/conformance` adds, after the 9 CQL2 classes (still first, in order): `temporal-functions`, `arithmetic`; Part 3's
    `queryables`, `queryables-query-parameters`, `filter`, `features-filter`; CQL2's `cql2-text`, `cql2-json`; and
    Part 5's `schemas`, `advanced-property-roles`, `returnables-and-receivables`, `queryables`.
  - `CLAUDE.md`'s line on `/conformance` is updated to match.
- The package is renamed `node-ogcapi-features` (was `test-spatial-rest-api`). The landing page, the OpenAPI
  `info.title` and the startup log carry the new name; the folder and the databases keep theirs.
- `package.json` points to the GitHub repository (`repository`, `homepage`, `bugs`):
  https://github.com/felipecarrillo100/node-ogcapi-features. The `.gitignore` leaves out editor files (`.idea/`,
  `.vscode/`), macOS files, logs and `.env` files, besides `node_modules/`, `dist/` and `coverage/`.
- The description (`package.json`, and the README's opening line): "A lightweight, standards-compliant OGC API -
  Features server implementation for Node.js, with a plain REST API beside it on the same PostGIS data."
- OGC API Phase 1: `/conformance` lists the 4 Part 1 classes (`core`, `oas30`, `html`, `geojson`) after the 9 CQL2
  ones, which are unchanged and first.
  - It also answers HTML when asked, and 400 for an unknown query parameter or `f` (Part 1).
  - A request without a query answers as before, plus the 4 URIs.
- Phase 0, 2026-11-16: the server moved from `server.js` to TypeScript in `src/`.
  - The routes and answers are unchanged: the old and new servers answered 52 of 53 requests identically, and the
    53rd (a malformed JSON body) differs only in the stack trace's file paths.
  - Node 24 or later is required. `npm run dev` runs the TypeScript directly; `npm start` builds `dist/`
    (TypeScript 7), then runs it.
  - Express 4 → 5, with Express 4's query parser kept and `req.body` defaulting to `{}`, so requests read as before.
  - The routes are split by concern: `features/`, `conformance.ts`, `details.ts`, `maintenance.ts`, and `ogc/` for
    the OGC API; `app.ts` builds the app and `server.ts` starts it.

### Known
- `bbox` with three numbers isn't refused on the REST API's `GET /features` (200, no features), as before.
- ogc-cql2 1.6.2's `SqlColumn` type rejects `type: "array"`; the queryables are cast (`src/features/routes.ts`).

## [1.0.0]

The server as it was before this log (no date recorded): `server.js`, Express 4, `/features` CRUD with `bbox` and
CQL2-JSON `filter` (ogc-cql2 `toSql`), `/features/queryables`, `/conformance`, details and maintenance.
