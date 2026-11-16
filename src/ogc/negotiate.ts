import type { Request } from "express";

export type Format = "json" | "html";

/**
 * The format asked for: `f=json` / `f=html` first, else the `Accept` header (HTML only when it's preferred to JSON),
 * else JSON. `undefined` for an `f` this server doesn't know (400).
 */
export function format(req: Request): Format | undefined {
  const f = req.query.f;
  if (f !== undefined) return f === "json" || f === "html" ? f : undefined;
  const best = req.accepts(["application/json", "application/geo+json", "application/schema+json", "text/html"]);
  return best === "text/html" ? "html" : "json";
}
