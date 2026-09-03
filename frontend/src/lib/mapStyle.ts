import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
// Imported here rather than in main.tsx so it rides along with the lazily
// loaded map chunk. Pages without a map should not pay for map CSS.
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layersWithPartialCustomTheme } from "protomaps-themes-base";

// The CloudFront domain serving basemap.pmtiles and the two pin files. Set by
// Amplify at build time from `terraform output map_cdn_url`.
//
// Read with a fallback and never thrown on, matching cognitoConfig.ts: an
// uncaught error at module-import time blanks the whole page before React even
// mounts, which is a miserable thing to debug. A missing CDN degrades to "the
// map page shows a setup notice" while the rest of the app carries on.
export const MAP_CDN = (import.meta.env.VITE_MAP_CDN as string | undefined) ?? "";

export function isMapConfigured(): boolean {
  return MAP_CDN.length > 0;
}

if (!isMapConfigured()) {
  console.warn(
    "[mapStyle] VITE_MAP_CDN is not set -- the map will show a setup notice " +
      "instead of tiles. Copy it from `terraform output map_cdn_url`."
  );
}

export const PIN_COLORS = {
  // The same rust and forest the ticket stubs use, so a pin and its card read
  // as the same record. Deliberately not the generic red/green.
  lost: "#b5432f",
  found: "#2f6f4e",
} as const;

export type PinKind = keyof typeof PIN_COLORS;

// PMTiles serves the whole tile pyramid as byte ranges of ONE object, so the
// protocol must be registered before any style referencing a pmtiles:// URL
// loads. Registering twice throws, and React strict mode mounts components
// twice in development, hence the guard.
let protocolRegistered = false;

export function registerPmtilesProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  protocolRegistered = true;
}

/**
 * Paper-toned overrides on top of the grayscale theme.
 *
 * The map should recede behind the data: rust and forest pins need to be the
 * loudest things on screen, so the base is warm and desaturated rather than
 * stark white. Only the large flat areas are re-tinted -- roads and labels keep
 * the theme's own contrast ramp, which is the part that is genuinely hard to
 * get right.
 */
const PAPER_THEME = {
  background: "#e7e0ce",
  earth: "#e7e0ce",
  park_a: "#d9ddc5",
  park_b: "#d4d9be",
  wood_a: "#d0d7bd",
  wood_b: "#ccd4b8",
  scrub_a: "#dbdfc6",
  scrub_b: "#d6dbc0",
  grassland: "#dde1c9",
  farmland: "#e2ddc6",
  urban_area: "#e0d8c4",
  water: "#bfcbd1",
  sand: "#ece4cd",
  beach: "#ece4cd",
  buildings: "#dad2be",
  glacier: "#f0ece0",
} as const;

export function buildMapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs:
      "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite:
      "https://protomaps.github.io/basemaps-assets/sprites/v4/grayscale",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${MAP_CDN}/basemap.pmtiles`,
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layersWithPartialCustomTheme(
      "protomaps",
      "grayscale",
      PAPER_THEME,
      "en"
    ),
  } as StyleSpecification;
}

export function pinsUrl(kind: PinKind): string {
  return `${MAP_CDN}/pins/${kind}.geojson`;
}

// Roughly the UK, which is what the basemap extract covers. The opening view,
// and the fallback when there are no pins to fit to.
export const DEFAULT_CENTER: [number, number] = [-1.5, 52.8];
export const DEFAULT_ZOOM = 5.2;
