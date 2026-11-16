import type { Request } from "express";
import { Router } from "express";
import type { Feature, Geometry } from "geojson";
import type { Pool } from "pg";
import { type Collection, collectionById, geometry84 } from "./collections.ts";
import { escapeHtml, notFound } from "./errors.ts";
import { ogc, sendHtml, sendJson } from "./handler.ts";
import { mapScript, page, propertiesTable } from "./html.ts";
import { type Link, MEDIA, ownQuery, selfAndAlternate, url } from "./links.ts";
import type { Format } from "./negotiate.ts";
import { checkParams, LIMIT, parseBbox, parseDatetime, parseLimit, parseOffset } from "./params.ts";

/** The query parameters of `/items`. */
export const ITEMS_PARAMS = ["f", "limit", "offset", "bbox", "datetime"] as const;

interface Row {
  id: number;
  properties: Record<string, unknown>;
  geom_json: string;
}

/** A WHERE clause and its values, built one condition at a time. */
class Where {
  readonly conditions: string[] = [];
  readonly params: unknown[] = [];
  /** `$n` for a new value. */
  value(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  toString(): string {
    return this.conditions.length ? `WHERE ${this.conditions.join(" AND ")}` : "";
  }
}

/** The `bbox` and `datetime` of the request, as conditions on the collection. */
function itemsWhere(req: Request, c: Collection): Where {
  const where = new Where();
  const bbox = parseBbox(req);
  if (bbox) {
    const [w, s, e, n] = bbox;
    const env = (x1: number, x2: number) =>
      `ST_MakeEnvelope(${where.value(x1)}, ${where.value(s)}, ${where.value(x2)}, ${where.value(n)}, 4326)`;
    // West above east: the box crosses the antimeridian, so it is two boxes.
    const boxes = w <= e ? [env(w, e)] : [env(w, 180), env(-180, e)];
    where.conditions.push(`(${boxes.map((b) => `ST_Intersects(${geometry84(c)}, ${b})`).join(" OR ")})`);
  }
  const datetime = parseDatetime(req);
  if (datetime && c.temporal) {
    // A feature whose instant is NULL isn't in any interval.
    where.conditions.push(`${c.temporal} IS NOT NULL`);
    if (datetime.from) where.conditions.push(`${c.temporal} >= ${where.value(datetime.from)}::timestamptz`);
    if (datetime.to)
      where.conditions.push(
        `${c.temporal} ${datetime.toExclusive ? "<" : "<="} ${where.value(datetime.to)}::timestamptz`,
      );
  }
  return where;
}

const select = (c: Collection) =>
  `SELECT f.id, ${c.properties} AS properties, ST_AsGeoJSON(${geometry84(c)}) AS geom_json FROM ${c.source}`;

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
      checkParams(req, ITEMS_PARAMS);
      const limit = parseLimit(req);
      const offset = parseOffset(req);
      const where = itemsWhere(req, c);
      const n = where.params.length;
      const [count, rows] = await Promise.all([
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${c.source} ${where}`, where.params),
        pool.query<Row>(`${select(c)} ${where} ORDER BY f.id LIMIT $${n + 1} OFFSET $${n + 2}`, [
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
      if (f === "json") return sendJson(res, MEDIA.geojson, body);

      // The map shows exactly the features listed: this page's own query, as GeoJSON.
      const dataUrl = url(req, req.path, { ...ownQuery(req), f: "json" });
      const table = features
        .map((ft) => {
          const href = url(req, `/collections/${c.id}/items/${ft.id}`, { f: "html" });
          return `<tr><td><a href="${escapeHtml(href)}">${ft.id}</a></td><td>${escapeHtml(JSON.stringify(ft.properties))}</td></tr>`;
        })
        .join("\n");
      const html = [
        `<h1>${escapeHtml(c.title)}: items</h1>`,
        `<p>${features.length} of ${numberMatched} features${offset ? `, from number ${offset + 1}` : ""}.</p>`,
        mapScript({ url: dataUrl }),
        `<table>\n<tr><th>id</th><th>properties</th></tr>\n${table}\n</table>`,
      ].join("\n");
      return sendHtml(res, page(req, `${c.title}: items`, crumbs(c), html, { links, map: true }));
    }),
  );

  router.get(
    "/collections/:collectionId/items/:featureId",
    ogc(async (req, res, f: Format) => {
      const c = collectionOf(req);
      checkParams(req, ["f"]);
      const id = String(req.params.featureId);
      // The ids are SERIAL: anything else isn't a feature here.
      const row =
        /^\d{1,10}$/.test(id) && Number(id) <= 2147483647
          ? (await pool.query<Row>(`${select(c)} WHERE f.id = $1`, [Number(id)])).rows[0]
          : undefined;
      if (!row) throw notFound(`No feature "${id}" in collection "${c.id}"`);
      const links: Link[] = [
        ...selfAndAlternate(req, f, MEDIA.geojson),
        { href: url(req, `/collections/${c.id}`, { f: "json" }), rel: "collection", type: MEDIA.json, title: c.title },
      ];
      const feature = { ...toFeature(row), links };
      if (f === "json") return sendJson(res, MEDIA.geojson, feature);
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
        }),
      );
    }),
  );

  return router;
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
