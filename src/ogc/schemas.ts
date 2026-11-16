import type { Request } from "express";
import { Router } from "express";
import { type Collection, collectionById, GEOMETRY } from "./collections.ts";
import { escapeHtml, notFound } from "./errors.ts";
import { ogc, sendHtml, sendJson } from "./handler.ts";
import { page } from "./html.ts";
import { MEDIA, selfAndAlternate, url } from "./links.ts";
import { checkParams } from "./params.ts";

const JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

export const REL = {
  queryables: "http://www.opengis.net/def/rel/ogc/1.0/queryables",
  schema: "http://www.opengis.net/def/rel/ogc/1.0/schema",
} as const;

type Property = Record<string, unknown>;

/** A queryable as the OGC API writes it: its JSON Schema, without `sqlType` / `column`, with its title and its role. */
function property(c: Collection, name: string): Property {
  const { sqlType: _s, column: _c, ...q } = c.queryables[name] as Record<string, unknown>;
  const role = name === GEOMETRY ? "primary-geometry" : name === c.instant ? "primary-instant" : undefined;
  return { ...(c.annotations[name] ?? {}), ...q, ...(role ? { "x-ogc-role": role } : {}) };
}

/**
 * `/collections/{id}/queryables` (Part 3, and Part 5's Queryables class): the properties a filter may use. Any other
 * is refused (400), so `additionalProperties` is `false`.
 */
export function queryablesDocument(req: Request, c: Collection): Property {
  return {
    $schema: JSON_SCHEMA,
    $id: url(req, `/collections/${c.id}/queryables`),
    type: "object",
    title: `${c.title}: queryables`,
    properties: Object.fromEntries(Object.keys(c.queryables).map((name) => [name, property(c, name)])),
    additionalProperties: false,
  };
}

/**
 * `/collections/{id}/schema` (Part 5, Returnables and Receivables): the feature's properties as served and as they may
 * be sent. The id is the database's (`readOnly`); the order is the column order (`x-ogc-propertySeq`).
 */
export function schemaDocument(req: Request, c: Collection): Property {
  const names = Object.keys(c.queryables);
  const properties: Record<string, Property> = {
    id: { title: "Identifier", type: "integer", readOnly: true, "x-ogc-role": "id", "x-ogc-propertySeq": 0 },
  };
  names.forEach((name, i) => {
    properties[name] = { ...property(c, name), "x-ogc-propertySeq": i + 1 };
  });
  return {
    $schema: JSON_SCHEMA,
    $id: url(req, `/collections/${c.id}/schema`),
    type: "object",
    title: c.title,
    description: c.description,
    properties,
    required: c.required,
    additionalProperties: c.openProperties,
  };
}

/** An HTML table of a schema's properties. */
function schemaHtml(doc: Property): string {
  const rows = Object.entries(doc.properties as Record<string, Property>).map(([name, p]) => {
    const { title, type, format, items, ...rest } = p;
    const kind = [type, format, items ? `of ${JSON.stringify(items)}` : undefined].filter(Boolean).join(" ");
    const more = Object.entries(rest)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("; ");
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(String(title ?? ""))}</td><td>${escapeHtml(kind)}</td><td>${escapeHtml(more)}</td></tr>`;
  });
  return [
    `<table>\n<tr><th>Property</th><th>Title</th><th>Type</th><th>Other</th></tr>\n${rows.join("\n")}\n</table>`,
    `<p>Other properties ${doc.additionalProperties ? "are" : "are not"} allowed.</p>`,
  ].join("\n");
}

/** `/collections/{collectionId}/queryables` and `/schema`. */
export function schemasRouter(): Router {
  const router = Router();
  for (const [path, label, build] of [
    ["queryables", "Queryables", queryablesDocument],
    ["schema", "Schema", schemaDocument],
  ] as const) {
    router.get(
      `/collections/:collectionId/${path}`,
      ogc((req, res, f) => {
        const c = collectionById(String(req.params.collectionId));
        if (!c) throw notFound(`No collection "${req.params.collectionId}"`);
        checkParams(req, ["f"]);
        const doc = build(req, c);
        if (f === "json") return sendJson(res, MEDIA.schema, doc);
        const crumbs = [
          ["Collections", "/collections"],
          [c.title, `/collections/${c.id}`],
          [label, `/collections/${c.id}/${path}`],
        ] as const;
        const body = `<h1>${escapeHtml(`${c.title}: ${label.toLowerCase()}`)}</h1>\n${schemaHtml(doc)}`;
        return sendHtml(
          res,
          page(req, `${c.title}: ${label}`, crumbs, body, { links: selfAndAlternate(req, f, MEDIA.schema) }),
        );
      }),
    );
  }
  return router;
}
