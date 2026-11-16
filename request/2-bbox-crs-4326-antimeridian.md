# 2. Bug: an EPSG:4326 `bbox` across the antimeridian is refused

| | |
|---|---|
| Component | node-ogcapi-features (this repository), `src/ogc/params.ts`, `parseBbox` |
| Not in | ogc-cql2: the same box as a `filter-crs` literal works through ogc-cql2 1.7.0 |
| Since | OGC API Phase 4 (`bbox-crs`, 2026-11-16) |
| Found | 2026-11-17, while integrating ogc-cql2 1.7.0 |
| Kind | Bug: a valid request answers 400 |
| Status | **Fixed 2026-11-17.** The ogc-cql2 team confirmed it: no change is needed in the package; they agreed with option 1 of section 5. After the fix, row 2 answers 200 with route 6; rows 5 and 6 answer 400 `Invalid bbox "…": A bbox's south … is above its north …` |

## 1. Description

`GET /collections/{id}/items?bbox=…&bbox-crs=http://www.opengis.net/def/crs/EPSG/0/4326` refuses a box that crosses
the antimeridian. It answers 400 "its south is above its north".

`parseBbox` checks that the box's south isn't above its north before it knows the box's CRS. It always reads the
numbers longitude first, as CRS84 writes them:
- south is the 2nd number;
- north is the 4th (or the 5th with 6 numbers).

In EPSG:4326 the box is latitude first, so the 2nd and 4th numbers are the west and east longitudes. The check then
compares longitudes:
- **A box across the antimeridian is refused.** Its west longitude is above its east, as it must be, and the check
  reads that as "south above north".
- **A box whose south really is above its north passes this check.** ogc-cql2 refuses it afterwards (row 5 below), so
  that only changes the message.

## 2. The standards

- **OGC API - Features - Part 1: Core** (OGC 17-069r4, 1.0.1), `bbox` (`/req/core/fc-bbox-definition`), <https://docs.ogc.org/is/17-069r4/17-069r4.html>
  - A box spanning the antimeridian is written with its west-most edge larger than its east-most edge.
  - The server takes such a box; it isn't an error.
- **OGC API - Features - Part 2: CRS by Reference** (OGC 18-058r1, 1.0.1), `bbox-crs`, <https://docs.ogc.org/is/18-058r1/18-058r1.html>
  - The box's coordinates are in the CRS that `bbox-crs` names, in that CRS's axis order.
  - EPSG:4326 is latitude, longitude, so its box is minimum latitude, minimum longitude, maximum latitude, maximum
    longitude.
  - Across the antimeridian, the 2nd number (west longitude) is above the 4th (east longitude).
- **The same box as a filter literal:** ogc-cql2 1.7.0 reads it in EPSG:4326 (`literals: { srid: 4326, yx: true }`)
  and lets it cross the antimeridian, as CQL2 does for a BBOX.

## 3. Evidence

Live on `http://localhost:8020`, 2026-11-17, on the `routes` collection. Route 6 (Sydney–Auckland) is the one that
reaches past 170° E.

| # | Request | Answer |
|---|---|---|
| 1 | `bbox=170,-40,-170,-30` (CRS84) | 200: route 6 |
| 2 | `bbox=-40,170,-30,-170&bbox-crs=…/EPSG/0/4326` (the same box, latitude first) | **400**: `Invalid bbox "-40,170,-30,-170": its south is above its north` |
| 3 | `filter=S_INTERSECTS(geometry, BBOX(170, -40, -170, -30))` (CRS84) | 200: route 6 |
| 4 | `filter=S_INTERSECTS(geometry, BBOX(-40, 170, -30, -170))&filter-crs=…/EPSG/0/4326` | 200: route 6 |
| 5 | `bbox=-36,170,-37,175&bbox-crs=…/EPSG/0/4326` (south above north, really) | 400 from ogc-cql2: `A bbox's south (-36) is above its north (-37)` |
| 6 | `bbox=170,-36,175,-37` (CRS84, south above north) | 400 from `parseBbox`: `its south is above its north` (right) |

Rows 1, 3 and 4 show that the box is valid and selects route 6. Row 2 is the bug: the same box, written as EPSG:4326
requires, is refused. Rows 5 and 6 show that a box really running south-north backwards is refused in both CRSs.

To reproduce:

```bash
B=http://localhost:8020/collections/routes/items
curl -s -G $B --data-urlencode "bbox=170,-40,-170,-30"                                          # 200, route 6
curl -s -G $B --data-urlencode "bbox=-40,170,-30,-170" \
  --data-urlencode "bbox-crs=http://www.opengis.net/def/crs/EPSG/0/4326"                         # 400 (the bug)
```

The code (`src/ogc/params.ts`):

```ts
const [south, north] = n.length === 4 ? [n[1], n[3]] : [n[1], n[4]];
if ((south as number) > (north as number)) throw badRequest(`Invalid bbox "${value}": its south is above its north`);
```

## 4. Where it matters

A client that knows Part 2 asks for the Pacific around Fiji, or the Bering Strait, in EPSG:4326. It writes the box
latitude first, as the CRS requires, and gets a 400. It would get the features with the same box in CRS84, or as a
`filter-crs` filter.

The fault is quiet: the message says the box is upside down, which it isn't. A client has no hint that the box's CRS
is the cause.

## 5. What would fix it

- **Drop the south/north check from `parseBbox`.** The box goes on to ogc-cql2's `validate` / `toSql` in its own CRS
  (`literals`), which already refuses a backwards south-north in CRS84 and EPSG:4326 (rows 5 and 6). It also lets a
  backwards west-east box cross the antimeridian in those two CRSs, and refuses it in EPSG:3857. One check, in the
  package that compiles the box.
- **Or** make the check read the box in its CRS: `parseBbox` takes the `bbox-crs` and swaps the axes for a
  latitude-first CRS before comparing. That keeps today's message, but duplicates what ogc-cql2 checks.

The first is smaller and keeps one rule in one place. The messages for row 6 would then be ogc-cql2's, as row 5's is.

## 6. How to know it's fixed

- Row 2 answers 200 with route 6, the same as rows 1, 3 and 4.
- Rows 5 and 6 still answer 400.
- A test with the same box, across the antimeridian, in CRS84 and in EPSG:4326 (`bbox` and `filter-crs`), on both
  collections, selects the same features.
- TEAM Engine (Parts 1 and 2) answers as before: 248 / 10 / 2.
