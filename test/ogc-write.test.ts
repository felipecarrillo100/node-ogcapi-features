import type { Feature } from "geojson";
import { afterEach, describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

const GEOJSON = "application/geo+json";
const PATCH = "application/merge-patch+json";
const line = (...coords: [number, number][]) => ({ type: "LineString", coordinates: coords });

/** A request with a body of the given media type; the answer as `request` gives it, with the Location header. */
async function write(
  method: string,
  path: string,
  body: unknown,
  type = GEOJSON,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { "Content-Type": type, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location"), text, body: text ? JSON.parse(text) : undefined };
}
const get = (path: string) => request<Feature>(`${server.url}${path}`);

/** What a test created, deleted after it. */
const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) await fetch(`${server.url}${path}`, { method: "DELETE" });
});

/** POSTs a feature; its path (`/collections/…/items/{id}`), deleted after the test. */
async function create(
  collection: string,
  properties: Record<string, unknown>,
  geometry: unknown = line([0, 0], [1, 1]),
) {
  const res = await write("POST", `/collections/${collection}/items`, { type: "Feature", properties, geometry });
  expect(res.status, res.text).toBe(201);
  const path = new URL(res.location as string).pathname;
  created.push(path);
  return path;
}

describe("POST /collections/{id}/items (create)", () => {
  it("201 with Location and no body; the feature is then served as sent", async () => {
    const res = await write("POST", "/collections/routes/items", {
      type: "Feature",
      id: 12345,
      properties: { name: "Paris–Lyon", departure: "2024-08-01T11:00:00+02:00", length_km: 465, lanes: 2 },
      geometry: line([2.35, 48.86], [4.83, 45.76]),
    });
    expect(res.status).toBe(201);
    expect(res.text).toBe("");
    expect(res.location).toMatch(new RegExp(`^${server.url}/collections/routes/items/\\d+$`));
    const path = new URL(res.location as string).pathname;
    created.push(path);
    expect(path).not.toMatch(/12345$/); // the server assigns the id
    const { body } = await get(path);
    expect(body).toMatchObject({
      type: "Feature",
      // An instant comes back in UTC.
      properties: { name: "Paris–Lyon", departure: "2024-08-01T09:00:00.000Z", length_km: 465, lanes: 2 },
      geometry: line([2.35, 48.86], [4.83, 45.76]),
    });
  });

  it("features: the native lists go to their columns, the rest to the jsonb, as the REST API writes them", async () => {
    const path = await create(
      "features",
      { name: "OGC point", tags: ["a", "b"], visits: ["2024-01-02"], services: ["lift"], color: "red" },
      { type: "Point", coordinates: [3, 4] },
    );
    const id = Number(path.split("/").pop());
    const stored = await server.pool.query(
      "SELECT properties, tags, floors, to_char(visits[1], 'YYYY-MM-DD') AS visit FROM features WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]).toEqual({
      properties: { name: "OGC point", services: ["lift"], color: "red" },
      tags: ["a", "b"],
      floors: null,
      visit: "2024-01-02",
    });
    // The REST API serves it the same.
    const rest = await request<Feature>(`${server.url}/features/${id}`);
    const { links: _l, ...ogc } = (await get(path)).body as Feature & { links: unknown };
    expect(ogc).toEqual(rest.body);
  });

  it("application/json is taken too; a written feature is found by a filter", async () => {
    const res = await write(
      "POST",
      "/collections/routes/items",
      { type: "Feature", properties: { name: "Filter me" }, geometry: line([7, 7], [8, 8]) },
      "application/json",
    );
    expect(res.status).toBe(201);
    created.push(new URL(res.location as string).pathname);
    const found = await request<{ features: Feature[] }>(
      `${server.url}/collections/routes/items?filter=${encodeURIComponent("name = 'Filter me'")}`,
    );
    expect(found.body.features.map((f) => f.properties?.name)).toEqual(["Filter me"]);
  });
});

describe("PUT /collections/{id}/items/{featureId} (replace)", () => {
  it("204; the feature becomes the body: properties left out are gone, the geometry replaced, an id in the body ignored", async () => {
    const path = await create("routes", { name: "Before", lanes: 3, length_km: 10 });
    const res = await write("PUT", path, {
      type: "Feature",
      id: 1,
      properties: { name: "After" },
      geometry: line([5, 5], [6, 6]),
    });
    expect(res).toMatchObject({ status: 204, text: "" });
    const { body } = await get(path);
    expect(body.id).toBe(Number(path.split("/").pop()));
    expect(body.properties).toEqual({ name: "After" });
    expect(body.geometry).toEqual(line([5, 5], [6, 6]));
    // Feature 1 is untouched.
    expect((await get("/collections/routes/items/1")).body.properties?.name).toBe("Brussels–Paris");
  });

  it("404 for a feature that isn't there: no create-on-PUT", async () => {
    const res = await write("PUT", "/collections/routes/items/999999", {
      type: "Feature",
      properties: { name: "x" },
      geometry: line([0, 0], [1, 1]),
    });
    expect(res).toMatchObject({ status: 404, body: { code: "NotFound" } });
    expect((await get("/collections/routes/items/999999")).status).toBe(404);
  });
});

describe("PATCH /collections/{id}/items/{featureId} (update, JSON Merge Patch)", () => {
  it("flat, as the schema describes the feature: changes the given properties; null unsets; the geometry stays as stored", async () => {
    const path = await create(
      "routes",
      { name: "Patch me", lanes: 2, length_km: 100 },
      line([4.4, 50.8], [2.35, 48.86]),
    );
    const id = Number(path.split("/").pop());
    const before = await server.pool.query("SELECT ST_AsEWKB(geom) AS g FROM routes WHERE id = $1", [id]);
    const res = await write("PATCH", path, { lanes: 4, length_km: null, departure: "2024-09-01T10:00:00Z" }, PATCH);
    expect(res).toMatchObject({ status: 204, text: "" });
    expect((await get(path)).body.properties).toEqual({
      name: "Patch me",
      departure: "2024-09-01T10:00:00.000Z",
      lanes: 4,
    });
    // Not rewritten from the served (rounded) geometry: the stored 3857 bytes are the same.
    const after = await server.pool.query("SELECT ST_AsEWKB(geom) AS g FROM routes WHERE id = $1", [id]);
    expect(after.rows[0].g).toEqual(before.rows[0].g);
  });

  it("GeoJSON-shaped (properties, geometry): the same, and a geometry replaces the geometry", async () => {
    const path = await create(
      "features",
      { name: "Shape", tags: ["x"], zones: [1] },
      { type: "Point", coordinates: [1, 1] },
    );
    const res = await write(
      "PATCH",
      path,
      { type: "Feature", properties: { tags: null, zones: [2, 3] }, geometry: { type: "Point", coordinates: [9, 9] } },
      PATCH,
    );
    expect(res.status).toBe(204);
    const { body } = await get(path);
    expect(body.properties).toEqual({ name: "Shape", zones: [2, 3] });
    expect(body.geometry).toEqual({ type: "Point", coordinates: [9, 9] });
  });

  it("refuses: the id changed, the geometry removed, a required property removed, a wrong type; 415 for another media type", async () => {
    const path = await create("routes", { name: "Guarded" });
    const id = Number(path.split("/").pop());
    expect((await write("PATCH", path, { id }, PATCH)).status).toBe(204); // the same id: no change
    for (const patch of [
      { id: id + 1 },
      { geometry: null },
      { name: null },
      { lanes: "many" },
      { color: "red" },
      [1, 2],
    ]) {
      const res = await write("PATCH", path, patch, PATCH);
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.code).toBe("InvalidRequestBody");
    }
    expect((await write("PATCH", path, { lanes: 1 }, "application/json")).status).toBe(415);
    expect((await write("PATCH", "/collections/routes/items/999999", { lanes: 1 }, PATCH)).status).toBe(404);
    expect((await get(path)).body.properties).toEqual({ name: "Guarded" });
  });
});

describe("DELETE /collections/{id}/items/{featureId}", () => {
  it("204, then the feature is gone (404); deleting again is a 404", async () => {
    const path = await create("routes", { name: "Delete me" });
    const res = await fetch(`${server.url}${path}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect((await get(path)).status).toBe(404);
    expect((await fetch(`${server.url}${path}`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${server.url}/collections/routes/items/abc`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("bodies are checked against /schema (Part 4 Req 43)", () => {
  const feature = (properties: unknown, geometry: unknown = line([0, 0], [1, 1])) => ({
    type: "Feature",
    properties,
    geometry,
  });
  const refused: [string, string, unknown][] = [
    ["routes", "a wrong type", feature({ name: "x", lanes: 2.5 })],
    ["routes", "a date-time that isn't one", feature({ name: "x", departure: "tomorrow" })],
    ["routes", "a date-time on February 30", feature({ name: "x", departure: "2024-02-30T10:00:00Z" })],
    ["routes", "an unknown property (additionalProperties: false)", feature({ name: "x", color: "red" })],
    ["routes", "a missing required property", feature({ lanes: 1 })],
    ["routes", "the read-only id among the properties", feature({ name: "x", id: 5 })],
    [
      "routes",
      "another geometry type than the column's",
      feature({ name: "x" }, { type: "Point", coordinates: [0, 0] }),
    ],
    ["routes", "no geometry", { type: "Feature", properties: { name: "x" } }],
    ["features", "a list of the wrong items", feature({ zones: ["one"] })],
    ["features", "a date list with a bad date", feature({ visits: ["2024-02-30"] })],
    [
      "features",
      "an open polygon ring",
      feature(
        {},
        {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        },
      ),
    ],
    ["features", "a geometry without coordinates", feature({}, { type: "Point" })],
    ["features", "a FeatureCollection", { type: "FeatureCollection", features: [] }],
    ["features", "not a Feature", { name: "x" }],
  ];
  for (const [collection, why, body] of refused) {
    it(`400 for ${why} (${collection})`, async () => {
      const res = await write("POST", `/collections/${collection}/items`, body);
      expect(res.status, res.text).toBe(400);
      expect(res.body.code).toBe("InvalidRequestBody");
    });
  }

  it("features takes any other property (additionalProperties: true); a null property is no value", async () => {
    const path = await create(
      "features",
      { name: "Open", anything: { nested: true }, nothing: null },
      { type: "Point", coordinates: [0, 0] },
    );
    expect((await get(path)).body.properties).toEqual({ name: "Open", anything: { nested: true } });
  });

  it("an unreadable body is a 400 OGC exception; another media type a 415", async () => {
    expect(await write("POST", "/collections/routes/items", "{nope")).toMatchObject({
      status: 400,
      body: { code: "InvalidRequestBody" },
    });
    expect((await write("POST", "/collections/routes/items", "x", "text/plain")).status).toBe(415);
  });

  it("Content-Crs: CRS84 is taken; another CRS is refused (no Part 2 yet, Req 39)", async () => {
    const body = feature({ name: "CRS" });
    const crs84 = await write("POST", "/collections/routes/items", body, GEOJSON, {
      "Content-Crs": "<http://www.opengis.net/def/crs/OGC/1.3/CRS84>",
    });
    expect(crs84.status).toBe(201);
    created.push(new URL(crs84.location as string).pathname);
    const other = await write("POST", "/collections/routes/items", body, GEOJSON, {
      "Content-Crs": "<http://www.opengis.net/def/crs/EPSG/0/3857>",
    });
    expect(other.status).toBe(400);
  });
});

describe("OPTIONS and methods (Part 4 Req 1, 15, 16)", () => {
  it("OPTIONS: 200 with Allow on every OGC API resource", async () => {
    for (const [path, allow] of [
      ["/collections/routes/items", "GET, HEAD, POST, OPTIONS"],
      ["/collections/routes/items/1", "GET, HEAD, PUT, PATCH, DELETE, OPTIONS"],
      ["/collections/routes", "GET, HEAD, OPTIONS"],
      ["/", "GET, HEAD, OPTIONS"],
    ]) {
      const res = await fetch(`${server.url}${path}`, { method: "OPTIONS" });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("allow"), path).toBe(allow);
    }
    expect((await fetch(`${server.url}/collections/nope/items`, { method: "OPTIONS" })).status).toBe(404);
  });

  it("a method a resource doesn't take: 405 with Allow", async () => {
    const res = await fetch(`${server.url}/collections/routes/items/1`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, PUT, PATCH, DELETE, OPTIONS");
    expect((await fetch(`${server.url}/collections`, { method: "DELETE" })).status).toBe(405);
  });

  it("the REST API's OPTIONS answers as before (204, CORS)", async () => {
    const res = await fetch(`${server.url}/features`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PUT" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("allow")).toBeNull();
  });
});
