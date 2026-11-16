import type { Request, Response } from "express";
import { page } from "./html.ts";

/** An error answered as OGC API's exception, `{ code, description }` (Part 1's `exception.yaml`), in JSON or HTML. */
export class OgcError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, description: string) {
    super(description);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (description: string): OgcError => new OgcError(400, "InvalidParameterValue", description);
export const notFound = (description: string): OgcError => new OgcError(404, "NotFound", description);

/** Answers `e` (an `OgcError`, else a 500) in the format the request asked for; HTML only when it asked for HTML. */
export function sendError(req: Request, res: Response, e: unknown, html: boolean): void {
  const err = e instanceof OgcError ? e : new OgcError(500, "ServerError", (e as Error).message);
  res.status(err.status);
  if (html) {
    res
      .type("html")
      .send(
        page(
          req,
          `Error ${err.status}`,
          [],
          `<h1>Error ${err.status}</h1><p>${escapeHtml(err.code)}: ${escapeHtml(err.message)}</p>`,
        ),
      );
  } else {
    res.json({ code: err.code, description: err.message });
  }
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
