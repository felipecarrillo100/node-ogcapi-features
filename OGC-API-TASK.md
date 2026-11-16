# Task: make testSpatialRestApi a real OGC API Features server (with Swagger UI and HTML)

Given by the owner on 2026-11-16. Read `CLAUDE.md` first (what the server is, who uses it, how to work with this
owner). **Start in plan mode:** research, then present a plan with a Phases table for approval; build one phase at
a time and stop after each for the owner to test.

## Why

The server already speaks parts of OGC's language: a `/conformance` in OGC API's form, Part 3 queryables, CQL2-JSON
filters compiled with ogc-cql2, GeoJSON. The owner wants a **real OGC API Features server**:
- self-describing: an OpenAPI document, shown in Swagger UI, and every resource also as an HTML page;
- a reference that answers exactly as the map does (same ogc-cql2), where public servers fall short. ldproxy 4.8.2,
  measured by the owner's team:
  - `NOT A_OVERLAPS` / `NOT A_CONTAINS` also select features without the property (CQL2: NULL → not selected);
  - `A_EQUALS` with a repeated value in the literal selects nothing;
  - `A_CONTAINS(p, ())` (empty list) and list-against-list comparisons hang;
  - `DATE()` inside an array literal fails in CQL2-text;
  - `casei` is refused in CQL2-JSON (HTTP 400).

  Each of these must work here, and they make good test cases.
- a server for testing **editing over OGC API** (Part 4) and **CRS** (Part 2) from MapEvolution's OGC API layer
  (`ria-ogcapi`), which public servers don't offer.

## The owner's decisions (2026-11-16)

| Question | Decision |
|---|---|
| The current routes (`/features…`, `/features/queryables`, details, maintenance) | **Keep them, unchanged.** OGC API is added beside them (see `CLAUDE.md`, "Who uses it") |
| Parts | **Part 1 Core** (with GeoJSON, **HTML** and OpenAPI 3.0), **Part 2 CRS**, **Part 3 Filtering**, **Part 4 Create, Replace, Update, Delete** |
| Collections | **Config-driven, two to start:** the current `features` table, plus a second table with another geometry type and other properties (e.g. lines with a timestamp and a number), seeded |
| Formats | **JSON and HTML on every endpoint**: content negotiation by `Accept` and `f=json` / `f=html`, with `rel=alternate` links |
| Map on the HTML pages | **MapLibre GL JS**, OpenStreetMap raster basemap (details under Part 1) |
| Validation | **OGC TEAM Engine** (the official ETS for OGC API Features, in Docker, throw-away in your scratchpad), plus your own checks where the suite doesn't reach |

## Scope, by part

**Part 1 Core (OGC 17-069r4), with HTML, GeoJSON and OpenAPI 3.0:**
- `/` landing page, `/conformance`, `/api` (OpenAPI 3.0 JSON, `application/vnd.oai.openapi+json;version=3.0`),
  `/api.html` Swagger UI (stock look; served locally, e.g. `swagger-ui-express`, ask before adding a dependency);
- `/collections`, `/collections/{id}`, `/collections/{id}/items` (bbox, limit, next links, `numberMatched` /
  `numberReturned`, `timeStamp`), `/collections/{id}/items/{featureId}`;
- every response: the `links` the standard requires (self, alternate, collection, next, …);
- HTML: plain server-rendered pages, linked to each other and to their JSON.
- **A map on the HTML pages: MapLibre GL JS** (the owner's choice, 2026-11-16: open source, active, renders OGC API
  Tiles / Styles should the server grow them; ldproxy uses it too).
  - Served from this server (npm `maplibre-gl`; ask before adding the dependency), not a CDN.
  - Basemap: OpenStreetMap raster tiles through a small inline style, with the attribution shown ("© OpenStreetMap
    contributors", OSM's tile usage policy).
  - Items page: the page's features (a GeoJSON source), zoomed to fit; a click shows a feature's properties.
    Item page: that feature. Collection page: its extent as a rectangle.
  - The map fetches its features in CRS84 whatever `crs` the page was asked in (Part 2), with the page's own
    filter, bbox and paging, so it shows exactly the features listed.
- **`/conformance` is shared** with the current REST routes: the OGC answer adds the OGC API classes but must keep
  the CQL2 URIs in `CLAUDE.md` exactly (MapEvolution's REST layer reads them). Adding URIs may change what
  MapEvolution's e2e spec 95 sees: tell the owner, who runs it (you don't touch MapEvolution).
- The OpenAPI document should be generated from the same config as the routes (collections, queryables), so it
  can't drift.

**Part 3 Filtering (OGC 19-079r2) and CQL2 (OGC 21-065r2):**
- `filter`, `filter-lang` (`cql2-text` and `cql2-json`), `filter-crs`; `/collections/{id}/queryables` per collection;
- CQL2-text read with ogc-cql2's parser, then `toSql` as today; the CQL2 classes declared are those `toSql` runs
  (today: everything but Temporal Functions and Arithmetic. Check whether they can be added, with a queryable that
  is an instant);
- the current `requiredConformance` check (400 `needs-conformance`) and the `QUERYABLES` refusal stay, per
  collection.

**Part 2 CRS (OGC 18-058r1):** `crs` / `bbox-crs`, at least CRS84, EPSG:4326 and EPSG:3857, via PostGIS
`ST_Transform`; `storageCrs`, `Content-Crs` header, axis order as the standard says.

**Part 4 Create, Replace, Update, Delete (OGC 20-002; check its current status and version first):** POST on items,
PUT / PATCH / DELETE on an item, the status codes and `Location` header it requires. The native lists (`tags`,
`floors`, `visits`) are written to their columns as today.

## What to reuse

- `server.js`: `QUERYABLES` with `sqlType` / `column`, the `FILTERABLE` subquery, `PROPERTIES` (jsonb + native lists
  served together), `splitProperties` for writes, `postgresFunctions` at startup.
- ogc-cql2 (`node_modules/ogc-cql2`, ^1.6.2): its README and the `.d.ts` files of `sql`, `validate`, `text`/`parse`.
  Its postgres dialect docs (in `dist/sql/dialects/postgres.js`) explain jsonb vs native arrays and the GIN index.

## Phases (a suggestion; the plan decides)

| Phase | Content |
|---|---|
| 1 | Collections config; Part 1 Core: landing, conformance, collections, items, item; JSON and HTML; OpenAPI + Swagger UI. TEAM Engine passes Part 1 |
| 2 | Part 3: filter (text and JSON), queryables per collection; the ldproxy cases above as checks |
| 3 | Part 4: create, replace, update, delete |
| 4 | Part 2: CRS |

Every phase: the current routes still answer as before (check them). The owner then tries the server from
MapEvolution's OGC API layer (demo-react: add an OGC API layer at `http://localhost:8020/`).

## Done when

- TEAM Engine's OGC API Features suite passes (report any test it can't run, and why);
- each part's own checks pass, with real requests and answers shown;
- the old routes answer exactly as before;
- `README.md` describes both APIs;
- a short report for the owner: what was built, what was checked and how, and what wasn't.
