import { readFile } from "node:fs/promises";
import { postgresFunctions } from "ogc-cql2/sql";
import pg from "pg";
import { ADMIN_DATABASE, TEST_DATABASE } from "./db.ts";

const sqlFile = (name: string) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

/** Builds the test database as the README sets up the dev one: schema, ogc-cql2's functions, base rows, lists. */
export default async function setup(): Promise<void> {
  const name = String(TEST_DATABASE.database);
  const admin = new pg.Client(ADMIN_DATABASE);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const db = new pg.Client(TEST_DATABASE);
  await db.connect();
  await db.query(await sqlFile("schema.sql"));
  await db.query(postgresFunctions("public"));
  await db.query(await sqlFile("seed.sql"));
  await db.query(await sqlFile("seed-lists.sql"));
  await db.query(await sqlFile("seed-routes.sql"));
  await db.end();
}
