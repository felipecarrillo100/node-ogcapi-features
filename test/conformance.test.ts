import { describe, expect, it } from "vitest";
import { request, useServer } from "./helpers.ts";

const server = useServer();

const CQL2 = "http://www.opengis.net/spec/cql2/1.0/conf";
const FEATURES_1 = "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf";

describe("GET /conformance", () => {
  it("lists the CQL2 classes MapEvolution reads first, in order, then the OGC API ones", async () => {
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
        `${FEATURES_1}/core`,
        `${FEATURES_1}/oas30`,
        `${FEATURES_1}/html`,
        `${FEATURES_1}/geojson`,
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
