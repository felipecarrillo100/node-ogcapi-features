import type { Request } from "express";
import { escapeHtml } from "./errors.ts";
import { type Link, url } from "./links.ts";

/** A breadcrumb: its label and its path on the server. */
export type Crumb = readonly [label: string, path: string];

export interface PageOptions {
  /** The resource's links, all shown (the HTML class: every link of the resource as an `<a>`). */
  links?: readonly Link[];
  /** Loads MapLibre GL JS (its CSS and the module) for a map in the body. */
  map?: boolean;
}

/** A plain HTML5 page: a breadcrumb, the body, then the resource's links. */
export function page(
  req: Request,
  title: string,
  crumbs: readonly Crumb[],
  body: string,
  options: PageOptions = {},
): string {
  const trail = [["Home", "/"] as Crumb, ...crumbs]
    .map(([label, path]) => `<a href="${escapeHtml(url(req, path, { f: "html" }))}">${escapeHtml(label)}</a>`)
    .join(" / ");
  const links = options.links?.length ? `<h2>Links</h2>\n${linkList(options.links)}` : "";
  const mapHead = options.map
    ? `<link rel="stylesheet" href="/assets/maplibre-gl/maplibre-gl.css">\n<style>#map { height: 420px; }</style>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${mapHead}</head>
<body>
<nav>${trail}</nav>
${body}
${links}
</body>
</html>
`;
}

export function linkList(links: readonly Link[]): string {
  const items = links.map(
    (l) =>
      `<li><a href="${escapeHtml(l.href)}" rel="${escapeHtml(l.rel)}"${l.type ? ` type="${escapeHtml(l.type)}"` : ""}>${escapeHtml(l.title ?? l.href)}</a> (${escapeHtml(l.rel)}${l.type ? `, ${escapeHtml(l.type)}` : ""})</li>`,
  );
  return `<ul>\n${items.join("\n")}\n</ul>`;
}

/** A table of a feature's properties (values as JSON when they aren't strings). */
export function propertiesTable(properties: Record<string, unknown> | null): string {
  const rows = Object.entries(properties ?? {}).map(
    ([k, v]) =>
      `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`,
  );
  return rows.length ? `<table>\n${rows.join("\n")}\n</table>` : "<p>No properties.</p>";
}

/**
 * The map: OpenStreetMap raster tiles, and the GeoJSON at `dataUrl` (a FeatureCollection, a Feature, or a bbox drawn
 * as a rectangle), zoomed to fit. A click on a feature shows its properties.
 */
export function mapScript(data: { url: string } | { bbox: readonly number[] }): string {
  const source =
    "url" in data
      ? `await (await fetch(${JSON.stringify(data.url)}, { headers: { Accept: "application/geo+json" } })).json()`
      : bboxFeature(data.bbox);
  return `<div id="map"></div>
<script type="module">
import * as maplibregl from "/assets/maplibre-gl/maplibre-gl.mjs";
const data = ${source};
const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [0, 20],
  zoom: 1,
});
const features = data.type === "FeatureCollection" ? data.features : [data];
const positions = [];
const walk = (c) => (typeof c[0] === "number" ? positions.push(c) : c.forEach(walk));
for (const f of features) if (f.geometry) walk(f.geometry.coordinates ?? f.geometry.geometries.map((g) => g.coordinates));
map.on("load", () => {
  map.addSource("data", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({ id: "fill", type: "fill", source: "data", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#3070c0", "fill-opacity": 0.3 } });
  map.addLayer({ id: "line", type: "line", source: "data", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#3070c0", "line-width": 2 } });
  map.addLayer({ id: "point", type: "circle", source: "data", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#3070c0", "circle-radius": 6 } });
  if (positions.length) {
    const xs = positions.map((p) => p[0]), ys = positions.map((p) => p[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 40, maxZoom: 12, animate: false });
  }
  for (const layer of ["fill", "line", "point"]) {
    map.on("click", layer, (e) => {
      const f = e.features[0];
      const table = document.createElement("table");
      const add = (k, v) => {
        const tr = table.insertRow();
        const th = document.createElement("th");
        th.textContent = k;
        tr.append(th);
        tr.insertCell().textContent = typeof v === "string" ? v : JSON.stringify(v);
      };
      if (f.id !== undefined) add("id", f.id);
      // MapLibre hands nested values back as JSON text: shown as they come.
      for (const [k, v] of Object.entries(f.properties)) add(k, v);
      new maplibregl.Popup().setLngLat(e.lngLat).setDOMContent(table).addTo(map);
    });
  }
});
</script>`;
}

function bboxFeature(b: readonly number[]): string {
  const [w, s, e, n] = b as [number, number, number, number];
  const ring = [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  return JSON.stringify({
    type: "Feature",
    properties: { extent: b.join(", ") },
    geometry: { type: "Polygon", coordinates: [ring] },
  });
}
