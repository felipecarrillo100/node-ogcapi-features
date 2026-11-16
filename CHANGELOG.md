# Changelog

All notable changes to this server. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
