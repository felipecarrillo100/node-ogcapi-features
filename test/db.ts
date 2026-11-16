import type { PoolConfig } from "pg";
import { DATABASE } from "../src/config.ts";

/** The tests' own database, rebuilt for each run by `global-setup.ts`; the dev database is never touched. */
export const TEST_DATABASE: PoolConfig = { ...DATABASE, database: "spatial_rest_test_vitest" };

/** The server's own database on the same Postgres, to create and drop the test one from. */
export const ADMIN_DATABASE: PoolConfig = { ...DATABASE, database: "postgres" };
