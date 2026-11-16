import type { Feature, FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

interface Link {
  href: string;
  rel: string;
  type?: string;
}
type Items = FeatureCollection & { numberMatched: number; numberReturned: number; timeStamp: string; links: Link[] };
type Item = Feature & { links: Link[] };

const items = (collection: string, query = "") =>
  request<Items>(`${server.url}/collections/${collection}/items${query ? `?${query}` : ""}`);
const ids = (c: FeatureCollection) => c.features.map((f) => f.id);
const rels = (links: Link[]) => links.map((l) => `${l.rel} ${l.type}`);
const link = (links: Link[], rel: string) => links.find((l) => l.rel === rel);
const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";

describe("landing page", () => {
  it("links the API definition, its documentation, the conformance classes and the collections", async () => {
    const { status, contentType, body } = await request<{ title: string; links: Link[] }>(`${server.url}/`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(rels(body.links)).toEqual([
      "self application/json",
      "alternate text/html",
      "service-desc application/vnd.oai.openapi+json;version=3.0",
      "service-doc text/html",
      "conformance application/json",
      "conformance text/html",
      "data application/json",
      "data text/html",
    ]);
    expect(link(body.links, "service-desc")?.href).toBe(`${server.url}/api`);
    expect(link(body.links, "service-doc")?.href).toBe(`${server.url}/api.html`);
  });

  it("as HTML, every link of the JSON is an <a> in the page", async () => {
    const json = await request<{ links: Link[] }>(`${server.url}/?f=json`);
    const html = await request<string>(`${server.url}/?f=html`);
    expect(html.contentType).toBe("text/html; charset=utf-8");
    for (const l of json.body.links) expect(html.body).toContain(`<a href="${l.href.replaceAll("&", "&amp;")}"`);
  });

  it("negotiates by Accept: a browser gets HTML, anything else JSON", async () => {
    const browser = await request(`${server.url}/`, {
      headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    expect(browser.contentType).toBe("text/html; charset=utf-8");
    const any = await request(`${server.url}/`, { headers: { Accept: "*/*" } });
    expect(any.contentType).toBe("application/json; charset=utf-8");
  });

  it("refuses an unknown parameter and an unknown f, as OGC exceptions", async () => {
    expect(await request(`${server.url}/?x=1`)).toMatchObject({ status: 400, body: { code: "InvalidParameterValue" } });
    expect(await request(`${server.url}/?f=xml`)).toMatchObject({
      status: 400,
      body: { code: "InvalidParameterValue" },
    });
  });
});

describe("/api and Swagger UI", () => {
  it("/api: the OpenAPI 3.0 document, with the media type Part 1 names, one path per collection", async () => {
    const { status, contentType, body } = await request<{
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, unknown>;
    }>(`${server.url}/api`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/vnd.oai.openapi+json;version=3.0");
    expect(body.openapi).toBe("3.0.3");
    expect(body.servers).toEqual([{ url: server.url }]);
    expect(Object.keys(body.paths)).toEqual([
      "/",
      "/conformance",
      "/api",
      "/collections",
      "/collections/features",
      "/collections/features/items",
      "/collections/features/items/{featureId}",
      "/collections/features/queryables",
      "/collections/features/schema",
      "/collections/routes",
      "/collections/routes/items",
      "/collections/routes/items/{featureId}",
      "/collections/routes/queryables",
      "/collections/routes/schema",
    ]);
  });

  it("/api.html and /api?f=html: Swagger UI, its files served from this server", async () => {
    const page = await request<string>(`${server.url}/api.html`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<base href="/assets/swagger-ui/">');
    expect(page.body).toContain('<div id="swagger-ui"></div>');
    expect((await request<string>(`${server.url}/api?f=html`)).body).toBe(page.body);
    const init = await request<string>(`${server.url}/assets/swagger-ui/swagger-ui-init.js`);
    expect(init.body).toContain('"swaggerUrl": "/api"');
    expect((await request(`${server.url}/assets/swagger-ui/swagger-ui-bundle.js`)).status).toBe(200);
  });
});

describe("collections", () => {
  it("/collections: both, with extent, itemType, crs and their links", async () => {
    const { status, body } = await request<{ links: Link[]; collections: Record<string, unknown>[] }>(
      `${server.url}/collections`,
    );
    expect(status).toBe(200);
    expect(rels(body.links)).toEqual(["self application/json", "alternate text/html"]);
    expect(body.collections.map((c) => c.id)).toEqual(["features", "routes"]);
    const [features, routes] = body.collections as [Record<string, unknown>, Record<string, unknown>];
    expect(features.extent).toEqual({ spatial: { bbox: [[-74, -33.9, 151.2, 51.2]], crs: CRS84 } });
    expect(routes.extent).toEqual({
      spatial: { bbox: [[-74, -36.8, 174.8, 52.37]], crs: CRS84 },
      temporal: {
        interval: [["2024-05-01T08:00:00.000Z", "2025-01-01T00:00:00.000Z"]],
        trs: "http://www.opengis.net/def/uom/ISO-8601/0/Gregorian",
      },
    });
    expect(routes).toMatchObject({ itemType: "feature", crs: [CRS84] });
    expect(rels(routes.links as Link[])).toEqual([
      "self application/json",
      "alternate text/html",
      "items application/geo+json",
      "items text/html",
      "http://www.opengis.net/def/rel/ogc/1.0/queryables application/schema+json",
      "http://www.opengis.net/def/rel/ogc/1.0/queryables text/html",
      "http://www.opengis.net/def/rel/ogc/1.0/schema application/schema+json",
      "http://www.opengis.net/def/rel/ogc/1.0/schema text/html",
    ]);
  });

  it("/collections/{id}: the same description as in the list; 404 for another id", async () => {
    const list = await request<{ collections: Record<string, unknown>[] }>(`${server.url}/collections`);
    const one = await request<Record<string, unknown>>(`${server.url}/collections/routes`);
    const { links: _a, ...fromList } = list.body.collections[1] as Record<string, unknown>;
    const { links: _b, ...alone } = one.body;
    expect(alone).toEqual(fromList);
    expect(await request(`${server.url}/collections/nope`)).toMatchObject({ status: 404, body: { code: "NotFound" } });
  });
});

describe("items", () => {
  it("a GeoJSON FeatureCollection with numberMatched, numberReturned, timeStamp and its links", async () => {
    const before = Date.now();
    const { status, contentType, body } = await items("routes", "limit=3");
    expect(status).toBe(200);
    expect(contentType).toBe("application/geo+json; charset=utf-8");
    expect(body).toMatchObject({ type: "FeatureCollection", numberMatched: 10, numberReturned: 3 });
    expect(Date.parse(body.timeStamp)).toBeGreaterThanOrEqual(before - 1000);
    expect(ids(body)).toEqual([1, 2, 3]);
    expect(body.features[0]).toEqual({
      type: "Feature",
      id: 1,
      geometry: {
        type: "LineString",
        coordinates: [
          [4.4, 50.8],
          [2.35, 48.86],
        ],
      },
      properties: { name: "Brussels–Paris", departure: "2024-05-01T08:00:00.000Z", length_km: 264, lanes: 3 },
    });
    expect(rels(body.links)).toEqual([
      "self application/geo+json",
      "alternate text/html",
      "next application/geo+json",
      "collection application/json",
    ]);
  });

  it("paging: following next gives every feature once, in id order; prev goes back", async () => {
    for (const [collection, all] of [
      ["features", [7, 8, 9, 10, 11, 12, 13, 14]],
      ["routes", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ] as const) {
      const seen: unknown[] = [];
      let next: string | undefined = `${server.url}/collections/${collection}/items?limit=3`;
      while (next) {
        const page: { body: Items } = await request<Items>(next);
        seen.push(...ids(page.body));
        next = link(page.body.links, "next")?.href;
      }
      expect(seen).toEqual(all);
    }
    const second = await items("routes", "limit=3&offset=3");
    expect(link(second.body.links, "prev")?.href).toBe(`${server.url}/collections/routes/items?limit=3&f=json`);
    expect(ids((await request<Items>(link(second.body.links, "prev")?.href as string)).body)).toEqual([1, 2, 3]);
  });

  it("limit: default 10; above 10000 is 10000, not an error; 0 or not a number is 400", async () => {
    expect((await items("routes")).body.numberReturned).toBe(10);
    const over = await items("routes", "limit=20000");
    expect(over.status).toBe(200);
    expect(link(over.body.links, "self")?.href).toBe(`${server.url}/collections/routes/items?limit=10000&f=json`);
    for (const bad of ["limit=0", "limit=x", "limit=1.5", "offset=-1"])
      expect((await items("routes", bad)).status).toBe(400);
  });

  it("refuses an unknown parameter and a repeated one (Part 1)", async () => {
    expect(await items("routes", "foo=1")).toMatchObject({ status: 400, body: { code: "InvalidParameterValue" } });
    expect((await items("routes", "limit=1&limit=2")).status).toBe(400);
  });

  it("bbox: the features that intersect it; 6 numbers; across the antimeridian; on a 3857 collection", async () => {
    expect(ids((await items("features", "bbox=4,50,5,51")).body)).toEqual([7, 13, 14]);
    expect(ids((await items("features", "bbox=4,50,0,5,51,100")).body)).toEqual([7, 13, 14]);
    // West above east: Tokyo, New York, Sydney.
    expect(ids((await items("features", "bbox=130,-50,-60,50")).body)).toEqual([8, 9, 10]);
    expect(ids((await items("routes", "bbox=4,50,5,51")).body)).toEqual([1, 2, 3, 9, 10]);
    expect(ids((await items("routes", "bbox=170,-40,-170,-30")).body)).toEqual([6]);
    for (const bad of ["bbox=1,2,3", "bbox=1,5,3,2", "bbox=a,b,c,d", "bbox=1,2,3,4,5"]) {
      expect((await items("routes", bad)).status).toBe(400);
    }
  });

  it("datetime: instants, intervals, open ends, on the departure; a NULL departure never matches", async () => {
    const cases: [string, number[]][] = [
      ["2024-05-01", [1, 2]],
      ["2024-05-01T08:00:00Z", [1, 2]],
      ["2024-05-01T10:00:00+02:00", [1, 2]],
      ["2024-06-01/2024-07-15", [5, 6, 7, 8]],
      ["../2024-05-02T06:30:00Z", [1, 2, 3]],
      ["2024-12-31T23:59:59Z/..", [9, 10]],
      ["/2024-05-01", [1, 2]],
      ["../..", [1, 2, 3, 5, 6, 7, 8, 9, 10]],
    ];
    for (const [datetime, expected] of cases) {
      expect(ids((await items("routes", `datetime=${encodeURIComponent(datetime)}`)).body), datetime).toEqual(expected);
    }
    for (const bad of [
      "2024-13-01",
      "2024-06-01/2024-05-01",
      "yesterday",
      "2024-05-01T08:00:00",
      "2024-02-30",
      "2024-02-30T08:00:00Z",
      "2024-05-01T25:00:00Z",
    ]) {
      expect((await items("routes", `datetime=${bad}`)).status, bad).toBe(400);
    }
  });

  it("datetime on a collection without a temporal property: accepted, selects every feature", async () => {
    expect((await items("features", "datetime=2024-01-01")).body.numberMatched).toBe(8);
  });

  it("as HTML: the page's features in a table, a map fetching the same query as GeoJSON, the links as <a>", async () => {
    const { status, contentType, body } = await request<string>(
      `${server.url}/collections/routes/items?f=html&limit=2&bbox=4,50,5,51`,
    );
    expect(status).toBe(200);
    expect(contentType).toBe("text/html; charset=utf-8");
    expect(body).toContain('import * as maplibregl from "/assets/maplibre-gl/maplibre-gl.mjs"');
    expect(body).toContain(
      `fetch(${JSON.stringify(`${server.url}/collections/routes/items?f=json&limit=2&bbox=4%2C50%2C5%2C51`)}`,
    );
    expect(body).toContain(
      `<a href="${server.url}/collections/routes/items?f=html&amp;limit=2&amp;bbox=4%2C50%2C5%2C51&amp;offset=2" rel="next"`,
    );
    expect(body).toContain('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>');
    expect((await request(`${server.url}/assets/maplibre-gl/maplibre-gl.mjs`)).status).toBe(200);
  });

  it("as HTML: a Limit form, keeping the page's other parameters and dropping offset", async () => {
    const query = "f=html&limit=25&offset=3&bbox=4,50,5,51&filter=lanes%20%3E%3D%202";
    const { body } = await request<string>(`${server.url}/collections/routes/items?${query}`);
    const form = body.slice(body.indexOf("<form"), body.indexOf("</form>") + 7);
    expect(form).toContain('<form method="get" action="/collections/routes/items">');
    expect(form).toContain(
      '<select name="limit"><option>10</option><option selected>25</option><option>100</option><option>1000</option><option>10000</option></select>',
    );
    expect(form).toContain('<input type="hidden" name="f" value="html">');
    expect(form).toContain('<input type="hidden" name="bbox" value="4,50,5,51">');
    expect(form).toContain('<input type="hidden" name="filter" value="lanes &gt;= 2">');
    expect(form).not.toContain('name="offset"');
    // What the browser sends on Apply with 100: the same features, from the first page.
    const applied = await request<string>(
      `${server.url}/collections/routes/items?f=html&bbox=4,50,5,51&filter=lanes%20%3E%3D%202&limit=100`,
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toContain("<option selected>100</option>");
    expect(applied.body).toContain("4 of 4 features.");
  });

  it("as HTML: a table with one column per property, values as text, in a box that scrolls", async () => {
    const tableOf = async (path: string) => {
      const { body } = await request<string>(`${server.url}${path}`);
      return body.slice(body.indexOf('<div class="scroll">'), body.indexOf("</table></div>") + 14);
    };
    const features = await tableOf("/collections/features/items?f=html");
    expect(features).toContain(
      "<thead><tr><th>id</th><th>name</th><th>services</th><th>zones</th><th>inspections</th><th>tags</th><th>floors</th><th>visits</th></tr></thead>",
    );
    const row = (id: number) =>
      features.slice(
        features.indexOf(`/items/${id}?f=html">${id}</a>`),
        features.indexOf("</tr>", features.indexOf(`/items/${id}?f=html">`)),
      );
    // Brussels: lists as their values; Sydney: an empty list; New York: no services at all.
    expect(row(7)).toContain("<td>Brussels</td><td>lift, toilets, parking</td><td>1, 2</td>");
    expect(row(10)).toContain("<td>Sydney</td><td>[]</td>");
    expect(row(9)).toContain("<td>New York</td><td></td><td></td><td></td><td>museum</td>");
    expect(features).not.toContain("{&quot;");
    const routes = await tableOf("/collections/routes/items?f=html");
    expect(routes).toContain(
      "<thead><tr><th>id</th><th>name</th><th>departure</th><th>length_km</th><th>lanes</th></tr></thead>",
    );
    expect(routes).toContain("<td>Brussels–Paris</td><td>2024-05-01T08:00:00.000Z</td><td>264</td><td>3</td>");
    const { body } = await request<string>(`${server.url}/collections/routes/items?f=html`);
    expect(body).toContain(".scroll { overflow: auto; max-height: 60vh; }");
    expect(body).toContain("table.grid thead th { position: sticky; top: 0;");
  });

  it("HEAD answers as GET, without a body", async () => {
    const res = await fetch(`${server.url}/collections/routes/items`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/geo+json; charset=utf-8");
    expect(await res.text()).toBe("");
  });
});

describe("one item", () => {
  it("the feature, its id the path's, with self, alternate and collection", async () => {
    const { status, contentType, body } = await request<Item>(`${server.url}/collections/routes/items/4`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/geo+json; charset=utf-8");
    // Cairo–Tokyo: no departure, so none in the properties.
    expect(body).toMatchObject({
      type: "Feature",
      id: 4,
      properties: { name: "Cairo–Tokyo", length_km: 9580, lanes: 1 },
    });
    expect(body.properties).not.toHaveProperty("departure");
    expect(rels(body.links)).toEqual([
      "self application/geo+json",
      "alternate text/html",
      "collection application/json",
    ]);
    expect(link(body.links, "collection")?.href).toBe(`${server.url}/collections/routes?f=json`);
  });

  it("serves the features collection's properties as GET /features/:id does", async () => {
    const ogc = await request<Item>(`${server.url}/collections/features/items/7`);
    const rest = await request<Feature>(`${server.url}/features/7`);
    const { links: _l, ...feature } = ogc.body;
    expect(feature).toEqual(rest.body);
  });

  it("404 for an id that isn't there, isn't a number, or is too big", async () => {
    for (const id of ["999999", "abc", "99999999999", "7.0"]) {
      expect(await request(`${server.url}/collections/features/items/${id}`)).toMatchObject({
        status: 404,
        body: { code: "NotFound" },
      });
    }
    expect((await request(`${server.url}/collections/nope/items/1`)).status).toBe(404);
  });

  it("an error asked for as HTML is an HTML page", async () => {
    const { status, contentType } = await request(`${server.url}/collections/features/items/999999?f=html`);
    expect(status).toBe(404);
    expect(contentType).toBe("text/html; charset=utf-8");
  });
});
