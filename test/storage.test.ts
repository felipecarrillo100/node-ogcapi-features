import { describe, expect, it } from "vitest";
import { FILTERABLE, PROPERTIES, splitProperties } from "../src/features/storage.ts";

describe("splitProperties", () => {
  it("takes the native lists out, in tags, floors, visits order, and leaves the rest", () => {
    expect(splitProperties({ name: "a", tags: ["x"], visits: ["2024-01-01"], services: ["lift"] })).toEqual({
      rest: { name: "a", services: ["lift"] },
      lists: [["x"], null, ["2024-01-01"]],
    });
  });

  it("gives NULL for an absent or null list", () => {
    expect(splitProperties({ floors: null })).toEqual({ rest: {}, lists: [null, null, null] });
    expect(splitProperties()).toEqual({ rest: {}, lists: [null, null, null] });
  });

  it("refuses a native list that isn't a list", () => {
    expect(splitProperties({ tags: "museum" })).toBeNull();
    expect(splitProperties({ floors: 3 })).toBeNull();
  });

  it("doesn't change its argument", () => {
    const properties = { name: "a", tags: ["x"] };
    splitProperties(properties);
    expect(properties).toEqual({ name: "a", tags: ["x"] });
  });
});

describe("SQL fragments", () => {
  it("reads the jsonb queryables out as columns: text with ->>, lists with ->", () => {
    expect(FILTERABLE).toBe(
      `(SELECT features.*, properties->>'name' AS "name", properties->'services' AS "services", ` +
        `properties->'zones' AS "zones", properties->'inspections' AS "inspections" FROM features) AS f`,
    );
  });

  it("serves the native lists inside the properties, a NULL one absent", () => {
    expect(PROPERTIES).toBe(
      `properties || jsonb_strip_nulls(jsonb_build_object('tags', "tags", 'floors', "floors", 'visits', "visits"))`,
    );
  });
});
