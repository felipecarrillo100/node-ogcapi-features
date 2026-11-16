import type { PoolConfig } from "pg";

/** The port to listen on, and the database, from the environment; the defaults are the local Postgres.app ones. */
export const PORT = Number(process.env.PORT ?? 8020);

export const DATABASE: PoolConfig = {
  host: process.env.PGHOST ?? "localhost",
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "spatial_rest_test",
};
