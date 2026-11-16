import { describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

const CQL2 = "http://www.opengis.net/spec/cql2/1.0/conf";
const FEATURES_1 = "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf";
const FEATURES_3 = "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf";
const COMMON_3 = "http://www.opengis.net/spec/ogcapi-common-3/1.0/conf";
const FEATURES_4 = "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf";

describe("GET /conformance", () => {
  it("lists the 9 CQL2 classes MapEvolution reads first, in order, then the others", async () => {
    const { status, contentType, body } = await request(`${server.url}/conformance`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(body).toEqual({
      conformsTo: [
        `${CQL2}/basic-cql2`,
        `${CQL2}/advanced-comparison-operators`,
        `${CQL2}/case-insensitive-comparison`,
        `${CQL2}/accent-insensitive-comparison`,
        `${CQL2}/property-property`,
        `${CQL2}/array-functions`,
        `${CQL2}/basic-spatial-functions`,
        `${CQL2}/basic-spatial-functions-plus`,
        `${CQL2}/spatial-functions`,
        `${CQL2}/temporal-functions`,
        `${CQL2}/arithmetic`,
        `${FEATURES_1}/core`,
        `${FEATURES_1}/oas30`,
        `${FEATURES_1}/html`,
        `${FEATURES_1}/geojson`,
        "http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs",
        `${FEATURES_3}/queryables`,
        `${FEATURES_3}/queryables-query-parameters`,
        `${FEATURES_3}/filter`,
        `${FEATURES_3}/features-filter`,
        `${CQL2}/cql2-text`,
        `${CQL2}/cql2-json`,
        `${COMMON_3}/schemas`,
        `${COMMON_3}/advanced-property-roles`,
        `${COMMON_3}/returnables-and-receivables`,
        `${COMMON_3}/queryables`,
        `${FEATURES_4}/create-replace-delete`,
        `${FEATURES_4}/update`,
        `${FEATURES_4}/features`,
      ],
    });
  });

  it("f=json answers the same; HTML when asked for", async () => {
    const plain = await request(`${server.url}/conformance`);
    expect((await request(`${server.url}/conformance?f=json`)).body).toEqual(plain.body);
    for (const html of [
      await request<string>(`${server.url}/conformance?f=html`),
      await request<string>(`${server.url}/conformance`, { headers: { Accept: "text/html" } }),
    ]) {
      expect(html.status).toBe(200);
      expect(html.contentType).toBe("text/html; charset=utf-8");
      expect(html.body).toContain(`<a href="${FEATURES_1}/core">`);
    }
  });

  it("refuses an unknown parameter or f (Part 1)", async () => {
    expect((await request(`${server.url}/conformance?x=1`)).status).toBe(400);
    expect((await request(`${server.url}/conformance?f=xml`)).status).toBe(400);
  });
});

describe("GET /restapi/conformance", () => {
  it("lists the REST API's CQL2 classes only: the 9 MapEvolution reads first, in order, then temporal and arithmetic", async () => {
    const { status, contentType, body } = await request(`${server.url}/restapi/conformance`);
    expect(status).toBe(200);
    expect(contentType).toBe("application/json; charset=utf-8");
    expect(body).toEqual({
      conformsTo: [
        `${CQL2}/basic-cql2`,
        `${CQL2}/advanced-comparison-operators`,
        `${CQL2}/case-insensitive-comparison`,
        `${CQL2}/accent-insensitive-comparison`,
        `${CQL2}/property-property`,
        `${CQL2}/array-functions`,
        `${CQL2}/basic-spatial-functions`,
        `${CQL2}/basic-spatial-functions-plus`,
        `${CQL2}/spatial-functions`,
        `${CQL2}/temporal-functions`,
        `${CQL2}/arithmetic`,
      ],
    });
  });

  it("takes any query, as the REST API's /conformance always has", async () => {
    const { status, body } = await request(`${server.url}/restapi/conformance?x=1`);
    expect(status).toBe(200);
    expect((body as { conformsTo: string[] }).conformsTo).toHaveLength(11);
  });
});

describe("the REST API's old paths", () => {
  it("answer 404: the REST API is under /restapi only", async () => {
    for (const path of [
      "/features",
      "/features/7",
      "/features/queryables",
      "/features/7/details",
      "/tile-features/7/maintenance",
      "/routes",
    ]) {
      expect((await request(`${server.url}${path}`)).status, path).toBe(404);
    }
    expect((await request(`${server.url}/features`, { method: "POST" })).status).toBe(404);
  });
});
