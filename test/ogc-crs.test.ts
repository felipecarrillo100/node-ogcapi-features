import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate } from "ogc-cql2/evaluate";
import { afterEach, describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
const EPSG4326 = "http://www.opengis.net/def/crs/EPSG/0/4326";
const EPSG3857 = "http://www.opengis.net/def/crs/EPSG/0/3857";

type Items = FeatureCollection & { numberMatched: number };
const items = (collection: string, query: Record<string, string> = {}) =>
  request<Items>(`${server.url}/collections/${collection}/items?${new URLSearchParams({ limit: "10000", ...query })}`);
const ids = (c: FeatureCollection) => c.features.map((f) => f.id);
const coordinates = (g: Geometry | null | undefined) => (g as { coordinates: unknown } | null | undefined)?.coordinates;

/** PostGIS's own answer: the geometry expression `expr` (from `from`, when given) as GeoJSON coordinates. */
async function postgis(expr: string, from = "", params: unknown[] = []): Promise<unknown> {
  const { rows } = await server.pool.query<{ g: string }>(
    `SELECT ST_AsGeoJSON(${expr}, 15, 0) AS g ${from ? `FROM ${from}` : ""}`,
    params,
  );
  return JSON.parse((rows[0] as { g: string }).g).coordinates;
}

/** What a test wrote, deleted after it. */
const created: string[] = [];
afterEach(async () => {
  for (const path of created.splice(0)) await fetch(`${server.url}${path}`, { method: "DELETE" });
});

describe("the CRSs a collection offers (Part 2)", () => {
  it("/collections: a global crs list, each collection pointing to it, and its storageCrs", async () => {
    const { body } = await request<{ crs: string[]; collections: { id: string; crs: string[]; storageCrs: string }[] }>(
      `${server.url}/collections`,
    );
    expect(body.crs).toEqual([CRS84, EPSG4326, EPSG3857]);
    expect(body.collections.map((c) => [c.id, c.crs, c.storageCrs])).toEqual([
      ["features", ["#/crs"], CRS84],
      ["routes", ["#/crs"], EPSG3857],
    ]);
  });
});

describe("crs: the answer's geometries in another CRS", () => {
  it("CRS84 by default; Content-Crs on every GeoJSON answer", async () => {
    for (const path of [
      "/collections/routes/items",
      "/collections/routes/items/1",
      "/collections/features/items?bbox=4,50,5,51",
    ]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.headers.get("content-crs"), path).toBe(`<${CRS84}>`);
    }
  });

  it("EPSG:4326: the same coordinates, latitude first (the CRS's own axis order)", async () => {
    const crs84 = (await request<Feature>(`${server.url}/collections/features/items/7`)).body;
    const res = await fetch(`${server.url}/collections/features/items/7?crs=${encodeURIComponent(EPSG4326)}`);
    expect(res.headers.get("content-crs")).toBe(`<${EPSG4326}>`);
    const latLon = (await res.json()) as Feature;
    expect(coordinates(latLon.geometry)).toEqual([50.8, 4.4]);
    expect(coordinates(crs84.geometry)).toEqual([4.4, 50.8]);
    // A whole page, every feature swapped.
    const page = await items("routes", { crs: EPSG4326 });
    const routes = await items("routes");
    page.body.features.forEach((f, i) => {
      const lonLat = coordinates(routes.body.features[i]?.geometry) as number[][];
      expect(coordinates(f.geometry)).toEqual(lonLat.map(([x, y]) => [y, x]));
    });
  });

  it("EPSG:3857 of routes (stored in 3857): exactly the stored values", async () => {
    const res = await fetch(`${server.url}/collections/routes/items/1?crs=${encodeURIComponent(EPSG3857)}`);
    expect(res.headers.get("content-crs")).toBe(`<${EPSG3857}>`);
    const f = (await res.json()) as Feature;
    expect(coordinates(f.geometry)).toEqual(await postgis("geom", "routes WHERE id = 1"));
  });

  it("EPSG:3857 of features (stored in 4326): PostGIS's transform; no crs member in the GeoJSON", async () => {
    const f = (await request<Feature>(`${server.url}/collections/features/items/7?crs=${encodeURIComponent(EPSG3857)}`))
      .body;
    expect(coordinates(f.geometry)).toEqual(await postgis("ST_Transform(geom, 3857)", "features WHERE id = 7"));
    expect(f.geometry).not.toHaveProperty("crs");
  });

  it("the paging links keep crs; the HTML page's map fetches CRS84", async () => {
    const page = await items("routes", { crs: EPSG3857, limit: "3" });
    const next = (page.body as unknown as { links: { rel: string; href: string }[] }).links.find(
      (l) => l.rel === "next",
    );
    expect(new URL(next?.href as string).searchParams.get("crs")).toBe(EPSG3857);
    const html = await request<string>(
      `${server.url}/collections/routes/items?f=html&crs=${encodeURIComponent(EPSG3857)}`,
    );
    const fetched = /fetch\("([^"]+)"/.exec(html.body)?.[1] as string;
    expect(new URL(fetched).searchParams.get("crs")).toBeNull();
  });

  it("400 for a CRS the server doesn't offer", async () => {
    for (const crs of ["EPSG:4326", "http://www.opengis.net/def/crs/EPSG/0/32631", "x"]) {
      expect((await items("routes", { crs })).status, crs).toBe(400);
      expect((await request(`${server.url}/collections/routes/items/1?crs=${encodeURIComponent(crs)}`)).status).toBe(
        400,
      );
    }
  });
});

describe("bbox-crs: a box in another CRS", () => {
  it("the same box in CRS84, EPSG:4326 (latitude first) and EPSG:3857 selects the same features", async () => {
    const [w, s, e, n] = [4, 50, 5, 51];
    const corners = (
      await server.pool.query<{ x1: number; y1: number; x2: number; y2: number }>(
        `SELECT ST_X(a) x1, ST_Y(a) y1, ST_X(b) x2, ST_Y(b) y2 FROM (SELECT
        ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857) a, ST_Transform(ST_SetSRID(ST_MakePoint($3, $4), 4326), 3857) b) t`,
        [w, s, e, n],
      )
    ).rows[0] as { x1: number; y1: number; x2: number; y2: number };
    for (const collection of ["features", "routes"]) {
      const expected = ids((await items(collection, { bbox: `${w},${s},${e},${n}` })).body);
      expect(expected.length).toBeGreaterThan(0);
      expect(
        ids((await items(collection, { bbox: `${s},${w},${n},${e}`, "bbox-crs": EPSG4326 })).body),
        "4326",
      ).toEqual(expected);
      const merc = `${corners.x1},${corners.y1},${corners.x2},${corners.y2}`;
      expect(ids((await items(collection, { bbox: merc, "bbox-crs": EPSG3857 })).body), "3857").toEqual(expected);
      expect(ids((await items(collection, { bbox: `${w},${s},${e},${n}`, "bbox-crs": CRS84 })).body)).toEqual(expected);
    }
  });

  it("400 for an unknown bbox-crs", async () => {
    expect((await items("routes", { bbox: "1,2,3,4", "bbox-crs": "x" })).status).toBe(400);
  });
});

describe("filter-crs: a filter's geometries in another CRS", () => {
  const europe84 = [
    [-10, 35],
    [35, 35],
    [35, 60],
    [-10, 60],
    [-10, 35],
  ];

  it("the same polygon and box in each CRS selects the same features (CQL2-JSON)", async () => {
    const europe3857 = await postgis("ST_Transform(ST_GeomFromGeoJSON($1)::geometry, 3857)", "", [
      JSON.stringify({
        type: "Polygon",
        coordinates: [europe84],
        crs: { type: "name", properties: { name: "EPSG:4326" } },
      }),
    ]);
    const polygon = (coords: unknown) => ({
      op: "s_intersects",
      args: [{ property: "geometry" }, { type: "Polygon", coordinates: coords }],
    });
    for (const collection of ["features", "routes"]) {
      const expected = ids(
        (await items(collection, { filter: JSON.stringify(polygon([europe84])), "filter-lang": "cql2-json" })).body,
      );
      expect(expected.length).toBeGreaterThan(0);
      const latLon = [europe84.map(([x, y]) => [y, x])];
      for (const [crs, coords] of [
        [EPSG4326, latLon],
        [EPSG3857, europe3857],
      ] as const) {
        const res = await items(collection, {
          filter: JSON.stringify(polygon(coords)),
          "filter-lang": "cql2-json",
          "filter-crs": crs,
        });
        expect(ids(res.body), `${collection} ${crs}`).toEqual(expected);
      }
      // A BBOX literal: 4326 is latitude first.
      const box = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [35, -10, 60, 35] }] };
      expect(
        ids(
          (await items(collection, { filter: JSON.stringify(box), "filter-lang": "cql2-json", "filter-crs": EPSG4326 }))
            .body,
        ),
      ).toEqual(expected);
    }
  });

  // The request to ogc-cql2 (request/ogc-cql2-filter-crs.md, 3.2): the same box around Belgium and around Tokyo, in
  // each CRS and language. Rows 3 and 8 (CQL2-text in EPSG:3857, and in EPSG:4326 east of 90° E) were refused with
  // ogc-cql2 1.6.2; 1.7.0 reads them (crs84: false) and toSql transforms them (literals).
  it("the request file's 8 requests: CQL2-text and CQL2-JSON, in each CRS, select the same routes", async () => {
    const m = [445277.96317309426, 6446275.841017158, 556597.4539663679, 6621293.722740165];
    const json = (bbox: number[]) => JSON.stringify({ op: "s_intersects", args: [{ property: "geometry" }, { bbox }] });
    const rows: [Record<string, string>, number[]][] = [
      [{ filter: "S_INTERSECTS(geometry, BBOX(4, 50, 5, 51))" }, [1, 2, 3, 9, 10]],
      [{ filter: json(m), "filter-lang": "cql2-json", "filter-crs": EPSG3857 }, [1, 2, 3, 9, 10]],
      [{ filter: `S_INTERSECTS(geometry, BBOX(${m.join(", ")}))`, "filter-crs": EPSG3857 }, [1, 2, 3, 9, 10]],
      [{ filter: json([50, 4, 51, 5]), "filter-lang": "cql2-json", "filter-crs": EPSG4326 }, [1, 2, 3, 9, 10]],
      [{ filter: "S_INTERSECTS(geometry, BBOX(50, 4, 51, 5))", "filter-crs": EPSG4326 }, [1, 2, 3, 9, 10]],
      [{ filter: "S_INTERSECTS(geometry, BBOX(139, 35, 140, 36))" }, [4, 5]],
      [{ filter: json([35, 139, 36, 140]), "filter-lang": "cql2-json", "filter-crs": EPSG4326 }, [4, 5]],
      [{ filter: "S_INTERSECTS(geometry, BBOX(35, 139, 36, 140))", "filter-crs": EPSG4326 }, [4, 5]],
    ];
    for (const [i, [query, expected]] of rows.entries()) {
      const res = await items("routes", query);
      expect(res.status, `row ${i + 1}`).toBe(200);
      expect(ids(res.body), `row ${i + 1}`).toEqual(expected);
    }
  });

  /** A GeoJSON Point, LineString or Polygon, or a box, as CQL2-text. */
  const wkt = (g: { type: string; coordinates?: unknown; bbox?: number[] }): string => {
    const pos = (p: number[]) => p.join(" ");
    const line = (l: number[][]) => `(${l.map(pos).join(", ")})`;
    if (g.bbox) return `BBOX(${g.bbox.join(", ")})`;
    if (g.type === "Point") return `POINT(${pos(g.coordinates as number[])})`;
    if (g.type === "LineString") return `LINESTRING${line(g.coordinates as number[][])}`;
    return `POLYGON(${(g.coordinates as number[][][]).map(line).join(", ")})`;
  };
  /** A literal (CRS84) in EPSG:4326 (axes swapped) and in EPSG:3857 (PostGIS's ST_Transform, full precision). */
  async function inEachCrs(literal: { type?: string; coordinates?: unknown; bbox?: number[] }) {
    if (literal.bbox) {
      const [w, s, e, n] = literal.bbox as [number, number, number, number];
      const [a, b] = (await postgis(
        "ST_Transform(ST_SetSRID(ST_MakeLine(ST_MakePoint($1, $2), ST_MakePoint($3, $4)), 4326), 3857)",
        "",
        [w, s, e, n],
      )) as number[][];
      return {
        [CRS84]: literal,
        [EPSG4326]: { bbox: [s, w, n, e] },
        [EPSG3857]: { bbox: [...(a as number[]), ...(b as number[])] },
      };
    }
    const swap = (c: unknown): unknown =>
      typeof (c as unknown[])[0] === "number" ? [(c as number[])[1], (c as number[])[0]] : (c as unknown[]).map(swap);
    const merc = await postgis("ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3857)", "", [
      JSON.stringify(literal),
    ]);
    return {
      [CRS84]: literal,
      [EPSG4326]: { type: literal.type, coordinates: swap(literal.coordinates) },
      [EPSG3857]: { type: literal.type, coordinates: merc },
    };
  }

  const LITERALS = [
    { bbox: [-10, 35, 35, 60] },
    { type: "Polygon", coordinates: [europe84] },
    // Across the Channel and the Alps: it crosses Brussels–Paris and Brussels–Cairo, no vertex on a feature.
    {
      type: "LineString",
      coordinates: [
        [0.5, 50.5],
        [10.5, 45.25],
      ],
    },
    // East of 90° E, where EPSG:4326 latitude-first can't pass as CRS84: Tokyo's surroundings.
    {
      type: "Polygon",
      coordinates: [
        [
          [135, 30],
          [145, 30],
          [145, 40],
          [135, 40],
          [135, 30],
        ],
      ],
    },
  ];

  it("CQL2-text and CQL2-JSON, in CRS84, EPSG:4326 and EPSG:3857, select the same features (S_INTERSECTS, S_WITHIN, S_DISJOINT)", async () => {
    for (const literal of LITERALS) {
      const each = await inEachCrs(literal);
      for (const op of ["S_INTERSECTS", "S_WITHIN", "S_DISJOINT"]) {
        for (const collection of ["features", "routes"]) {
          const expected = ids(
            (await items(collection, { filter: `${op}(geometry, ${wkt(literal as { type: string })})` })).body,
          );
          for (const [crs, l] of Object.entries(each)) {
            const label = `${collection} ${op} ${JSON.stringify(literal).slice(0, 40)} ${crs}`;
            const text = await items(collection, {
              filter: `${op}(geometry, ${wkt(l as { type: string })})`,
              "filter-crs": crs,
            });
            expect(text.status, `${label} text: ${JSON.stringify(text.body).slice(0, 200)}`).toBe(200);
            expect(ids(text.body), `${label} text`).toEqual(expected);
            const jsonFilter = JSON.stringify({ op: op.toLowerCase(), args: [{ property: "geometry" }, l] });
            const json = await items(collection, { filter: jsonFilter, "filter-lang": "cql2-json", "filter-crs": crs });
            expect(ids(json.body), `${label} json`).toEqual(expected);
          }
        }
      }
    }
  });

  it("S_INTERSECTS in each CRS equals evaluate on the served features (the map), the literal in CRS84", async () => {
    for (const literal of LITERALS) {
      const each = await inEachCrs(literal);
      for (const collection of ["features", "routes"]) {
        const all = (await items(collection)).body.features;
        const filter = { op: "s_intersects", args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
        const map = all.filter((f) => evaluate(filter, f) === true).map((f) => f.id);
        for (const [crs, l] of Object.entries(each)) {
          const res = await items(collection, {
            filter: `S_INTERSECTS(geometry, ${wkt(l as { type: string })})`,
            "filter-crs": crs,
          });
          expect(ids(res.body), `${collection} ${crs} ${JSON.stringify(literal).slice(0, 40)}`).toEqual(map);
        }
      }
    }
  });

  it("400 for a coordinate outside the CRS's area of use; its edge is in", async () => {
    const refused: [Record<string, string>, RegExp][] = [
      [{ filter: "S_INTERSECTS(geometry, POINT(20100000 0))", "filter-crs": EPSG3857 }, /x 20100000 is outside/],
      [{ filter: "S_INTERSECTS(geometry, POINT(0 -20100000))", "filter-crs": EPSG3857 }, /y -20100000 is outside/],
      [{ filter: "S_INTERSECTS(geometry, POINT(95 4))", "filter-crs": EPSG4326 }, /latitude 95 is outside/],
      [{ filter: "S_INTERSECTS(geometry, POINT(50 181))", "filter-crs": EPSG4326 }, /longitude 181 is outside/],
      [
        { bbox: "-20100000,0,0,1000", "bbox-crs": EPSG3857 },
        /^Invalid bbox "-20100000,0,0,1000": x -20100000 is outside/,
      ],
      [
        {
          filter: JSON.stringify({
            op: "s_intersects",
            args: [{ property: "geometry" }, { bbox: [0, 0, 21000000, 1] }],
          }),
          "filter-lang": "cql2-json",
          "filter-crs": EPSG3857,
        },
        /x 21000000 is outside/,
      ],
    ];
    for (const [query, message] of refused) {
      const res = await items("routes", query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect((res.body as unknown as { description: string }).description).toMatch(message);
    }
    const edge = await items("routes", {
      filter: "S_INTERSECTS(geometry, BBOX(-20037508.34, -20048966.1, 20037508.34, 20048966.1))",
      "filter-crs": EPSG3857,
    });
    expect(edge.status).toBe(200);
    expect(ids(edge.body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      (await items("routes", { filter: "S_INTERSECTS(geometry, POINT(-90 180))", "filter-crs": EPSG4326 })).status,
    ).toBe(200);
  });

  // Report 2 (request/2-bbox-crs-4326-antimeridian.md): parseBbox read every box longitude first, so an EPSG:4326 box
  // across the antimeridian was refused as "south above north". ogc-cql2 now checks the box, in its own CRS.
  it("a box across the antimeridian selects the same features in CRS84 and EPSG:4326, as bbox and as filter", async () => {
    const boxes: [string, number[]][] = [
      // Route 6 (Sydney–Auckland) past 170° E; Tokyo to New York over the Pacific, for features.
      ["routes", [170, -40, -170, -30]],
      ["features", [130, -50, -60, 50]],
    ];
    for (const [collection, [w, s, e, n]] of boxes) {
      const all = (await items(collection)).body.features;
      const filter = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [w, s, e, n] }] };
      const map = all.filter((f) => evaluate(filter as unknown as Cql2Filter, f) === true).map((f) => f.id);
      expect(map.length, collection).toBeGreaterThan(0);
      const ways: [string, Record<string, string>][] = [
        ["bbox CRS84", { bbox: `${w},${s},${e},${n}` }],
        ["bbox 4326", { bbox: `${s},${w},${n},${e}`, "bbox-crs": EPSG4326 }],
        ["bbox 4326, 6 numbers", { bbox: `${s},${w},0,${n},${e},100`, "bbox-crs": EPSG4326 }],
        ["filter CRS84", { filter: `S_INTERSECTS(geometry, BBOX(${w}, ${s}, ${e}, ${n}))` }],
        [
          "filter-crs 4326 text",
          { filter: `S_INTERSECTS(geometry, BBOX(${s}, ${w}, ${n}, ${e}))`, "filter-crs": EPSG4326 },
        ],
        [
          "filter-crs 4326 json",
          {
            filter: JSON.stringify({ op: "s_intersects", args: [{ property: "geometry" }, { bbox: [s, w, n, e] }] }),
            "filter-lang": "cql2-json",
            "filter-crs": EPSG4326,
          },
        ],
      ];
      for (const [way, query] of ways) {
        const res = await items(collection, query);
        expect(res.status, `${collection} ${way}`).toBe(200);
        expect(ids(res.body), `${collection} ${way}`).toEqual(map);
      }
    }
  });

  it("a box whose south is above its north is refused in CRS84 and EPSG:4326, the message naming the bbox", async () => {
    const queries: Record<string, string>[] = [
      { bbox: "170,-36,175,-37" },
      { bbox: "-36,170,-37,175", "bbox-crs": EPSG4326 },
    ];
    for (const query of queries) {
      const res = await items("routes", query);
      expect(res.status, query.bbox).toBe(400);
      expect((res.body as unknown as { description: string }).description).toMatch(
        new RegExp(`^Invalid bbox "${query.bbox}": A bbox's south \\(-3[67]\\) is above its north`),
      );
    }
  });

  it("a backwards box in EPSG:3857 is refused: only a geographic CRS crosses the antimeridian", async () => {
    const res = await items("routes", { bbox: "1000,0,-1000,1000", "bbox-crs": EPSG3857 });
    expect(res.status).toBe(400);
    const text = await items("routes", {
      filter: "S_INTERSECTS(geometry, BBOX(1000, 0, -1000, 1000))",
      "filter-crs": EPSG3857,
    });
    expect(text.status).toBe(400);
  });

  it("400 for an unknown filter-crs", async () => {
    expect((await items("routes", { filter: "lanes = 1", "filter-crs": "x" })).status).toBe(400);
  });
});

describe("Content-Crs on writes (Part 4 Req 40–42)", () => {
  async function post(
    collection: string,
    geometry: unknown,
    crs?: string,
    properties: Record<string, unknown> = { name: "CRS write" },
  ) {
    const res = await fetch(`${server.url}/collections/${collection}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/geo+json", ...(crs ? { "Content-Crs": `<${crs}>` } : {}) },
      body: JSON.stringify({ type: "Feature", properties, geometry }),
    });
    if (res.status === 201) created.push(new URL(res.headers.get("location") as string).pathname);
    return res;
  }

  it("a route sent in EPSG:3857 (its storage CRS) is stored exactly as sent", async () => {
    const sent = [
      [489805.75949040375, 6585991.99809962],
      [261600.8033641929, 6251139.623506175],
    ];
    const res = await post("routes", { type: "LineString", coordinates: sent }, EPSG3857);
    expect(res.status).toBe(201);
    const id = Number(created.at(-1)?.split("/").pop());
    expect(await postgis("geom", "routes WHERE id = $1", [id])).toEqual(sent);
    // And served in CRS84 as the same line as route 1 (Brussels–Paris).
    const back = (await request<Feature>(`${server.url}${created.at(-1)}`)).body;
    expect(coordinates(back.geometry)).toEqual([
      [4.4, 50.8],
      [2.35, 48.86],
    ]);
  });

  it("a feature sent in EPSG:4326 (latitude first) is the CRS84 feature", async () => {
    const res = await post("features", { type: "Point", coordinates: [50.8, 4.4] }, EPSG4326);
    expect(res.status).toBe(201);
    expect(coordinates((await request<Feature>(`${server.url}${created.at(-1)}`)).body.geometry)).toEqual([4.4, 50.8]);
  });

  it("PUT and PATCH read their geometry in Content-Crs too", async () => {
    await post("routes", {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    const path = created.at(-1) as string;
    const put = await fetch(`${server.url}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/geo+json", "Content-Crs": `<${EPSG4326}>` },
      body: JSON.stringify({
        type: "Feature",
        properties: { name: "Put" },
        geometry: {
          type: "LineString",
          coordinates: [
            [50.8, 4.4],
            [48.86, 2.35],
          ],
        },
      }),
    });
    expect(put.status).toBe(204);
    expect(coordinates((await request<Feature>(`${server.url}${path}`)).body.geometry)).toEqual([
      [4.4, 50.8],
      [2.35, 48.86],
    ]);
    const patch = await fetch(`${server.url}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json", "Content-Crs": `<${EPSG3857}>` },
      body: JSON.stringify({
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [111319.49079327357, 0],
          ],
        },
      }),
    });
    expect(patch.status).toBe(204);
    expect(coordinates((await request<Feature>(`${server.url}${path}`)).body.geometry)).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("400 for a Content-Crs the server doesn't offer", async () => {
    const res = await post(
      "routes",
      {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      "http://www.opengis.net/def/crs/EPSG/0/32631",
    );
    expect(res.status).toBe(400);
  });
});
