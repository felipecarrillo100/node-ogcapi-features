import { describe, expect, it } from "vitest";
import { request, send, useServer } from "./helpers.ts";

const server = useServer();

describe("/tile-features/:id/maintenance", () => {
  it("GET: defaults when there is no row yet", async () => {
    const { status, body } = await request(`${server.url}/tile-features/42/maintenance`);
    expect(status).toBe(200);
    expect(body).toEqual({ featureId: "42", assignedTo: "", status: "", lastMaintenanceDate: null });
  });

  it("PUT upserts, then GET reads it back", async () => {
    const saved = await send(`${server.url}/tile-features/42/maintenance`, "PUT", {
      assignedTo: "Ana",
      status: "done",
      lastMaintenanceDate: "2024-05-01",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ featureId: "42", assignedTo: "Ana", status: "done" });
    const read = await request<{ lastMaintenanceDate: string }>(`${server.url}/tile-features/42/maintenance`);
    expect(read.body).toEqual(saved.body);
    // A DATE comes back as pg serializes it (midnight local time, as JSON), as before.
    expect(read.body.lastMaintenanceDate).toBe(new Date(2024, 4, 1).toJSON());
  });

  it("PUT without a date clears it", async () => {
    const { body } = await send(`${server.url}/tile-features/42/maintenance`, "PUT", {
      assignedTo: "Ana",
      status: "open",
    });
    expect(body).toEqual({ featureId: "42", assignedTo: "Ana", status: "open", lastMaintenanceDate: null });
  });
});
