import { Router } from "express";
import { CONFORMANCE } from "ogc-cql2";

// The CQL2 classes a filter may use. These 9 come first in /conformance, in this order, as MapEvolution's REST layer
// reads them.
const CQL2_CLASSES = [
  CONFORMANCE.basic,
  CONFORMANCE.advancedComparison,
  CONFORMANCE.caseInsensitive,
  CONFORMANCE.accentInsensitive,
  CONFORMANCE.propertyProperty,
  CONFORMANCE.arrays,
  CONFORMANCE.basicSpatial,
  CONFORMANCE.basicSpatialPlus,
  CONFORMANCE.spatial,
];

// Temporal Functions and Arithmetic, which ogc-cql2's toSql runs on postgres: declared since OGC API Phase 2 (the
// owner's decision, 2026-11-16), for the REST API too. A filter needing another class (Functions) is refused (400).
const CQL2_MORE = [CONFORMANCE.temporal, CONFORMANCE.arithmetic];

const CQL2 = "http://www.opengis.net/spec/cql2/1.0/conf";
const FEATURES_1 = "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf";
const FEATURES_3 = "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf";
const COMMON_3 = "http://www.opengis.net/spec/ogcapi-common-3/1.0/conf";
const FEATURES_4 = "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf";

// The OGC API classes (src/ogc/):
// - Part 1 Core and its encodings;
// - Part 3 Filtering, and CQL2's two encodings (which ogc-cql2's CONFORMANCE leaves out: they name an encoding);
// - Part 5 Schemas (OGC API - Common - Part 3);
// - Part 4 Create, Replace, Update, Delete (still a draft, 20-002r1): not its optimistic-locking classes.
const OGC_API_CLASSES = [
  `${FEATURES_1}/core`,
  `${FEATURES_1}/oas30`,
  `${FEATURES_1}/html`,
  `${FEATURES_1}/geojson`,
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
];

/** Served at /conformance: the 9 CQL2 classes first, then the others. */
export const CONFORMS_TO: readonly string[] = [...CQL2_CLASSES, ...CQL2_MORE, ...OGC_API_CLASSES];

/** The CQL2 classes a filter may use (what the OGC API validates filters against). */
export const CQL2_DECLARED: readonly string[] = [...CQL2_CLASSES, ...CQL2_MORE];

export function conformanceRouter(): Router {
  const router = Router();
  router.get("/conformance", (_req, res) => {
    res.json({ conformsTo: CONFORMS_TO });
  });
  return router;
}
