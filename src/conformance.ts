import { Router } from "express";
import { CONFORMANCE } from "ogc-cql2";

// The CQL2 classes a filter may use. Not Temporal Functions nor Arithmetic: no queryable is an instant, nor are they
// needed here. A filter needing another class is refused (400). These come first in /conformance, in this order, as
// MapEvolution's REST layer reads them.
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

const FEATURES_1 = "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf";

// The OGC API Features classes (Part 1 Core and its encodings): src/ogc/.
const OGC_API_CLASSES = [`${FEATURES_1}/core`, `${FEATURES_1}/oas30`, `${FEATURES_1}/html`, `${FEATURES_1}/geojson`];

/** Served at /conformance: the CQL2 classes, then the OGC API ones. */
export const CONFORMS_TO: readonly string[] = [...CQL2_CLASSES, ...OGC_API_CLASSES];

export function conformanceRouter(): Router {
  const router = Router();
  router.get("/conformance", (_req, res) => {
    res.json({ conformsTo: CONFORMS_TO });
  });
  return router;
}
