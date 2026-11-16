import type { Request } from "express";
import { Router } from "express";
import type { Feature, Geometry } from "geojson";
import type { Pool } from "pg";
import { type Collection, collectionById, GEOMETRY } from "./collections.ts";
import { type Crs, contentCrsHeader, crsParam, geometryIn } from "./crs.ts";
import { escapeHtml, notFound } from "./errors.ts";
import { addFilter, addFilters, itemsParams } from "./filter.ts";
import { ogc, sendHtml, sendJson } from "./handler.ts";
import { featuresTable, mapScript, page, propertiesTable } from "./html.ts";
import { type Link, MEDIA, ownQuery, selfAndAlternate, url } from "./links.ts";
import type { Format } from "./negotiate.ts";
import { checkParams, datetimeLiteral, LIMIT, parseBbox, parseLimit, parseOffset } from "./params.ts";
import { Where } from "./where.ts";

interface Row {
  id: number;
  properties: Record<string, unknown>;
  geom_json: string;
}

/**
 * The request's conditions on the collection, combined with AND: `bbox`, `datetime`, and Part 3's `filter` and
 * queryables as query parameters.
 */
function itemsWhere(req: Request, c: Collection): Where {
  const where = new Where();
  // bbox and datetime are CQL2 too, compiled by toSql as filters are, so they select what the map selects: the
  // box as S_INTERSECTS (ogc-cql2's exact test, across the antimeridian as one literal; PostGIS's ST_Intersects misses
  // points on an edge on arm64), the instant or interval as T_INTERSECTS (to the millisecond).
  // bbox-crs (Part 2): the box's numbers in that CRS, which toSql transforms to CRS84 (ogc-cql2's `literals`).
  const bboxCrs = crsParam(req, "bbox-crs");
  const bbox = parseBbox(req);
  if (bbox) {
    // The message names the parameter as sent: `Invalid bbox "…": ` and ogc-cql2's explanation.
    const label = `bbox "${String(req.query.bbox)}"`;
    addFilter(where, c, { op: "s_intersects", args: [{ property: GEOMETRY }, { bbox }] }, label, bboxCrs);
  }
  const datetime = datetimeLiteral(req);
  // Without an instant (features), datetime selects every feature (Part 1).
  if (datetime && c.instant) {
    addFilter(where, c, { op: "t_intersects", args: [{ property: c.instant }, datetime] }, "datetime");
  }
  addFilters(req, c, where);
  return where;
}

/** The features' SELECT, the geometry in `crs` (Part 2): 9 decimals in degrees, 15 in metres. */
const select = (c: Collection, crs: Crs) =>
  `SELECT f.id, ${c.properties} AS properties,
   ST_AsGeoJSON(${geometryIn(crs, c.srid)}, ${crs.srid === 4326 ? 9 : 15}, 0) AS geom_json FROM ${c.source}`;

const toFeature = (row: Row): Feature<Geometry> & { id: number } => ({
  type: "Feature",
  id: row.id,
  geometry: JSON.parse(row.geom_json) as Geometry,
  properties: row.properties,
});

function collectionOf(req: Request): Collection {
  const c = collectionById(String(req.params.collectionId));
  if (!c) throw notFound(`No collection "${req.params.collectionId}"`);
  return c;
}

const crumbs = (c: Collection) =>
  [
    ["Collections", "/collections"],
    [c.title, `/collections/${c.id}`],
    ["Items", `/collections/${c.id}/items`],
  ] as const;

/** `/collections/{collectionId}/items` and `/items/{featureId}`. */
export function itemsRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/collections/:collectionId/items",
    ogc(async (req, res, f: Format) => {
      const c = collectionOf(req);
      checkParams(req, itemsParams(c));
      const limit = parseLimit(req);
      const offset = parseOffset(req);
      const crs = crsParam(req, "crs");
      const where = itemsWhere(req, c);
      const n = where.params.length;
      const [count, rows] = await Promise.all([
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${c.source} ${where}`, where.params),
        pool.query<Row>(`${select(c, crs)} ${where} ORDER BY f.id LIMIT $${n + 1} OFFSET $${n + 2}`, [
          ...where.params,
          limit,
          offset,
        ]),
      ]);
      const numberMatched = (count.rows[0] as { n: number }).n;
      const features = rows.rows.map(toFeature);
      const links = itemsLinks(req, c, f, limit, offset, numberMatched, features.length);
      const body = {
        type: "FeatureCollection",
        timeStamp: new Date().toISOString(),
        numberMatched,
        numberReturned: features.length,
        features,
        links,
      };
      if (f === "json") {
        res.setHeader("Content-Crs", contentCrsHeader(crs));
        return sendJson(res, MEDIA.geojson, body);
      }

      // The map shows exactly the features listed: this page's own query, as GeoJSON, in CRS84 whatever `crs` asks.
      const { crs: _crs, ...query } = ownQuery(req);
      const dataUrl = url(req, req.path, { ...query, f: "json" });
      // One column per property: the queryables in their order (not the geometry), then any other found.
      const columns = Object.keys(c.queryables).filter((name) => name !== GEOMETRY);
      const table = featuresTable(features, columns, (id) =>
        url(req, `/collections/${c.id}/items/${id}`, { f: "html" }),
      );
      const html = [
        `<h1>${escapeHtml(c.title)}: items</h1>`,
        `<p>${features.length} of ${numberMatched} features${offset ? `, from number ${offset + 1}` : ""}.</p>`,
        limitForm(req, limit),
        mapScript({ url: dataUrl }),
        table,
      ].join("\n");
      return sendHtml(res, page(req, `${c.title}: items`, crumbs(c), html, { links, map: true, grid: true }));
    }),
  );

  router.get(
    "/collections/:collectionId/items/:featureId",
    ogc(async (req, res, f: Format) => {
      const c = collectionOf(req);
      checkParams(req, ["f", "crs"]);
      const crs = crsParam(req, "crs");
      const id = String(req.params.featureId);
      // The ids are SERIAL: anything else isn't a feature here.
      const row =
        /^\d{1,10}$/.test(id) && Number(id) <= 2147483647
          ? (await pool.query<Row>(`${select(c, crs)} WHERE f.id = $1`, [Number(id)])).rows[0]
          : undefined;
      if (!row) throw notFound(`No feature "${id}" in collection "${c.id}"`);
      const links: Link[] = [
        ...selfAndAlternate(req, f, MEDIA.geojson),
        { href: url(req, `/collections/${c.id}`, { f: "json" }), rel: "collection", type: MEDIA.json, title: c.title },
      ];
      const feature = { ...toFeature(row), links };
      if (f === "json") {
        res.setHeader("Content-Crs", contentCrsHeader(crs));
        return sendJson(res, MEDIA.geojson, feature);
      }
      const html = [
        `<h1>${escapeHtml(c.title)}: feature ${feature.id}</h1>`,
        mapScript({ url: url(req, req.path, { f: "json" }) }),
        "<h2>Properties</h2>",
        propertiesTable(feature.properties),
      ].join("\n");
      return sendHtml(
        res,
        page(req, `${c.title}: feature ${feature.id}`, [...crumbs(c), [String(feature.id), req.path]], html, {
          links,
          map: true,
          grid: true,
        }),
      );
    }),
  );

  return router;
}

/** The page sizes the HTML items page offers; the current one is added when it's another. */
const LIMITS = [LIMIT.default, 100, 1000, LIMIT.maximum];

/**
 * The HTML items page's "Limit" form: a plain GET to the same page with the chosen `limit`, every other parameter of
 * the page kept (hidden), and `offset` dropped, so a new page size starts at the first page.
 */
function limitForm(req: Request, limit: number): string {
  const choices = [...new Set([...LIMITS, limit])].sort((a, b) => a - b);
  const options = choices.map((n) => `<option${n === limit ? " selected" : ""}>${n}</option>`).join("");
  const kept = Object.entries({ ...ownQuery(req), f: "html" })
    .filter(([k]) => k !== "limit" && k !== "offset")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<form method="get" action="${escapeHtml(req.path)}">
<label>Limit <select name="limit">${options}</select></label>
${kept}
<button>Apply</button>
</form>`;
}

/**
 * The links of an items page: `self` / `alternate`, `next` while features remain, `prev` after the first page (both in
 * the page's own format), `collection`.
 */
function itemsLinks(
  req: Request,
  c: Collection,
  f: Format,
  limit: number,
  offset: number,
  matched: number,
  returned: number,
): Link[] {
  const query = ownQuery(req);
  // Above the maximum, the self link says the limit used.
  const overMax = Number(query.limit) > LIMIT.maximum ? { limit } : {};
  const type = f === "json" ? MEDIA.geojson : MEDIA.html;
  const pageLink = (rel: "next" | "prev", o: number): Link => ({
    href: url(req, req.path, { ...query, f, limit, offset: o || undefined }),
    rel,
    type,
    title: rel === "next" ? "The next page" : "The previous page",
  });
  const links = selfAndAlternate(req, f, MEDIA.geojson, overMax);
  if (offset + returned < matched) links.push(pageLink("next", offset + limit));
  if (offset > 0) links.push(pageLink("prev", Math.max(0, offset - limit)));
  links.push({
    href: url(req, `/collections/${c.id}`, { f: "json" }),
    rel: "collection",
    type: MEDIA.json,
    title: c.title,
  });
  return links;
}
