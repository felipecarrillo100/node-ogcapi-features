import type { Request, RequestHandler, Response } from "express";

/**
 * A route handler whose failure answers 500 `{ error: message }`, as every route of this server has done. Only the
 * handler's own errors: a body Express can't parse still gets Express's own answer (400), as before.
 */
export function route(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  };
}

/** The JSON body, or `{}` without one (Express 5 leaves `req.body` undefined where Express 4 gave `{}`). */
export function body<T>(req: Request): Partial<T> {
  return (req.body ?? {}) as Partial<T>;
}
