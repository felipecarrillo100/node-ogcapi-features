import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { createApp } from "../src/app.ts";
import { TEST_DATABASE } from "./db.ts";

export interface TestServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  pool: pg.Pool;
}

/** Starts the app on a free port against the test database for the file's tests, and stops it after them. */
export function useServer(): TestServer {
  const server = { url: "", pool: new pg.Pool(TEST_DATABASE) } as TestServer;
  let http: ReturnType<ReturnType<typeof createApp>["listen"]>;
  beforeAll(async () => {
    http = createApp(server.pool).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => http.once("listening", resolve));
    server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await server.pool.end();
  });
  return server;
}

export interface Answer<T = unknown> {
  status: number;
  contentType: string | null;
  body: T;
}

/** A request; the body parsed as JSON when the answer is JSON. */
export async function request<T = unknown>(url: string, init?: RequestInit): Promise<Answer<T>> {
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  const body = (contentType?.includes("json") ? JSON.parse(text) : text) as T;
  return { status: res.status, contentType, body };
}

/** A JSON request with a method and a body. */
export const send = <T = unknown>(url: string, method: string, body: unknown) =>
  request<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** `?filter=` for a CQL2-JSON filter. */
export const filterQuery = (filter: unknown) => `filter=${encodeURIComponent(JSON.stringify(filter))}`;
