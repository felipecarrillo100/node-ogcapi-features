/**
 * PostGIS-backed REST API that MapEvolution uses to test its sources and its Filter panel against a real backend
 * (see README.md for the routes). Filters are compiled to SQL with ogc-cql2's `toSql`, the same package that
 * evaluates them on the map.
 */
import { postgresFunctions } from "ogc-cql2/sql";
import pg from "pg";
import { createApp } from "./app.ts";
import { DATABASE, PORT } from "./config.ts";

const pool = new pg.Pool(DATABASE);

// ogc-cql2's SQL functions (CASEI, ACCENTI, dates), which the postgres dialect calls: created or replaced at startup.
await pool.query(postgresFunctions("public"));

const server = createApp(pool).listen(PORT, () => {
  console.log(`node-ogcapi-features listening on http://localhost:${PORT}`);
});

// Ctrl-C / SIGTERM: stop accepting connections, then close the pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    server.closeAllConnections();
  });
}
