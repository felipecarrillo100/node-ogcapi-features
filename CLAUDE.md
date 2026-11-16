# testSpatialRestApi

A small PostGIS-backed server (Express + `pg`) that MapEvolution (`~/hackaton/MapEvolution`, the owner's LuciadRIA
utility library and its demos) uses to test its sources and its Filter panel against a real backend. It compiles
server filters to SQL with **ogc-cql2** (`toSql`, postgres dialect), the same package that evaluates filters on the
map. So the server's answers must equal the map's own (`evaluate`), always.

**The current task is in `OGC-API-TASK.md`: turn this server into a real OGC API Features server, with Swagger UI.
Read it before doing anything.**

## What is here

| File | What |
|---|---|
| `server.js` | All routes. `QUERYABLES` (with `sqlType` / `column` for `toSql`), `CONFORMS_TO`, the jsonb/native list handling |
| `schema.sql` | Tables: `features` (id, `properties` jsonb, `geom` geometry 4326, native lists `tags text[]`, `floors integer[]`, `visits date[]`), `feature_details`, `tile_feature_maintenance` |
| `seed-lists.sql` | List values on the seed rows, edge cases on purpose (empty list, repeat, missing); the GIN index on `cql2_text_array(tags)` |
| `README.md` | The API as it is, with curl examples |

Database: `spatial_rest_test` on localhost:5432, user/password `postgres` (Postgres.app). Port: **8020** (`npm start`).
This folder is **not a git repository**. Before changing anything, ask the owner whether to `git init` it (and
commit the current state), or keep a copy of every file you change outside this folder.

## Who uses it (do not break)

MapEvolution's REST test layer (`spatial-test-postgis`, `SpatialTestStoreAdapter.ts` in demo-react and demo-vue) and
its e2e spec `demo-react/e2e/specs/95-filters.spec.ts`. They call:
- `GET /features` with `bbox=` and `filter=<CQL2-JSON>`, and `GET/POST/PUT/DELETE /features[/:id]`;
- `GET /conformance`, which must keep listing these CQL2 class URIs: basic-cql2, advanced-comparison-operators,
  case-insensitive-comparison, accent-insensitive-comparison, property-property, array-functions,
  basic-spatial-functions, basic-spatial-functions-plus, spatial-functions, first and in this order. Since
  2026-11-16 (the owner's decision) also temporal-functions and arithmetic, then the OGC API classes;
- `GET /features/queryables` (OGC Part 3 form);
- `GET/PUT /features/:id/details`, `GET/PUT /tile-features/:id/maintenance`.

These routes stay as they are (the owner's decision, 2026-11-16). MapEvolution's `FlexibleRestStore` exists for REST
APIs that aren't OGC API, and this server is its only test target.

## How to work with this owner

- **Plan first, in plan mode, and wait for approval.** A big task gets a Phases table; stop after each phase for the
  owner to test. Re-plan even small amendments; chat agreement is not plan approval.
- **Do only what's asked.** Ask before adding anything, even small or obviously useful.
- **Standards first:** follow the OGC specification exactly; research it, and how others (ldproxy, pygeoapi) do it,
  before deciding. Compatibility tweaks come second, and only for a named client.
- **Never touch other projects:** not MapEvolution, not `~/git/ogc-cql2` (the owner's package, used from npm as is).
  A gap in ogc-cql2: describe it to the owner. Never patch it in `node_modules`. A bug in a third-party server: one
  line in your report, no issue filed.
- **Throw-away tools** (test suites in Docker, validators, check scripts) live in your session scratchpad, never in
  this folder.
- **Verify live, heavily:** every phase ends with real requests against the running server and their answers
  compared, not just "it starts".
- **Report faithfully:** what passed, what failed, with the output, and what you didn't check.
- Never commit (if git is set up) without being asked; never push.
- Plain words in reports; tables where they help. No hint text under fields, no unasked visual defaults (Swagger UI:
  stock look).
