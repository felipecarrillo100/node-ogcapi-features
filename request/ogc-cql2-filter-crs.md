# Request for ogc-cql2: read filters whose geometries aren't in CRS84 (`filter-crs`)

| | |
|---|---|
| Package | ogc-cql2 1.6.2 (npm) |
| From | node-ogcapi-features, an OGC API Features server built on ogc-cql2 (this repository) |
| Date | 2026-11-16 |
| Kind | Feature request: a missing capability, not a bug in what exists |
| Status | **Addressed in ogc-cql2 1.7.0** (`crs84: false` on `fromText` / `validate`, `literals` on `toSql`). Integrated 2026-11-17: rows 3 and 8 below now answer 200, with routes 1, 2, 3, 9, 10 and routes 4, 5 |

## 1. Description

ogc-cql2 reads every geometry and BBOX literal as **CRS84** (longitude, latitude), and checks its numbers against
CRS84's ranges: longitude within ±180, latitude within ±90. It does this in `fromText`, `validate` and `toSql`, and
none of them takes another CRS.

OGC API Features lets a client send a filter whose geometries are **in another CRS**, named by the `filter-crs`
query parameter, for example a box drawn on a Web Mercator map, in metres. A server built on ogc-cql2 then has two
cases:
- **CQL2-JSON:** the server can walk the filter, convert every literal to CRS84 itself, then call `validate` and
  `toSql`. This works today.
- **CQL2-text:** the server has to call `fromText` first, to get the filter at all, and `fromText` refuses the
  coordinates while it parses. There's no other way to read CQL2-text, so the server can't convert anything.

The result is that `filter-crs` works with CQL2-JSON in any CRS, but with CQL2-text only when the coordinates happen
to fit CRS84's ranges too:
- EPSG:3857 never does;
- EPSG:4326, which is latitude first, does only when the longitude lies within ±90.

## 2. The standards

- **OGC API - Features - Part 3: Filtering** (OGC 19-079r2, 1.0), <https://docs.ogc.org/is/19-079r2/19-079r2.html>
  - **Requirement 17**, `/req/features-filter/filter-crs-definition`, conditional on "Server implements OGC API -
    Features - Part 2: Coordinate Reference Systems by Reference": "The HTTP GET operation on the
    `/collections/{collectionId}/items` path SHALL support the `filter-crs` parameter".
    - Without the parameter, the filter's geometries are CRS84 (or CRS84h with heights).
    - With it, they are in the CRS it names.
  - **Requirement 18 E:** "The server SHALL respond with a `400` error, if a parameter value of `filter`,
    `filter-lang` or `filter-crs` is invalid". So a valid filter in a supported `filter-crs` must not be refused.
  - **Requirement 5** and **Recommendation 2:** `filter-lang` is `cql2-text` (the default) or `cql2-json`. The
    `filter-crs` rule doesn't depend on the language.
- **OGC API - Features - Part 2: CRS by Reference** (OGC 18-058r1, 1.0.1),
  <https://docs.ogc.org/is/18-058r1/18-058r1.html>
  - It defines the CRS URIs: `http://www.opengis.net/def/crs/EPSG/0/3857`, `…/EPSG/0/4326`,
    `http://www.opengis.net/def/crs/OGC/1.3/CRS84`.
  - Coordinates follow the CRS's own axis order (OGC's axis-order policy, 08-038r7). So **EPSG:4326 is latitude,
    longitude**; CRS84 is longitude, latitude.
- **CQL2** (OGC 21-065r2, 1.0.0), <https://docs.ogc.org/is/21-065r2/21-065r2.html>
  - It treats geometry literals as CRS84 unless the API says otherwise. In OGC API Features, `filter-crs` is how it
    says otherwise.
  - CQL2 itself doesn't tie the text encoding to CRS84 any more than the JSON one.

## 3. Evidence

### 3.1 In ogc-cql2 alone (Node 24, ogc-cql2 1.6.2)

```js
import { fromText } from "ogc-cql2/parse";
import { validate } from "ogc-cql2/validate";
import { toSql } from "ogc-cql2/sql";

fromText("S_INTERSECTS(geometry, POINT(489805 6585991))");            // Brussels in EPSG:3857
fromText("S_INTERSECTS(geometry, BBOX(445278, 6446276, 556597, 6621293))"); // a box in EPSG:3857
fromText("S_INTERSECTS(geometry, POINT(35.7 139.7))");                // Tokyo in EPSG:4326 (latitude first)
fromText("S_INTERSECTS(geometry, POINT(50.8 4.4))");                  // Brussels in EPSG:4326

const json = { op: "s_intersects", args: [{ property: "geometry" }, { type: "Point", coordinates: [489805, 6585991] }] };
validate(json);
toSql(json, { dialect: "postgres", columns: { geometry: { format: "geometry-any", sqlType: "geometry" } } });
```

| Call | Result |
|---|---|
| `fromText`, Brussels in 3857 | throws `invalid-filter` at `/args/1/coordinates/0`: "Longitude 489805 is outside −180…180 (CRS84: longitude first)." |
| `fromText`, a box in 3857 | throws `invalid-filter` at `/args/1/bbox/0`: "Longitude 445278 is outside −180…180." |
| `fromText`, Tokyo in 4326 | throws `invalid-filter` at `/args/1/coordinates/1`: "Latitude 139.7 is outside −90…90 (CRS84: latitude second)." |
| `fromText`, Brussels in 4326 | parses, only because 50.8 and 4.4 also fit CRS84's ranges |
| `validate`, the 3857 point in CQL2-JSON | `invalid-geometry` at `/args/1/coordinates/0` and `/1` |
| `toSql`, the same | throws `invalid-filter` |

None of the three functions has an option for another CRS. There's also no parser that reads CQL2-text without these
checks.

### 3.2 Through a server (node-ogcapi-features on `http://localhost:8020`)

The `routes` collection has 10 lines. Each request asks for the routes that touch a box, the same box each time
(Belgium, 4°–5° E, 50°–51° N), written in each CRS.

| # | `filter-lang` | `filter-crs` | `filter` | Answer |
|---|---|---|---|---|
| 1 | cql2-text | (CRS84) | `S_INTERSECTS(geometry, BBOX(4, 50, 5, 51))` | 200: routes 1, 2, 3, 9, 10 |
| 2 | cql2-json | EPSG:3857 | `{"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[445277.96317309426,6446275.841017158,556597.4539663679,6621293.722740165]}]}` | 200: routes 1, 2, 3, 9, 10 |
| 3 | cql2-text | EPSG:3857 | `S_INTERSECTS(geometry, BBOX(445277.96317309426, 6446275.841017158, 556597.4539663679, 6621293.722740165))` | **400**: "Longitude 445277.96317309426 is outside −180…180. (invalid-filter at /args/1/bbox/0)" |
| 4 | cql2-json | EPSG:4326 | `{"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[50,4,51,5]}]}` | 200: routes 1, 2, 3, 9, 10 |
| 5 | cql2-text | EPSG:4326 | `S_INTERSECTS(geometry, BBOX(50, 4, 51, 5))` | 200: routes 1, 2, 3, 9, 10 (the numbers fit CRS84 by chance) |

The same with a box around Tokyo (139°–140° E, 35°–36° N), where the longitude is beyond ±90:

| # | `filter-lang` | `filter-crs` | `filter` | Answer |
|---|---|---|---|---|
| 6 | cql2-text | (CRS84) | `S_INTERSECTS(geometry, BBOX(139, 35, 140, 36))` | 200: routes 4, 5 |
| 7 | cql2-json | EPSG:4326 | `{"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[35,139,36,140]}]}` | 200: routes 4, 5 |
| 8 | cql2-text | EPSG:4326 | `S_INTERSECTS(geometry, BBOX(35, 139, 36, 140))` | **400**: "Latitude 139 is outside −90…90. (invalid-filter at /args/1/bbox/1)" |

- Rows 2, 4 and 7 work because the server converts the CQL2-JSON literals to CRS84 before calling ogc-cql2
  (`src/ogc/filter.ts`, `literalsToCrs84`).
- Rows 3 and 8 can't: `fromText` refuses them first.
- Every row is a valid filter in a CRS the server declares. Requirement 18 allows a 400 only for an invalid value,
  so rows 3 and 8 shouldn't be refused.

To reproduce, with the server running (`npm start`):

```bash
B=http://localhost:8020/collections/routes/items
curl -s -G $B --data-urlencode "filter=S_INTERSECTS(geometry, BBOX(445277.96317309426, 6446275.841017158, 556597.4539663679, 6621293.722740165))" \
  --data-urlencode "filter-crs=http://www.opengis.net/def/crs/EPSG/0/3857"                 # row 3: 400
curl -s -G $B --data-urlencode 'filter={"op":"s_intersects","args":[{"property":"geometry"},{"bbox":[445277.96317309426,6446275.841017158,556597.4539663679,6621293.722740165]}]}' \
  --data-urlencode "filter-lang=cql2-json" --data-urlencode "filter-crs=http://www.opengis.net/def/crs/EPSG/0/3857"  # row 2: 200
```

## 4. An example of where it matters

A map client shows a Web Mercator (EPSG:3857) map, which is the usual web map. The user draws a rectangle to filter
the features. The client has the rectangle in metres, as its map does, and its filter editor writes CQL2-text:

```
GET /collections/routes/items?filter=S_INTERSECTS(geometry, BBOX(445277.96, 6446275.84, 556597.45, 6621293.72))
    &filter-crs=http://www.opengis.net/def/crs/EPSG/0/3857
```

This is exactly the use `filter-crs` exists for. Today, a server on ogc-cql2 answers 400, and the only ways out are
on the client:
- converting the rectangle to CRS84 itself, which `filter-crs` is meant to avoid;
- or switching to CQL2-JSON.

The same happens with EPSG:4326 for any place east of 90° E or west of 90° W: half the world, Tokyo, Sydney and Los
Angeles included.

## 5. What would close the gap

Any one of these would do. They are listed from the smallest change to the most complete.

### A. Let `fromText` parse without the CRS84 coordinate checks

An option, for example `fromText(text, { coordinates: "any" })`, that reads the literals' numbers as they are. It
still checks everything else: the grammar, the profile, the number of axes, closed rings.

The application then converts the literals to CRS84 and calls `validate` and `toSql` as today, which is what
node-ogcapi-features already does for CQL2-JSON. This is the smallest change, and enough for this server.

### B. A literal-mapping helper (with A)

`mapGeometryLiterals(filter, fn)` returns a copy of the filter with each geometry and BBOX literal replaced by
`fn(literal)`. Every application then avoids writing its own tree walk, and the knowledge of where literals can
appear (spatial predicates, GeometryCollections, nested arrays) stays inside the package.

### C. A `crs` option through the SQL dialects

`fromText`, `validate` and `toSql` take the literals' CRS, for example `{ crs: { srid: 3857 } }` or
`{ crs: { srid: 4326, latLon: true } }`.
- `validate` checks the ranges of that CRS, or none for a projected one.
- `toSql` writes each literal in its SRID and transforms it to 4326 in SQL. On PostGIS that is
  `ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 3857), 4326)`; a latitude-first CRS gets `ST_FlipCoordinates`.
  The comparison stays planar in CRS84, as CQL2's is.
- `evaluate` has no projection library. It would need a transform function from the application, or keep taking
  CRS84 only.

This is the most complete option, but it touches every dialect.

## 6. How to know it's done (for A)

- `fromText("S_INTERSECTS(geometry, BBOX(445278, 6446276, 556597, 6621293))", { coordinates: "any" })` returns the
  CQL2-JSON with `{ "bbox": [445278, 6446276, 556597, 6621293] }`.
- With the option, a syntax error, an unclosed ring and an unknown operator are still refused, as now.
- Without the option nothing changes: the default stays CRS84 and strict, so no current user sees a difference.
- `validate` and `toSql` keep checking CRS84 ranges: the application converts before calling them.

node-ogcapi-features would then:
- switch its CQL2-text path to the option;
- answer rows 3 and 8 above with 200 (routes 1, 2, 3, 9, 10 and routes 4, 5);
- add tests where the same filter, in CQL2-text and in CQL2-JSON in each of the three CRSs, selects the same
  features.

## 7. Not asked

- No projection library in ogc-cql2: the conversion stays the application's (PostGIS here).
- No change to `evaluate`'s CRS84 semantics.
