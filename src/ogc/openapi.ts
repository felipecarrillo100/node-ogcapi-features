import type { Request } from "express";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { COLLECTIONS } from "./collections.ts";
import { ogc, sendHtml } from "./handler.ts";
import { DESCRIPTION, TITLE } from "./landing.ts";
import { baseUrl, MEDIA } from "./links.ts";
import { checkParams, LIMIT } from "./params.ts";

const ref = (kind: "parameters" | "schemas" | "responses", name: string) => ({ $ref: `#/components/${kind}/${name}` });

/** A 200 in JSON (`type`, with `schema`) and HTML. */
const ok = (description: string, type: string, schema: string) => ({
  description,
  content: { [type]: { schema: ref("schemas", schema) }, [MEDIA.html]: { schema: { type: "string" } } },
});

const errors = (...statuses: (400 | 404)[]) => ({
  ...Object.fromEntries(
    statuses.map((s) => [String(s), ref("responses", s === 400 ? "InvalidParameter" : "NotFound")]),
  ),
  "500": ref("responses", "ServerError"),
});

/**
 * The OpenAPI 3.0 document of the OGC API, generated from the collections config: one path per collection (as
 * pygeoapi and ldproxy write it), every parameter and status each route uses. The server is the one the client
 * reached.
 */
export function openApiDocument(req: Request): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/": {
      get: {
        tags: ["Capabilities"],
        summary: "The landing page",
        operationId: "getLandingPage",
        parameters: [ref("parameters", "f")],
        responses: {
          "200": ok(
            "Links to the API definition, the conformance classes and the collections",
            MEDIA.json,
            "landingPage",
          ),
          ...errors(400),
        },
      },
    },
    "/conformance": {
      get: {
        tags: ["Capabilities"],
        summary: "The conformance classes this server implements",
        operationId: "getConformance",
        parameters: [ref("parameters", "f")],
        responses: { "200": ok("The URIs of the conformance classes", MEDIA.json, "confClasses"), ...errors(400) },
      },
    },
    "/api": {
      get: {
        tags: ["Capabilities"],
        summary: "This API definition",
        operationId: "getApi",
        parameters: [ref("parameters", "f")],
        responses: {
          "200": {
            description: "The OpenAPI 3.0 document (JSON), or Swagger UI (HTML)",
            content: { [MEDIA.openapi]: { schema: { type: "object" } }, [MEDIA.html]: { schema: { type: "string" } } },
          },
          ...errors(400),
        },
      },
    },
    "/collections": {
      get: {
        tags: ["Capabilities"],
        summary: "The feature collections",
        operationId: "getCollections",
        parameters: [ref("parameters", "f")],
        responses: { "200": ok("The collections", MEDIA.json, "collections"), ...errors(400) },
      },
    },
  };
  for (const c of COLLECTIONS) {
    const tag = c.title;
    paths[`/collections/${c.id}`] = {
      get: {
        tags: [tag],
        summary: `The ${c.title} collection`,
        description: c.description,
        operationId: `describe_${c.id}`,
        parameters: [ref("parameters", "f")],
        responses: { "200": ok("The collection", MEDIA.json, "collection"), ...errors(400, 404) },
      },
    };
    paths[`/collections/${c.id}/items`] = {
      get: {
        tags: [tag],
        summary: `The features of ${c.title}`,
        description: c.temporal
          ? "`datetime` selects by the `departure` instant; a feature without one is left out."
          : "This collection has no temporal property: `datetime` is accepted and selects every feature.",
        operationId: `getFeatures_${c.id}`,
        parameters: ["f", "limit", "offset", "bbox", "datetime"].map((p) => ref("parameters", p)),
        responses: {
          "200": ok("A page of the features, as GeoJSON", MEDIA.geojson, "featureCollectionGeoJSON"),
          ...errors(400, 404),
        },
      },
    };
    paths[`/collections/${c.id}/items/{featureId}`] = {
      get: {
        tags: [tag],
        summary: `A feature of ${c.title}`,
        operationId: `getFeature_${c.id}`,
        parameters: [ref("parameters", "featureId"), ref("parameters", "f")],
        responses: { "200": ok("The feature, as GeoJSON", MEDIA.geojson, "featureGeoJSON"), ...errors(400, 404) },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: { title: TITLE, description: DESCRIPTION, version: "1.0.0" },
    servers: [{ url: baseUrl(req) }],
    tags: [{ name: "Capabilities" }, ...COLLECTIONS.map((c) => ({ name: c.title, description: c.description }))],
    paths,
    components: { parameters: PARAMETERS, schemas: SCHEMAS, responses: RESPONSES },
  };
}

const PARAMETERS = {
  f: {
    name: "f",
    in: "query",
    description: "The format of the answer; without it, the Accept header decides (JSON by default).",
    required: false,
    schema: { type: "string", enum: ["json", "html"] },
  },
  limit: {
    name: "limit",
    in: "query",
    description: `How many features a page holds. Above ${LIMIT.maximum}, ${LIMIT.maximum}.`,
    required: false,
    style: "form",
    explode: false,
    schema: { type: "integer", minimum: LIMIT.minimum, maximum: LIMIT.maximum, default: LIMIT.default },
  },
  offset: {
    name: "offset",
    in: "query",
    description: "How many features to skip (the `next` and `prev` links set it).",
    required: false,
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  bbox: {
    name: "bbox",
    in: "query",
    description:
      "The features that intersect the box: minimum longitude, latitude, maximum longitude, latitude (CRS84); 6 " +
      "numbers carry heights, which are ignored. West above east crosses the antimeridian.",
    required: false,
    style: "form",
    explode: false,
    schema: { type: "array", minItems: 4, maxItems: 6, items: { type: "number" } },
  },
  datetime: {
    name: "datetime",
    in: "query",
    description:
      "An RFC 3339 date-time or date, or an interval `start/end` with `..` (or nothing) for an open end. A date stands " +
      "for its whole day (UTC).",
    required: false,
    style: "form",
    explode: false,
    schema: { type: "string" },
  },
  featureId: {
    name: "featureId",
    in: "path",
    description: "The feature's id",
    required: true,
    schema: { type: "string" },
  },
};

const link = {
  type: "object",
  required: ["href", "rel"],
  properties: {
    href: { type: "string" },
    rel: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
  },
};
const links = { type: "array", items: ref("schemas", "link") };
const SCHEMAS = {
  link,
  exception: {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string" }, description: { type: "string" } },
  },
  landingPage: {
    type: "object",
    required: ["links"],
    properties: { title: { type: "string" }, description: { type: "string" }, links },
  },
  confClasses: {
    type: "object",
    required: ["conformsTo"],
    properties: { conformsTo: { type: "array", items: { type: "string" } } },
  },
  extent: {
    type: "object",
    properties: {
      spatial: {
        type: "object",
        properties: {
          bbox: {
            type: "array",
            minItems: 1,
            items: { type: "array", minItems: 4, maxItems: 6, items: { type: "number" } },
          },
          crs: { type: "string" },
        },
      },
      temporal: {
        type: "object",
        properties: {
          interval: {
            type: "array",
            minItems: 1,
            items: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: { type: "string", format: "date-time", nullable: true },
            },
          },
          trs: { type: "string" },
        },
      },
    },
  },
  collection: {
    type: "object",
    required: ["id", "links"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      links,
      extent: ref("schemas", "extent"),
      itemType: { type: "string" },
      crs: { type: "array", items: { type: "string" } },
    },
  },
  collections: {
    type: "object",
    required: ["links", "collections"],
    properties: { links, collections: { type: "array", items: ref("schemas", "collection") } },
  },
  geometryGeoJSON: {
    type: "object",
    required: ["type"],
    properties: {
      type: {
        type: "string",
        enum: ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"],
      },
    },
  },
  featureGeoJSON: {
    type: "object",
    required: ["type", "geometry", "properties"],
    properties: {
      type: { type: "string", enum: ["Feature"] },
      geometry: ref("schemas", "geometryGeoJSON"),
      properties: { type: "object", nullable: true },
      id: { oneOf: [{ type: "string" }, { type: "integer" }] },
      links,
    },
  },
  featureCollectionGeoJSON: {
    type: "object",
    required: ["type", "features"],
    properties: {
      type: { type: "string", enum: ["FeatureCollection"] },
      features: { type: "array", items: ref("schemas", "featureGeoJSON") },
      links,
      timeStamp: { type: "string", format: "date-time" },
      numberMatched: { type: "integer", minimum: 0 },
      numberReturned: { type: "integer", minimum: 0 },
    },
  },
};

const exceptionResponse = (description: string) => ({
  description,
  content: { [MEDIA.json]: { schema: ref("schemas", "exception") }, [MEDIA.html]: { schema: { type: "string" } } },
});
const RESPONSES = {
  InvalidParameter: exceptionResponse("A query parameter is unknown, given twice, or has an invalid value"),
  NotFound: exceptionResponse("No such collection or feature"),
  ServerError: exceptionResponse("A server error"),
};

// Swagger UI, stock: its page at /api.html, its files (and the script that points it at /api) under /assets/swagger-ui.
const SWAGGER = { swaggerUrl: "/api" };
const swaggerPage = swaggerUi
  .generateHTML(undefined, SWAGGER)
  .replace("<head>", '<head>\n  <base href="/assets/swagger-ui/">');

/** `/api` (the OpenAPI document, or Swagger UI as HTML), `/api.html` (Swagger UI) and Swagger UI's files. */
export function openApiRouter(): Router {
  const router = Router();
  router.use("/assets/swagger-ui", swaggerUi.serveFiles(undefined, SWAGGER));
  router.get(
    "/api",
    ogc((req, res, f) => {
      checkParams(req, ["f"]);
      if (f === "html") return sendHtml(res, swaggerPage);
      // The media type exactly as Part 1 names it (Express would add a space and a charset).
      res.setHeader("Content-Type", MEDIA.openapi);
      return res.end(JSON.stringify(openApiDocument(req)));
    }),
  );
  router.get(
    "/api.html",
    ogc((req, res) => {
      checkParams(req, []);
      return sendHtml(res, swaggerPage);
    }),
  );
  return router;
}
