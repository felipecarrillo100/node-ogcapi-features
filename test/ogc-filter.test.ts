import type { Feature, FeatureCollection } from "geojson";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { postgresValue, type SqlColumn } from "ogc-cql2/sql";
import { beforeAll, describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

type Items = FeatureCollection & { numberMatched: number };
type Schema = {
  $schema: string;
  $id: string;
  type: string;
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: boolean;
};

const items = (collection: string, query: Record<string, string>) =>
  request<Items>(`${server.url}/collections/${collection}/items?${new URLSearchParams({ limit: "10000", ...query })}`);
const ids = (c: FeatureCollection) => c.features.map((f) => f.id);

/** Every feature of each collection, as served, and its queryables: what the map has to evaluate a filter. */
const all: Record<string, Feature[]> = {};
const queryables: Record<string, Schema> = {};
beforeAll(async () => {
  for (const c of ["features", "routes"]) {
    all[c] = (await items(c, {})).body.features;
    queryables[c] = (await request<Schema>(`${server.url}/collections/${c}/queryables`)).body;
  }
});

/** The ids ogc-cql2's `evaluate` selects among the served features: the map's own answer. */
function onTheMap(collection: string, filter: Cql2Filter): unknown[] {
  const options = { queryables: queryables[collection]?.properties };
  return (all[collection] as Feature[]).filter((f) => evaluate(filter, f, options) === true).map((f) => f.id);
}

/**
 * Filters run by the server and by `evaluate` on the same features (spatial ones only S_INTERSECTS, which `evaluate`
 * runs without a geometry engine). `expected` pins the answer where it's a known case.
 */
const CASES: { collection: string; text: string; expected?: number[]; why?: string }[] = [
  // The ldproxy 4.8.2 failures (OGC-API-TASK.md): a missing property is NULL, so NOT … doesn't select it.
  {
    collection: "features",
    text: "NOT A_OVERLAPS(tags, ('museum'))",
    expected: [8, 10],
    why: "ldproxy: selects features without tags",
  },
  {
    collection: "features",
    text: "NOT A_CONTAINS(services, ('lift'))",
    expected: [10, 14],
    why: "ldproxy: selects features without services",
  },
  {
    collection: "features",
    text: "A_EQUALS(services, ('toilets', 'lift', 'lift'))",
    expected: [11],
    why: "ldproxy: a repeated value selects nothing",
  },
  {
    collection: "features",
    text: "A_CONTAINS(tags, ())",
    expected: [7, 8, 9, 10, 13],
    why: "ldproxy: an empty list hangs",
  },
  { collection: "features", text: "A_OVERLAPS(services, tags)", expected: [], why: "ldproxy: list against list hangs" },
  {
    collection: "features",
    text: "A_OVERLAPS(visits, (DATE('2024-06-01')))",
    expected: [7, 9],
    why: "ldproxy: DATE() in an array fails in CQL2-text",
  },
  // The other array functions, on both storages.
  { collection: "features", text: "A_CONTAINEDBY(floors, (0, 1, 2, 3))", expected: [7, 8, 9, 10] },
  { collection: "features", text: "A_OVERLAPS(inspections, (DATE('2024-03-01')))", expected: [7, 8] },
  { collection: "features", text: "A_CONTAINS(services, ('lift', 'toilets'))", expected: [7, 11] },
  { collection: "features", text: "A_EQUALS(zones, (2, 1))", expected: [7] },
  // Comparison, case and accent insensitivity, property-property, IS NULL, spatial.
  { collection: "features", text: "CASEI(name) LIKE CASEI('b%')", expected: [7, 14] },
  { collection: "features", text: "ACCENTI(name) = ACCENTI('Cairo')", expected: [11] },
  { collection: "features", text: "name IN ('Tokyo', 'Sydney')", expected: [8, 10] },
  { collection: "features", text: "floors IS NULL", expected: [11, 12, 13, 14] },
  { collection: "features", text: "name = name", expected: [7, 8, 9, 10, 11, 12, 13, 14] },
  { collection: "features", text: "S_INTERSECTS(geometry, BBOX(4, 50, 5, 51))", expected: [7, 13, 14] },
  // routes: an instant, numbers, a 3857 geometry.
  {
    collection: "routes",
    text: "T_AFTER(departure, TIMESTAMP('2024-06-01T00:00:00Z'))",
    expected: [5, 6, 7, 8, 9, 10],
  },
  {
    collection: "routes",
    text: "NOT T_AFTER(departure, TIMESTAMP('2024-06-01T00:00:00Z'))",
    expected: [1, 2, 3],
    why: "a NULL departure is neither",
  },
  { collection: "routes", text: "T_EQUALS(departure, TIMESTAMP('2024-05-01T08:00:00Z'))", expected: [1, 2] },
  {
    collection: "routes",
    text: "T_INTERSECTS(departure, INTERVAL('2024-05-01T00:00:00Z', '2024-05-31T23:59:59Z'))",
    expected: [1, 2, 3],
  },
  { collection: "routes", text: "T_BEFORE(departure, TIMESTAMP('2024-05-02T00:00:00Z'))", expected: [1, 2] },
  { collection: "routes", text: "departure > TIMESTAMP('2024-06-01T00:00:00Z') AND lanes = 2", expected: [7] },
  { collection: "routes", text: "length_km / lanes > 1000", expected: [3, 4, 5, 7, 9] },
  { collection: "routes", text: "lanes * 2 >= 6", expected: [1, 8, 10] },
  { collection: "routes", text: "length_km BETWEEN 100 AND 1000", expected: [1, 2, 8] },
  { collection: "routes", text: "lanes IS NULL", expected: [6] },
  { collection: "routes", text: "CASEI(name) LIKE CASEI('%brussels%')", expected: [1, 2, 3, 9, 10] },
  { collection: "routes", text: "S_INTERSECTS(geometry, BBOX(4, 50, 5, 51))", expected: [1, 2, 3, 9, 10] },
  { collection: "routes", text: "S_INTERSECTS(geometry, POINT(4.4 50.8))", expected: [1, 2, 3, 9] },
];

describe("filter: the server answers as the map does (ogc-cql2 evaluate)", () => {
  for (const { collection, text, expected, why } of CASES) {
    it(`${collection}: ${text}${why ? ` (${why})` : ""}`, async () => {
      const json = fromText(text);
      const mapIds = onTheMap(collection, json);
      // CQL2-text is the default filter-lang (Part 3); the same filter in CQL2-JSON answers the same.
      const asText = await items(collection, { filter: text });
      const asJson = await items(collection, { filter: JSON.stringify(json), "filter-lang": "cql2-json" });
      expect(asText.status, JSON.stringify(asText.body)).toBe(200);
      expect(ids(asText.body)).toEqual(mapIds);
      expect(ids(asJson.body)).toEqual(mapIds);
      expect(asText.body.numberMatched).toBe(mapIds.length);
      if (expected) expect(mapIds).toEqual(expected);
    });
  }

  it("CASEI in CQL2-JSON (ldproxy: refused with 400)", async () => {
    const filter = {
      op: "=",
      args: [
        { op: "casei", args: [{ property: "name" }] },
        { op: "casei", args: ["brussels"] },
      ],
    };
    const res = await items("features", { filter: JSON.stringify(filter), "filter-lang": "cql2-json" });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(onTheMap("features", filter as unknown as Cql2Filter));
    expect(ids(res.body)).toEqual([7]);
  });

  it("Spatial Functions (beyond S_INTERSECTS) run too, though evaluate needs a geometry engine for them", async () => {
    const europe = "POLYGON((-10 35, 35 35, 35 60, -10 60, -10 35))";
    expect(ids((await items("features", { filter: `S_WITHIN(geometry, ${europe})` })).body)).toEqual([7, 14]);
    expect(ids((await items("routes", { filter: `S_WITHIN(geometry, ${europe})` })).body)).toEqual([1, 2, 10]);
  });
});

describe("filter with the other parameters", () => {
  it("combines with bbox, datetime and the queryable parameters by AND", async () => {
    const res = await items("routes", {
      filter: "lanes >= 2",
      bbox: "-80,-30,10,55",
      datetime: "2024-05-01/2024-07-31",
      name: "New York–Boston",
    });
    expect(ids(res.body)).toEqual([8]);
    expect(ids((await items("routes", { filter: "lanes >= 2", bbox: "-80,-30,10,55" })).body)).toEqual([
      1, 2, 3, 7, 8, 10,
    ]);
  });

  it("filter-crs: CRS84 is accepted; any other CRS is refused until Part 2 (400)", async () => {
    const crs84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
    expect(ids((await items("routes", { filter: "lanes = 6", "filter-crs": crs84 })).body)).toEqual([10]);
    const other = await items("routes", {
      filter: "lanes = 6",
      "filter-crs": "http://www.opengis.net/def/crs/EPSG/0/3857",
    });
    expect(other).toMatchObject({ status: 400, body: { code: "InvalidParameterValue" } });
  });

  it("the HTML page's map fetches the features with the same filter", async () => {
    const page = await request<string>(
      `${server.url}/collections/routes/items?f=html&filter=${encodeURIComponent("lanes = 6")}`,
    );
    expect(page.body).toContain(
      `fetch(${JSON.stringify(`${server.url}/collections/routes/items?f=json&filter=lanes+%3D+6`)}`,
    );
    expect(page.body).toContain(">10</a>");
  });
});

describe("filter errors: 400, with ogc-cql2's reason", () => {
  const refused = async (collection: string, query: Record<string, string>, reason: RegExp) => {
    const res = await items(collection, query);
    expect(res.status, JSON.stringify(query)).toBe(400);
    expect(res.body).toMatchObject({ code: "InvalidParameterValue" });
    expect((res.body as unknown as { description: string }).description).toMatch(reason);
  };

  it("an unknown filter-lang, invalid CQL2-text, invalid JSON", async () => {
    await refused("routes", { filter: "lanes = 1", "filter-lang": "ecql" }, /filter-lang "ecql"/);
    await refused("routes", { filter: "name LIKE" }, /invalid-text/);
    await refused("routes", { filter: "{nope", "filter-lang": "cql2-json" }, /not valid JSON/);
  });

  it("a property that isn't a queryable (additionalProperties: false)", async () => {
    await refused("routes", { filter: "nope = 1" }, /unknown-property at \/args\/0/);
    await refused("features", { filter: "departure > TIMESTAMP('2024-01-01T00:00:00Z')" }, /unknown-property/);
  });

  it("a filter CQL2 itself refuses (ogc-cql2's validate, with the queryables): every problem listed, with its path", async () => {
    await refused(
      "routes",
      { filter: "T_DURING(departure, INTERVAL('2024-05-01T00:00:00Z', '2024-05-31T23:59:59Z'))" },
      /invalid-filter at \/args\/0/,
    );
    // An instant against a date: CQL2 never converts one into the other.
    await refused("routes", { filter: "T_BEFORE(departure, DATE('2024-05-02'))" }, /type-mismatch at \/args\/1/);
    await refused("routes", { filter: "myfn(name)" }, /Functions/);
    // Two problems at once, both reported.
    await refused(
      "routes",
      { filter: "nope = 1 AND lanes = 'x'" },
      /unknown-property at \/args\/0\/args\/0.*; .*type-mismatch/,
    );
  });
});

describe("queryables as query parameters (Part 3)", () => {
  it("each simple queryable selects by equality, typed as its queryable says", async () => {
    expect(ids((await items("features", { name: "Brussels" })).body)).toEqual([7]);
    expect(ids((await items("routes", { lanes: "2" })).body)).toEqual([2, 3, 7]);
    expect(ids((await items("routes", { length_km: "264" })).body)).toEqual([1]);
    expect(ids((await items("routes", { name: "Brussels–Paris", lanes: "3" })).body)).toEqual([1]);
  });

  it("a value of the wrong type is a 400; a list, an instant or the geometry isn't a parameter", async () => {
    expect((await items("routes", { lanes: "x" })).status).toBe(400);
    expect((await items("routes", { lanes: "1.5" })).status).toBe(400);
    for (const [collection, name] of [
      ["routes", "departure"],
      ["routes", "geometry"],
      ["features", "tags"],
    ] as const) {
      expect((await items(collection, { [name]: "x" })).status, name).toBe(400);
    }
  });
});

describe("/queryables and /schema", () => {
  it("/queryables: JSON Schema 2020-12, application/schema+json, $id without the query, roles, no SQL keys", async () => {
    const { status, contentType, body } = await request<Schema>(`${server.url}/collections/routes/queryables?f=json`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/schema+json; charset=utf-8");
    expect(body).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${server.url}/collections/routes/queryables`,
      type: "object",
      title: "Routes: queryables",
      properties: {
        name: { title: "Name", type: "string" },
        departure: { title: "Departure (UTC)", type: "string", format: "date-time", "x-ogc-role": "primary-instant" },
        length_km: { title: "Length", "x-ogc-unit": "km", type: "number" },
        lanes: { title: "Lanes", type: "integer" },
        geometry: { title: "Geometry", format: "geometry-linestring", "x-ogc-role": "primary-geometry" },
      },
      additionalProperties: false,
    });
  });

  it("/queryables of features: the REST API's queryables, the same types", async () => {
    const ogc = (await request<Schema>(`${server.url}/collections/features/queryables`)).body;
    const rest = (await request<Schema>(`${server.url}/features/queryables`)).body;
    for (const [name, q] of Object.entries(rest.properties)) expect(ogc.properties[name]).toMatchObject(q);
    expect(Object.keys(ogc.properties)).toEqual(Object.keys(rest.properties));
  });

  it("/schema: the id (readOnly) and every property in column order; closed for routes, open for features", async () => {
    const routes = (await request<Schema>(`${server.url}/collections/routes/schema`)).body;
    expect(routes.$id).toBe(`${server.url}/collections/routes/schema`);
    expect(routes.properties.id).toEqual({
      title: "Identifier",
      type: "integer",
      readOnly: true,
      "x-ogc-role": "id",
      "x-ogc-propertySeq": 0,
    });
    expect(Object.entries(routes.properties).map(([k, p]) => `${p["x-ogc-propertySeq"]} ${k}`)).toEqual([
      "0 id",
      "1 name",
      "2 departure",
      "3 length_km",
      "4 lanes",
      "5 geometry",
    ]);
    expect(routes.additionalProperties).toBe(false);
    const features = (await request<Schema>(`${server.url}/collections/features/schema`)).body;
    expect(features.additionalProperties).toBe(true);
    expect(features.properties.geometry).toMatchObject({ format: "geometry-any", "x-ogc-role": "primary-geometry" });
    // Part 5: exactly one id, at most one primary geometry and one primary instant; every non-spatial property typed.
    for (const schema of [routes, features]) {
      const roles = Object.values(schema.properties).map((p) => p["x-ogc-role"]);
      expect(roles.filter((r) => r === "id")).toHaveLength(1);
      expect(roles.filter((r) => r === "primary-geometry")).toHaveLength(1);
      expect(roles.filter((r) => r === "primary-instant").length).toBeLessThanOrEqual(1);
      for (const p of Object.values(schema.properties))
        if (!String(p.format ?? "").startsWith("geometry-")) expect(p).toHaveProperty("type");
    }
  });

  it("as HTML, and 404 for another collection", async () => {
    for (const kind of ["queryables", "schema"]) {
      const html = await request<string>(`${server.url}/collections/routes/${kind}?f=html`);
      expect(html.contentType).toBe("text/html; charset=utf-8");
      expect(html.body).toContain("<td>departure</td>");
      expect((await request(`${server.url}/collections/nope/${kind}`)).status).toBe(404);
    }
  });
});

describe("ogc-cql2's PostgreSQL rules: bbox, datetime and the served values", () => {
  // Brussels is the point (4.4, 50.8); the Brussels ring is a line through (4.3, 50.8), (4.4, 50.9), (4.5, 50.8)…
  const boxes = [
    "4,50,4.4,51", // Brussels on the east edge
    "4.4,50.8,5,51", // Brussels on the south-west corner
    "4.5,50,6,51", // the ring touching the west edge at one vertex
    "4.4,50.9,5,52", // the ring's top vertex on the corner
    "130,-50,-60,50", // across the antimeridian
  ];
  for (const box of boxes) {
    it(`bbox=${box}: the features the map's S_INTERSECTS selects, also on an edge or a corner`, async () => {
      const bbox = box.split(",").map(Number);
      for (const collection of ["features", "routes"]) {
        const filter = { op: "s_intersects", args: [{ property: "geometry" }, { bbox }] } as unknown as Cql2Filter;
        const served = ids((await items(collection, { bbox: box })).body);
        expect(served, `${collection} bbox`).toEqual(onTheMap(collection, filter));
        expect(
          ids((await items(collection, { filter: JSON.stringify(filter), "filter-lang": "cql2-json" })).body),
        ).toEqual(served);
      }
    });
  }

  it("bbox with heights (6 numbers): the same features as without", async () => {
    expect(ids((await items("routes", { bbox: "4,50,-100,5,51,100" })).body)).toEqual(
      ids((await items("routes", { bbox: "4,50,5,51" })).body),
    );
  });

  it("datetime compares to the millisecond, as T_INTERSECTS does on the map (a departure stored at .0004 s)", async () => {
    const { rows } = await server.pool.query<{ id: number }>(
      "INSERT INTO routes (name, departure, geom) VALUES ('Sub-ms', '2030-01-01T08:00:00.0004Z', ST_Transform(ST_GeomFromText('LINESTRING(0 0, 1 1)', 4326), 3857)) RETURNING id",
    );
    const id = (rows[0] as { id: number }).id;
    try {
      const all = (await items("routes", {})).body.features;
      const served = all.find((f) => f.id === id);
      expect(served?.properties?.departure).toBe("2030-01-01T08:00:00.000Z");
      for (const datetime of [
        "2030-01-01T08:00:00Z",
        "2030-01-01T08:00:00.000Z",
        "2030-01-01T09:00:00+01:00",
        "2030-01-01",
        "2030-01-01T08:00:00.001Z/..",
      ]) {
        const selected = ids((await items("routes", { datetime })).body);
        const literal = datetime.includes("/")
          ? { interval: [new Date(datetime.split("/")[0] as string).toISOString(), ".."] }
          : datetime.length === 10
            ? { interval: [`${datetime}T00:00:00.000Z`, `${datetime}T23:59:59.999Z`] }
            : { timestamp: new Date(datetime).toISOString() };
        const map = all
          .filter(
            (f) =>
              evaluate(
                { op: "t_intersects", args: [{ property: "departure" }, literal] } as unknown as Cql2Filter,
                f,
              ) === true,
          )
          .map((f) => f.id);
        expect(selected, datetime).toEqual(map);
        expect(selected.includes(id), datetime).toBe(!datetime.endsWith("/.."));
      }
    } finally {
      await server.pool.query("DELETE FROM routes WHERE id = $1", [id]);
    }
  });

  it("every served routes value is what ogc-cql2's postgresValue SELECTs", async () => {
    const q = queryables.routes?.properties as Record<string, SqlColumn>;
    const columns = {
      name: { ...q.name, sqlType: "text" },
      departure: { ...q.departure, sqlType: "timestamp with time zone" },
      length_km: { ...q.length_km, sqlType: "double precision" },
      lanes: { ...q.lanes, sqlType: "integer" },
    };
    const select = Object.entries(columns)
      .map(([n, c]) => `${postgresValue(n, c as SqlColumn)} AS "${n}"`)
      .join(", ");
    const { rows } = await server.pool.query(`SELECT id, ${select} FROM routes ORDER BY id`);
    for (const row of rows) {
      const served = (all.routes as Feature[]).find((f) => f.id === row.id)?.properties ?? {};
      for (const name of Object.keys(columns)) expect(served[name] ?? null, `${row.id} ${name}`).toEqual(row[name]);
    }
  });
});
