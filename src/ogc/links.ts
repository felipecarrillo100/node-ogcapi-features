import type { Request } from "express";

export interface Link {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

export const MEDIA = {
  json: "application/json",
  geojson: "application/geo+json",
  html: "text/html",
  openapi: "application/vnd.oai.openapi+json;version=3.0",
  schema: "application/schema+json",
} as const;

/**
 * The server's base URL as the client reached it (`http://localhost:8020`, `http://host.docker.internal:8020`…), so
 * every link works from where the request came.
 */
export const baseUrl = (req: Request): string => `${req.protocol}://${req.get("host") ?? "localhost"}`;

/** An absolute URL: `path` on the server, with `query` (an `undefined` value left out). */
export function url(req: Request, path: string, query: Record<string, string | number | undefined> = {}): string {
  const u = new URL(path, baseUrl(req));
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** The request's own query, as strings (repeated parameters were refused before). */
export function ownQuery(req: Request): Record<string, string> {
  return Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
}

/**
 * `self` and `alternate` for a resource with a JSON form (`jsonType`) and an HTML one, keeping the request's query
 * but its `f`.
 */
export function selfAndAlternate(
  req: Request,
  format: "json" | "html",
  jsonType: string,
  extra: Record<string, string | number | undefined> = {},
): Link[] {
  const query = { ...ownQuery(req), ...extra };
  const json: Link = {
    href: url(req, req.path, { ...query, f: "json" }),
    type: jsonType,
    title: "This document as JSON",
    rel: "",
  };
  const html: Link = {
    href: url(req, req.path, { ...query, f: "html" }),
    type: MEDIA.html,
    title: "This document as HTML",
    rel: "",
  };
  return format === "json"
    ? [
        { ...json, rel: "self" },
        { ...html, rel: "alternate" },
      ]
    : [
        { ...html, rel: "self" },
        { ...json, rel: "alternate" },
      ];
}
