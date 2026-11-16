import type { Request } from "express";
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { COLLECTIONS, simpleQueryables } from "./collections.ts";
import { CRS84 } from "./filter.ts";
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

/** A POST / PUT body: a GeoJSON Feature, as `application/geo+json` or `application/json`. */
const featureBody = {
  required: true,
  content: {
    [MEDIA.geojson]: { schema: ref("schemas", "featureGeoJSON") },
    [MEDIA.json]: { schema: ref("schemas", "featureGeoJSON") },
  },
};

/** The errors of a write: 400 (the body doesn't fit the schema), 404 (`item`: no such feature), 415, 500. */
const writeErrors = (item: boolean) => ({
  "400": ref("responses", "InvalidBody"),
  ...(item ? { "404": ref("responses", "NotFound") } : {}),
  "415": ref("responses", "UnsupportedMediaType"),
  "500": ref("responses", "ServerError"),
});

const schemaLink = (c: { id: string }) => `the collection's schema (\`/collections/${c.id}/schema\`)`;

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
        parameters: [
          ...["f", "limit", "offset", "bbox", "datetime", "filter", "filter-lang", "filter-crs"].map((p) =>
            ref("parameters", p),
          ),
          // Part 3, Queryables as Query Parameters: each simple queryable, with its own schema.
          ...simpleQueryables(c).map(([name, q]) => ({
            name,
            in: "query",
            description: `The features whose ${name} equals this value.`,
            required: false,
            schema: { type: q.type },
          })),
        ],
        responses: {
          "200": ok("A page of the features, as GeoJSON", MEDIA.geojson, "featureCollectionGeoJSON"),
          ...errors(400, 404),
        },
      },
      // Part 4: create.
      post: {
        tags: [tag],
        summary: `Add a feature to ${c.title}`,
        description: `The body is a GeoJSON Feature (CRS84) whose properties fit ${schemaLink(c)}; the server assigns the id.`,
        operationId: `createFeature_${c.id}`,
        requestBody: featureBody,
        responses: {
          "201": {
            description: "Created; no body",
            headers: { Location: { description: "The new feature's URI", schema: { type: "string", format: "uri" } } },
          },
          ...writeErrors(false),
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
      // Part 4: replace, update, delete.
      put: {
        tags: [tag],
        summary: `Replace a feature of ${c.title}`,
        description: `The body is the whole feature, as for POST; an \`id\` in it is ignored (the path names the feature). There is no create-on-PUT: an unknown id is a 404.`,
        operationId: `replaceFeature_${c.id}`,
        parameters: [ref("parameters", "featureId")],
        requestBody: featureBody,
        responses: { "204": { description: "Replaced; no body" }, ...writeErrors(true) },
      },
      patch: {
        tags: [tag],
        summary: `Update some properties of a feature of ${c.title}`,
        description:
          `A JSON Merge Patch (RFC 7396) on the feature as ${schemaLink(c)} describes it, every property flat ` +
          '(`{ "lanes": 3, "geometry": {…} }`); a GeoJSON-shaped patch (`{ "properties": {…} }`) is read as that. ' +
          "`null` unsets a property; a geometry replaces the geometry; the id can't change.",
        operationId: `updateFeature_${c.id}`,
        parameters: [ref("parameters", "featureId")],
        requestBody: {
          required: true,
          content: { "application/merge-patch+json": { schema: { type: "object" } } },
        },
        responses: { "204": { description: "Updated; no body" }, ...writeErrors(true) },
      },
      delete: {
        tags: [tag],
        summary: `Delete a feature of ${c.title}`,
        operationId: `deleteFeature_${c.id}`,
        parameters: [ref("parameters", "featureId")],
        responses: {
          "204": { description: "Deleted; no body" },
          "404": ref("responses", "NotFound"),
          "500": ref("responses", "ServerError"),
        },
      },
    };
    for (const [kind, summary] of [
      ["queryables", `The properties a filter on ${c.title} may use (Part 3)`],
      ["schema", `The schema of ${c.title}'s features: returnables and receivables (Part 5)`],
    ] as const) {
      paths[`/collections/${c.id}/${kind}`] = {
        get: {
          tags: [tag],
          summary,
          operationId: `get${kind === "queryables" ? "Queryables" : "Schema"}_${c.id}`,
          parameters: [ref("parameters", "f")],
          responses: {
            "200": {
              description: "A JSON Schema (2020-12), or its HTML table",
              content: { [MEDIA.schema]: { schema: { type: "object" } }, [MEDIA.html]: { schema: { type: "string" } } },
            },
            ...errors(400, 404),
          },
        },
      };
    }
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
      "numbers carry heights (the features here are 2D). West above east crosses the antimeridian. Compared as CQL2 S_INTERSECTS.",
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
  filter: {
    name: "filter",
    in: "query",
    description:
      "A CQL2 filter (OGC 21-065r2) on the collection's queryables, in the language `filter-lang` names. Combines " +
      "with `bbox`, `datetime` and the queryable parameters by AND.",
    required: false,
    schema: { type: "string" },
  },
  "filter-lang": {
    name: "filter-lang",
    in: "query",
    description: "The language of `filter`.",
    required: false,
    schema: { type: "string", enum: ["cql2-text", "cql2-json"], default: "cql2-text" },
  },
  "filter-crs": {
    name: "filter-crs",
    in: "query",
    description: "The CRS of the geometries in `filter`.",
    required: false,
    schema: { type: "string", format: "uri", enum: [CRS84], default: CRS84 },
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
  InvalidBody: exceptionResponse(
    "The body isn't valid JSON, isn't a Feature (or a patch), or doesn't fit the collection's schema; or a Content-Crs other than CRS84",
  ),
  UnsupportedMediaType: exceptionResponse("The body's Content-Type isn't one this operation takes"),
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
