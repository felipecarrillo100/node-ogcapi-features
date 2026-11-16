import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { filterQuery, request, send, useServer } from "./helpers.ts";

const server = useServer();

const ids = (collection: FeatureCollection) =>
  collection.features.map((f) => f.id).sort((a, b) => Number(a) - Number(b));
const features = (query = "") => request<FeatureCollection>(`${server.url}/features${query ? `?${query}` : ""}`);

describe("GET /features", () => {
  it("answers every feature as a GeoJSON FeatureCollection", async () => {
    const { status, contentType, body } = await features();
    expect(status).toBe(200);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(body.type).toBe("FeatureCollection");
    expect(ids(body)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("serves the jsonb properties and the native lists together, a NULL list absent", async () => {
    const { body } = await features();
    const byId = new Map(body.features.map((f) => [f.id, f]));
    expect(byId.get(7)).toEqual({
      type: "Feature",
      id: 7,
      properties: {
        name: "Brussels",
        zones: [1, 2],
        services: ["lift", "toilets", "parking"],
        inspections: ["2024-02-29", "2024-03-01"],
        tags: ["museum", "station"],
        floors: [0, 1, 2],
        visits: ["2024-05-01", "2024-06-01"],
      },
      geometry: { type: "Point", coordinates: [4.4, 50.8] },
    });
    // Cairo: no native lists at all; Europe-Africa line: floors NULL.
    expect(byId.get(11)?.properties).toEqual({
      name: "Cairo",
      zones: [2],
      services: ["toilets", "lift", "lift"],
      inspections: ["2024-03-02"],
    });
    expect(byId.get(13)?.properties).toEqual({
      name: "Europe-Africa line",
      tags: ["station", "museum"],
      visits: ["2024-05-01"],
    });
  });

  it("bbox: the features whose bounding box meets it (&&)", async () => {
    const { status, body } = await features("bbox=4,50,5,51");
    expect(status).toBe(200);
    expect(ids(body)).toEqual([7, 13, 14]);
  });

  it("bbox: refuses a value that isn't a number", async () => {
    const { status, body } = await features("bbox=4,50,5,x");
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid bbox "4,50,5,x" — expected minx,miny,maxx,maxy' });
  });

  it("bbox: three numbers aren't refused, and select nothing (a NULL envelope), as before", async () => {
    const { status, body } = await features("bbox=4,50,5");
    expect(status).toBe(200);
    expect(body).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("filter: CASEI LIKE (names starting with b, any case)", async () => {
    const filter = {
      op: "like",
      args: [
        { op: "casei", args: [{ property: "name" }] },
        { op: "casei", args: ["b%"] },
      ],
    };
    expect(ids((await features(filterQuery(filter))).body)).toEqual([7, 14]);
  });

  it("filter: A_CONTAINS on a jsonb list", async () => {
    const filter = { op: "a_contains", args: [{ property: "services" }, ["lift", "toilets"]] };
    expect(ids((await features(filterQuery(filter))).body)).toEqual([7, 11]);
  });

  it("filter: a native date list and S_INTERSECTS", async () => {
    const filter = {
      op: "and",
      args: [
        { op: "a_overlaps", args: [{ property: "visits" }, [{ date: "2024-06-01" }]] },
        { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [-10, 35, 30, 60] }] },
      ],
    };
    expect(ids((await features(filterQuery(filter))).body)).toEqual([7]);
  });

  it("filter and bbox combine with AND", async () => {
    const filter = { op: "a_contains", args: [{ property: "tags" }, ["station"]] };
    expect(ids((await features(filterQuery(filter))).body)).toEqual([7, 10, 13]);
    expect(ids((await features(`bbox=4,50,5,51&${filterQuery(filter)}`)).body)).toEqual([7, 13]);
  });

  it("filter: refuses one that isn't JSON", async () => {
    const { status, body } = await features("filter=%7Bnope");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Invalid filter: not valid JSON" });
  });

  it("filter: refuses a property that isn't a queryable, with code and path", async () => {
    const { status, body } = await features(filterQuery({ op: "=", args: [{ property: "nope" }, 1] }));
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "unknown-property", path: "/args/0" });
    expect((body as unknown as { error: string }).error).toMatch(/^Invalid filter: /);
  });

  it("filter: refuses a class the server doesn't declare (needs-conformance)", async () => {
    const filter = { op: ">", args: [{ op: "+", args: [{ property: "name" }, 1] }, 2] };
    const { status, body } = await features(filterQuery(filter));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: "Invalid filter: this server doesn't support http://www.opengis.net/spec/cql2/1.0/conf/arithmetic",
      code: "needs-conformance",
    });
  });
});

describe("GET /features/queryables", () => {
  it("answers the Part 3 form, without the server's own sqlType and column", async () => {
    const { status, body } = await request(`${server.url}/features/queryables`);
    expect(status).toBe(200);
    expect(body).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        name: { type: "string" },
        services: { type: "array", items: { type: "string" } },
        zones: { type: "array", items: { type: "integer" } },
        inspections: { type: "array", items: { type: "string", format: "date" } },
        tags: { type: "array", items: { type: "string" } },
        floors: { type: "array", items: { type: "integer" } },
        visits: { type: "array", items: { type: "string", format: "date" } },
        geometry: { format: "geometry-any" },
      },
    });
  });
});

describe("/features/:id CRUD", () => {
  it("GET: one feature, or 404", async () => {
    const found = await request<Feature>(`${server.url}/features/12`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({
      type: "Feature",
      id: 12,
      properties: { name: "Rio de Janeiro" },
      geometry: { type: "Point", coordinates: [-43.2, -22.9] },
    });
    const missing = await request(`${server.url}/features/999999`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Feature 999999 not found" });
  });

  it("POST, PUT, DELETE: the native lists go to their columns and come back in the properties", async () => {
    const created = await send<Feature>(`${server.url}/features`, "POST", {
      type: "Feature",
      properties: { name: "test point", tags: ["a", "b"], services: ["lift"] },
      geometry: { type: "Point", coordinates: [1, 2] },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body).toEqual({
      type: "Feature",
      id,
      properties: { name: "test point", tags: ["a", "b"], services: ["lift"] },
      geometry: { type: "Point", coordinates: [1, 2] },
    });
    const stored = await server.pool.query("SELECT properties, tags FROM features WHERE id = $1", [id]);
    expect(stored.rows[0]).toEqual({ properties: { name: "test point", services: ["lift"] }, tags: ["a", "b"] });

    const replaced = await send<Feature>(`${server.url}/features/${id}`, "PUT", {
      type: "Feature",
      properties: { name: "moved", floors: [1] },
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({
      type: "Feature",
      id,
      properties: { name: "moved", floors: [1] },
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    });

    const deleted = await request(`${server.url}/features/${id}`, { method: "DELETE" });
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } });
    const again = await request(`${server.url}/features/${id}`, { method: "DELETE" });
    expect(again).toMatchObject({ status: 200, body: { deleted: false } });
  });

  it("POST and PUT refuse a native list that isn't a list", async () => {
    const feature = {
      type: "Feature",
      properties: { tags: "museum" },
      geometry: { type: "Point", coordinates: [0, 0] },
    };
    for (const [url, method] of [
      [`${server.url}/features`, "POST"],
      [`${server.url}/features/7`, "PUT"],
    ] as const) {
      const { status, body } = await send(url, method, feature);
      expect(status).toBe(400);
      expect(body).toEqual({ error: "tags, floors, visits must be lists" });
    }
  });

  it("PUT: 404 for an id that doesn't exist", async () => {
    const { status, body } = await send(`${server.url}/features/999999`, "PUT", {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: "Feature 999999 not found" });
  });

  it("POST without a geometry: 500 with the database's reason, as before", async () => {
    const { status, body } = await send(`${server.url}/features`, "POST", { type: "Feature", properties: {} });
    expect(status).toBe(500);
    expect(body).toHaveProperty("error");
  });
});
