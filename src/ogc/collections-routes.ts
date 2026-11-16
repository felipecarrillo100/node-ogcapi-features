import type { Request } from "express";
import { Router } from "express";
import type { Pool } from "pg";
import { COLLECTIONS, type Collection, collectionById, geometry84, utc } from "./collections.ts";
import { escapeHtml, notFound } from "./errors.ts";
import { ogc, sendHtml, sendJson } from "./handler.ts";
import { mapScript, page } from "./html.ts";
import { type Link, MEDIA, selfAndAlternate, url } from "./links.ts";
import type { Format } from "./negotiate.ts";
import { checkParams } from "./params.ts";

export const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
const GREGORIAN = "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian";

interface ExtentRow {
  xmin: number | null;
  ymin: number | null;
  xmax: number | null;
  ymax: number | null;
  tmin: string | null;
  tmax: string | null;
}

/** A collection as `/collections` and `/collections/{id}` describe it (the same content, Part 1). */
async function describe(pool: Pool, req: Request, c: Collection, links: Link[]): Promise<Record<string, unknown>> {
  const time = c.temporal
    ? `${utc(`min(${c.temporal})`)} AS tmin, ${utc(`max(${c.temporal})`)} AS tmax`
    : "NULL AS tmin, NULL AS tmax";
  const { rows } = await pool.query<ExtentRow>(
    // Rounded as ST_AsGeoJSON rounds the coordinates (9 decimals), so the served features lie inside it.
    `SELECT round(ST_XMin(e)::numeric, 9)::float8 AS xmin, round(ST_YMin(e)::numeric, 9)::float8 AS ymin,
            round(ST_XMax(e)::numeric, 9)::float8 AS xmax, round(ST_YMax(e)::numeric, 9)::float8 AS ymax, tmin, tmax
     FROM (SELECT ST_Extent(${geometry84(c)}) AS e, ${time} FROM ${c.source}) AS x`,
  );
  const r = rows[0] as ExtentRow;
  const bbox = r.xmin === null ? [-180, -90, 180, 90] : [r.xmin, r.ymin, r.xmax, r.ymax];
  const extent: Record<string, unknown> = { spatial: { bbox: [bbox], crs: CRS84 } };
  if (c.temporal) extent.temporal = { interval: [[r.tmin, r.tmax]], trs: GREGORIAN };
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    links: [
      ...links,
      {
        href: url(req, `/collections/${c.id}/items`, { f: "json" }),
        rel: "items",
        type: MEDIA.geojson,
        title: "The features, as GeoJSON",
      },
      {
        href: url(req, `/collections/${c.id}/items`, { f: "html" }),
        rel: "items",
        type: MEDIA.html,
        title: "The features, as HTML",
      },
    ],
    extent,
    itemType: "feature",
    crs: [CRS84],
  };
}

const collectionLinks = (req: Request, c: Collection): Link[] => [
  {
    href: url(req, `/collections/${c.id}`, { f: "json" }),
    rel: "self",
    type: MEDIA.json,
    title: `${c.title}, as JSON`,
  },
  {
    href: url(req, `/collections/${c.id}`, { f: "html" }),
    rel: "alternate",
    type: MEDIA.html,
    title: `${c.title}, as HTML`,
  },
];

/** `/collections` and `/collections/{collectionId}`. */
export function collectionsRouter(pool: Pool): Router {
  const router = Router();

  router.get(
    "/collections",
    ogc(async (req, res, f: Format) => {
      checkParams(req, ["f"]);
      const collections = await Promise.all(COLLECTIONS.map((c) => describe(pool, req, c, collectionLinks(req, c))));
      const links = selfAndAlternate(req, f, MEDIA.json);
      if (f === "json") return sendJson(res, MEDIA.json, { links, collections });
      const list = collections
        .map(
          (c) =>
            `<li><a href="${escapeHtml(url(req, `/collections/${String(c.id)}`, { f: "html" }))}">${escapeHtml(String(c.title))}</a>: ${escapeHtml(String(c.description))}</li>`,
        )
        .join("\n");
      return sendHtml(
        res,
        page(req, "Collections", [["Collections", "/collections"]], `<h1>Collections</h1>\n<ul>\n${list}\n</ul>`, {
          links,
        }),
      );
    }),
  );

  router.get(
    "/collections/:collectionId",
    ogc(async (req, res, f: Format) => {
      const c = collectionById(String(req.params.collectionId));
      if (!c) throw notFound(`No collection "${req.params.collectionId}"`);
      checkParams(req, ["f"]);
      const body = await describe(pool, req, c, selfAndAlternate(req, f, MEDIA.json));
      if (f === "json") return sendJson(res, MEDIA.json, body);
      const extent = body.extent as { spatial: { bbox: number[][] }; temporal?: { interval: (string | null)[][] } };
      const bbox = extent.spatial.bbox[0] as number[];
      const interval = extent.temporal?.interval[0];
      const html = [
        `<h1>${escapeHtml(c.title)}</h1>`,
        `<p>${escapeHtml(c.description)}</p>`,
        `<p><a href="${escapeHtml(url(req, `/collections/${c.id}/items`, { f: "html" }))}">The features</a></p>`,
        "<h2>Extent</h2>",
        `<p>Spatial (CRS84): ${escapeHtml(bbox.join(", "))}</p>`,
        interval ? `<p>Temporal: ${escapeHtml(interval.map((t) => t ?? "..").join(" / "))}</p>` : "",
        mapScript({ bbox }),
      ].join("\n");
      return sendHtml(
        res,
        page(
          req,
          c.title,
          [
            ["Collections", "/collections"],
            [c.title, `/collections/${c.id}`],
          ],
          html,
          { links: body.links as Link[], map: true },
        ),
      );
    }),
  );

  return router;
}
