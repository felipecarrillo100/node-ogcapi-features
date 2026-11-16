import type { Request, RequestHandler, Response } from "express";
import { badRequest, sendError } from "./errors.ts";
import { type Format, format } from "./negotiate.ts";

/**
 * An OGC API route: the format negotiated first (an unknown `f` is a 400), every failure answered as an OGC exception
 * in that format.
 */
export function ogc(handler: (req: Request, res: Response, f: Format) => Promise<unknown> | unknown): RequestHandler {
  return async (req, res) => {
    const f = format(req);
    try {
      if (f === undefined) throw badRequest(`Unknown f "${String(req.query.f)}": json or html`);
      await handler(req, res, f);
    } catch (e) {
      sendError(req, res, e, f === "html");
    }
  };
}

/** `body` as JSON with the given media type (`application/json`, `application/geo+json`…). */
export function sendJson(res: Response, type: string, body: unknown): void {
  res.type(type).send(JSON.stringify(body));
}

export function sendHtml(res: Response, html: string): void {
  res.type("html").send(html);
}
