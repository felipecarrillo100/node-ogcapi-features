import type { Feature, FeatureCollection } from "geojson";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { filterQuery, request, send, useServer } from "./helpers.ts";

const server = useServer();

const routes = (query = "") => request<FeatureCollection>(`${server.url}/restapi/routes${query ? `?${query}` : ""}`);
const ids = (c: FeatureCollection) => c.features.map((f) => f.id);
const line = (...coords: [number, number][]) => ({ type: "LineString", coordinates: coords });

/** The same features from the OGC API, and its queryables: what the map evaluates a filter on. */
let ogc: Feature[] = [];
let queryables: Record<string, object> = {};
beforeAll(async () => {
  ogc = (await request<FeatureCollection>(`${server.url}/collections/routes/items?limit=10000`)).body.features;
  queryables = (await request<{ properties: Record<string, object> }>(`${server.url}/collections/routes/queryables`))
    .body.properties;
});

/** What a test created, deleted after it. */
const created: number[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await fetch(`${server.url}/restapi/routes/${id}`, { method: "DELETE" });
});

describe("GET /restapi/routes", () => {
  it("every route, as the OGC API serves it (CRS84 geometry, postgresValue properties)", async () => {
    const { status, contentType, body } = await routes();
    expect(status).toBe(200);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(body.type).toBe("FeatureCollection");
    expect(ids(body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(body.features).toEqual(ogc.map(({ links: _l, ...f }: Feature & { links?: unknown }) => f));
    expect(body.features[0]?.properties).toEqual({
      name: "Brussels–Paris",
      departure: "2024-05-01T08:00:00.000Z",
      length_km: 264,
      lanes: 3,
    });
    expect(body.features[0]?.geometry).toEqual(line([4.4, 50.8], [2.35, 48.86]));
    // NULLs are left out, as missing properties.
    expect(body.features.find((f) => f.id === 4)?.properties).not.toHaveProperty("departure");
  });

  it("bbox: the routes whose envelope meets the box (&&, as /restapi/features)", async () => {
    expect(ids((await routes("bbox=4,50,5,51")).body)).toEqual([1, 2, 3, 9, 10]);
    expect(ids((await routes("bbox=139,35,140,36")).body)).toEqual([4, 5]);
  });

  it("bbox: 400 for anything but 4 numbers", async () => {
    for (const bbox of ["4,50,5", "4,50,5,x", "a"]) {
      const { status, body } = await routes(`bbox=${bbox}`);
      expect(status, bbox).toBe(400);
      expect((body as unknown as { error: string }).error).toMatch(/Invalid bbox/);
    }
  });

  const FILTERS = [
    "lanes = 2",
    "lanes IS NULL",
    "length_km BETWEEN 100 AND 1000",
    "length_km / lanes > 1000",
    "CASEI(name) LIKE CASEI('%brussels%')",
    "T_BEFORE(departure, TIMESTAMP('2024-05-02T00:00:00Z'))",
    "departure > TIMESTAMP('2024-06-01T00:00:00Z') AND lanes = 2",
    "S_INTERSECTS(geometry, BBOX(4, 50, 5, 51))",
    "S_INTERSECTS(geometry, POINT(4.4 50.8))",
  ];
  for (const text of FILTERS) {
    it(`filter ${text}: the same routes as evaluate (the map) and the OGC API`, async () => {
      const filter = fromText(text) as Cql2Filter;
      const { status, body } = await routes(filterQuery(filter));
      expect(status).toBe(200);
      const map = ogc.filter((f) => evaluate(filter, f, { queryables }) === true).map((f) => f.id);
      expect(ids(body)).toEqual(map);
      const viaOgc = await request<FeatureCollection>(
        `${server.url}/collections/routes/items?limit=10000&filter-lang=cql2-json&${filterQuery(filter)}`,
      );
      expect(ids(body)).toEqual(ids(viaOgc.body));
    });
  }

  it("filter and bbox combine with AND", async () => {
    const filter = { op: ">=", args: [{ property: "lanes" }, 2] };
    expect(ids((await routes(`bbox=4,50,5,51&${filterQuery(filter)}`)).body)).toEqual([1, 2, 3, 10]);
  });

  it("filter: 400 with code and path, as /restapi/features answers", async () => {
    const cases: [unknown, RegExp, string][] = [
      [{ op: "=", args: [{ property: "nope" }, 1] }, /nope/, "unknown-property"],
      [{ op: "=", args: [{ property: "lanes" }, "two"] }, /./, "type-mismatch"],
      [{ op: "t_before", args: [{ property: "departure" }, { date: "2024-05-02" }] }, /./, "type-mismatch"],
    ];
    for (const [filter, message, code] of cases) {
      const { status, body } = await routes(filterQuery(filter));
      const err = body as unknown as { error: string; code: string; path: string };
      expect(status, JSON.stringify(filter)).toBe(400);
      expect(err.error).toMatch(/^Invalid filter: /);
      expect(err.error).toMatch(message);
      expect(err.code).toBe(code);
      expect(err.path).toMatch(/^\/args\//);
    }
    const bad = await routes("filter=%7Bnope");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Invalid filter: not valid JSON" });
  });
});

describe("GET /restapi/routes/queryables", () => {
  it("the Part 3 form, the same properties as the OGC API's queryables", async () => {
    const { status, body } = await request<{ $schema: string; type: string; properties: Record<string, unknown> }>(
      `${server.url}/restapi/routes/queryables`,
    );
    expect(status).toBe(200);
    expect(body.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(body.type).toBe("object");
    expect(Object.keys(body.properties)).toEqual(["name", "departure", "length_km", "lanes", "geometry"]);
    expect(body.properties.departure).toEqual({ type: "string", format: "date-time" });
    expect(JSON.stringify(body)).not.toMatch(/sqlType|served_geom/);
  });
});

describe("/restapi/routes/:id CRUD", () => {
  it("GET: the route, or 404", async () => {
    const found = await request<Feature>(`${server.url}/restapi/routes/1`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual((await routes()).body.features[0]);
    for (const id of ["999999", "abc", "1.5"]) {
      const missing = await request(`${server.url}/restapi/routes/${id}`);
      expect(missing.status, id).toBe(404);
      expect(missing.body).toEqual({ error: `Route ${id} not found` });
    }
  });

  it("POST: 201 with the stored route, in CRS84; stored in EPSG:3857", async () => {
    const created1 = await send<Feature>(`${server.url}/restapi/routes`, "POST", {
      properties: { name: "Test line", departure: "2024-08-01T10:00:00Z", lanes: 2 },
      geometry: line([4.4, 50.8], [5, 51]),
    });
    expect(created1.status).toBe(201);
    const id = created1.body.id as number;
    created.push(id);
    expect(created1.body).toEqual({
      type: "Feature",
      id,
      properties: { name: "Test line", departure: "2024-08-01T10:00:00.000Z", lanes: 2 },
      geometry: line([4.4, 50.8], [5, 51]),
    });
    const stored = await server.pool.query<{ srid: number }>("SELECT ST_SRID(geom) AS srid FROM routes WHERE id = $1", [
      id,
    ]);
    expect(stored.rows[0]?.srid).toBe(3857);
    // The OGC API serves the same feature.
    const viaOgc = await request<Feature>(`${server.url}/collections/routes/items/${id}`);
    const { links: _l, ...feature } = viaOgc.body as Feature & { links?: unknown };
    expect(feature).toEqual(created1.body);
  });

  it("PUT: 200 with the replaced route; properties left out are unset; 404 for an unknown id", async () => {
    const id = (
      await send<Feature>(`${server.url}/restapi/routes`, "POST", {
        properties: { name: "Before", lanes: 1, length_km: 10 },
        geometry: line([0, 0], [1, 1]),
      })
    ).body.id as number;
    created.push(id);
    const replaced = await send<Feature>(`${server.url}/restapi/routes/${id}`, "PUT", {
      properties: { name: "After", lanes: 3 },
      geometry: line([2, 2], [3, 3]),
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({
      type: "Feature",
      id,
      properties: { name: "After", lanes: 3 },
      geometry: line([2, 2], [3, 3]),
    });
    expect((await request(`${server.url}/restapi/routes/${id}`)).body).toEqual(replaced.body);
    const missing = await send(`${server.url}/restapi/routes/999999`, "PUT", {
      properties: { name: "x" },
      geometry: line([0, 0], [1, 1]),
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Route 999999 not found" });
  });

  it("DELETE: { deleted: true }, then { deleted: false }", async () => {
    const id = (
      await send<Feature>(`${server.url}/restapi/routes`, "POST", {
        properties: { name: "Gone" },
        geometry: line([0, 0], [1, 1]),
      })
    ).body.id as number;
    const deleted = await request(`${server.url}/restapi/routes/${id}`, { method: "DELETE" });
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await request(`${server.url}/restapi/routes/${id}`, { method: "DELETE" })).body).toEqual({
      deleted: false,
    });
    expect((await request(`${server.url}/restapi/routes/${id}`)).status).toBe(404);
    expect((await request(`${server.url}/restapi/routes/abc`, { method: "DELETE" })).body).toEqual({ deleted: false });
  });

  it("POST and PUT refuse a body that doesn't fit the schema: 400 { error }", async () => {
    const cases: [unknown, RegExp][] = [
      [{ properties: { lanes: 2 }, geometry: line([0, 0], [1, 1]) }, /Missing property "name"/],
      [{ properties: { name: "x", lanes: "two" }, geometry: line([0, 0], [1, 1]) }, /Invalid property "lanes"/],
      [{ properties: { name: "x", colour: "red" }, geometry: line([0, 0], [1, 1]) }, /Unknown property "colour"/],
      [{ properties: { name: "x", departure: "2024-02-30T00:00:00Z" }, geometry: line([0, 0], [1, 1]) }, /departure/],
      [{ properties: { name: "x" }, geometry: { type: "Point", coordinates: [0, 0] } }, /LineString/],
      [{ properties: { name: "x" } }, /Missing geometry/],
      [{ properties: [1], geometry: line([0, 0], [1, 1]) }, /properties must be an object/],
    ];
    for (const [body, message] of cases) {
      for (const [url, method] of [
        [`${server.url}/restapi/routes`, "POST"],
        [`${server.url}/restapi/routes/1`, "PUT"],
      ] as const) {
        const res = await send<{ error: string }>(url, method, body);
        expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(400);
        expect(res.body.error).toMatch(message);
      }
    }
    // Nothing was written: route 1 is as seeded.
    expect((await request<Feature>(`${server.url}/restapi/routes/1`)).body.properties?.name).toBe("Brussels–Paris");
    expect(ids((await routes()).body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
