import { createRequire } from "node:module";
import path from "node:path";
import cors from "cors";
import express, { type Express } from "express";
import type { Pool } from "pg";
import { conformanceRouter } from "./conformance.ts";
import { detailsRouter } from "./details.ts";
import { featuresRouter } from "./features/routes.ts";
import { maintenanceRouter } from "./maintenance.ts";
import { collectionsRouter } from "./ogc/collections-routes.ts";
import { itemsRouter } from "./ogc/items.ts";
import { landingRouter, ogcConformanceRouter } from "./ogc/landing.ts";
import { openApiRouter } from "./ogc/openapi.ts";
import { schemasRouter } from "./ogc/schemas.ts";
import { methodNotAllowedRouter, ogcBodyErrors, optionsRouter, writesRouter } from "./ogc/writes.ts";

// MapLibre GL JS's files, served from this server (not a CDN) for the map on the HTML pages.
const MAPLIBRE_DIST = path.dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json"));

/** The server's routes on `pool`'s database, not yet listening. */
export function createApp(pool: Pool): Express {
  const app = express();
  // Express 4's query parser (qs), which Express 5 no longer uses by default: query strings read as before.
  app.set("query parser", "extended");
  // OPTIONS on the OGC API's resources: 200 with Allow (Part 4). Everywhere else, cors answers OPTIONS as before (204).
  app.use(optionsRouter(cors({ optionsSuccessStatus: 200 })));
  app.use(cors());
  app.use(express.json());

  // The REST routes MapEvolution's tests use, as they were. Order matters: /features/queryables before /features/:id.
  app.use(featuresRouter(pool));
  // /conformance: the OGC API's HTML form and its parameter checks first; a plain request reaches the REST route.
  app.use(ogcConformanceRouter());
  app.use(conformanceRouter());
  app.use(detailsRouter(pool));
  app.use(maintenanceRouter(pool));

  // OGC API Features (src/ogc/).
  app.use(landingRouter());
  app.use(openApiRouter());
  app.use(collectionsRouter(pool));
  app.use(itemsRouter(pool));
  app.use(schemasRouter());
  app.use(writesRouter(pool));
  app.use("/assets/maplibre-gl", express.static(path.join(MAPLIBRE_DIST, "dist"), { index: false }));
  // After every OGC API route: a method a resource doesn't take is a 405 (with Allow); an unreadable body a 400.
  app.use(methodNotAllowedRouter());
  app.use(ogcBodyErrors);
  return app;
}
