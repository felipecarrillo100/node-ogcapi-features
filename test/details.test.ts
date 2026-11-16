import { describe, expect, it } from "vitest";
import { request, send, useServer } from "./helpers.ts";

const server = useServer();

describe("/restapi/features/:id/details", () => {
  it("GET: defaults when there is no row yet", async () => {
    const { status, body } = await request(`${server.url}/restapi/features/12/details`);
    expect(status).toBe(200);
    expect(body).toEqual({ featureId: "12", countryName: "", history: "" });
  });

  it("PUT upserts, then GET reads it back", async () => {
    const first = await send(`${server.url}/restapi/features/12/details`, "PUT", {
      countryName: "Brazil",
      history: "One.",
    });
    expect(first).toMatchObject({ status: 200, body: { featureId: "12", countryName: "Brazil", history: "One." } });
    const second = await send(`${server.url}/restapi/features/12/details`, "PUT", { countryName: "Brasil" });
    expect(second.body).toEqual({ featureId: "12", countryName: "Brasil", history: "" });
    expect((await request(`${server.url}/restapi/features/12/details`)).body).toEqual({
      featureId: "12",
      countryName: "Brasil",
      history: "",
    });
  });

  it("PUT for a feature that doesn't exist: 500 (the foreign key), as before", async () => {
    const { status, body } = await send(`${server.url}/restapi/features/999999/details`, "PUT", { countryName: "x" });
    expect(status).toBe(500);
    expect(body).toHaveProperty("error");
  });
});
