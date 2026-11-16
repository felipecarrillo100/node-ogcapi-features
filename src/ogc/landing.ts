import { Router } from "express";
import { CONFORMS_TO } from "../conformance.ts";
import { escapeHtml } from "./errors.ts";
import { ogc, sendHtml, sendJson } from "./handler.ts";
import { page } from "./html.ts";
import { type Link, MEDIA, selfAndAlternate, url } from "./links.ts";
import { format } from "./negotiate.ts";
import { checkParams } from "./params.ts";

export const TITLE = "node-ogcapi-features";
export const DESCRIPTION =
  "A PostGIS-backed OGC API Features server, for testing MapEvolution's sources and filters against a real backend. " +
  "Filters are compiled to SQL with ogc-cql2, the package that evaluates them on the map.";

/** `/` (the landing page) and the HTML form of `/conformance`. */
export function landingRouter(): Router {
  const router = Router();

  router.get(
    "/",
    ogc((req, res, f) => {
      checkParams(req, ["f"]);
      const links: Link[] = [
        ...selfAndAlternate(req, f, MEDIA.json),
        { href: url(req, "/api"), rel: "service-desc", type: MEDIA.openapi, title: "The API definition (OpenAPI 3.0)" },
        {
          href: url(req, "/api.html"),
          rel: "service-doc",
          type: MEDIA.html,
          title: "The API documentation (Swagger UI)",
        },
        {
          href: url(req, "/conformance", { f: "json" }),
          rel: "conformance",
          type: MEDIA.json,
          title: "Conformance classes, as JSON",
        },
        {
          href: url(req, "/conformance", { f: "html" }),
          rel: "conformance",
          type: MEDIA.html,
          title: "Conformance classes, as HTML",
        },
        {
          href: url(req, "/collections", { f: "json" }),
          rel: "data",
          type: MEDIA.json,
          title: "The collections, as JSON",
        },
        {
          href: url(req, "/collections", { f: "html" }),
          rel: "data",
          type: MEDIA.html,
          title: "The collections, as HTML",
        },
      ];
      if (f === "json") return sendJson(res, MEDIA.json, { title: TITLE, description: DESCRIPTION, links });
      return sendHtml(
        res,
        page(req, TITLE, [], `<h1>${escapeHtml(TITLE)}</h1>\n<p>${escapeHtml(DESCRIPTION)}</p>`, { links }),
      );
    }),
  );

  return router;
}

/**
 * `/conformance` in OGC API's terms: as HTML when asked for (`f=html`, or `Accept` preferring HTML), and a 400 for an
 * unknown query parameter or `f` (Part 1). Every other request goes on to the JSON route, which answers as it always
 * has: a request without a query (what MapEvolution sends) is answered exactly as before.
 */
export function ogcConformanceRouter(): Router {
  const router = Router();
  const html = ogc((req, res, f) => {
    checkParams(req, ["f"]);
    if (f === "json") return undefined;
    const items = CONFORMS_TO.map((uri) => `<li><a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a></li>`).join("\n");
    return sendHtml(
      res,
      page(req, "Conformance", [["Conformance", "/conformance"]], `<h1>Conformance</h1>\n<ul>\n${items}\n</ul>`, {
        links: selfAndAlternate(req, f, MEDIA.json),
      }),
    );
  });
  router.get("/conformance", (req, res, next) => {
    const queryOk = Object.keys(req.query).every((k) => k === "f") && format(req) !== undefined;
    return format(req) === "html" || !queryOk ? html(req, res, next) : next();
  });
  return router;
}
