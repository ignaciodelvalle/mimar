"use client";

// StaticFirstMap — "static-first embed" wrapper (map-QOL P0 primitive).
//
// WHY: components/LocationMap.tsx (and components/panorama/SituationalMap.tsx,
// components/charts/MapChoropleth.tsx) mount a real MapLibre map — and, for
// LocationMap, start fetching live OSM raster tiles — the moment the host
// component renders, even when the visitor never looks at the map. This
// component fixes that anti-pattern for embeds where the map is secondary
// content (e.g. a small "last seen" or "location" preview): it renders a
// STATIC, non-interactive placeholder by default, and only mounts the real
// interactive MapLibre map (and only THEN pulls the ~200KB maplibre-gl chunk
// + its CSS + live tiles) after the visitor explicitly clicks the "activar
// mapa" affordance below.
//
// This does NOT replace LocationMap.tsx (not modified by this commit) — it is
// a new, opt-in wrapper for hosts that want the static-first behavior.
//
// Lazy-load technique: mirrors components/charts/MapChoropleth.tsx's
// `import("maplibre-gl").then(...)` idiom (a dynamic import INSIDE the mount
// effect, gated on `activated`) rather than next/dynamic — the loading
// skeleton here IS the static placeholder itself, so a second next/dynamic
// loading state would be redundant. Only the maplibre-gl JS runtime (~200KB
// gz) is deferred this way; its CSS is a static top-level side-effect import
// (same as components/LocationMap.tsx / components/panorama/SituationalMap.tsx
// — a dynamic `import()` of a bare .css specifier does not type-check under
// this repo's `moduleResolution: "bundler"` the way a static side-effect
// import does). No tile fetch, no maplibre-gl JS execution, and no MapLibre
// GL context happen until `activated` is set — the CSS alone is a few KB and
// carries no network/runtime cost.
//
// ACCESSIBILITY: no color-only encoding — the precision note ("Ubicación
// exacta"/"Ubicación aproximada") is always paired with text, never a bare
// color swatch. The activation button has a visible label AND an
// aria-describedby pointing at a short explanation of what happens on click.

// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";
import { useEffect, useId, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

import { Icon } from "@/components/Icon";
import { loadMapLibre } from "@/lib/ui/maplibre-loader";

export type StaticFirstMapProps = {
  /** Marker/center latitude. */
  lat: number;
  /** Marker/center longitude. */
  lng: number;
  /** Initial zoom once activated. Default 14 (matches LocationMap.tsx). */
  zoom?: number;
  /** Optional human label shown on the placeholder and in aria-labels. */
  label?: string;
  /**
   * Whether the coordinate is exact or an approximate/coarse centroid.
   * Surfaced as TEXT (never color alone) — see module docblock.
   * Default "exact".
   */
  precision?: "exact" | "approx";
  /** Tailwind height class (static and active states). Default "h-64". */
  heightClassName?: string;
};

const DEFAULT_ZOOM = 14;

export function StaticFirstMap({
  lat,
  lng,
  zoom = DEFAULT_ZOOM,
  label,
  precision = "exact",
  heightClassName = "h-64",
}: StaticFirstMapProps) {
  const [activated, setActivated] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (!activated) return;
    let map: maplibregl.Map | null = null;
    let cancelled = false;

    (async () => {
      // maplibre-gl v6 is ESM-only and has no default export — bind the module
      // namespace itself rather than destructuring a `default` that no longer
      // exists.
      const ml = await loadMapLibre();
      if (cancelled || !containerRef.current) return;

      map = new ml.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        },
        center: [lng, lat],
        zoom,
        interactive: true,
        cooperativeGestures: true,
        attributionControl: { compact: true },
      });
      new ml.Marker({ color: "#dc2626" }).setLngLat([lng, lat]).addTo(map);
      // PO fix (validacion-A 2026-07-23, "no me deja hacer zoom out" on the
      // case-detail location embed): `interactive: true` already enables
      // scrollZoom/doubleClickZoom/touchZoomRotate at the MapLibre level, but
      // with NO visible control the only zoom-OUT gestures are Ctrl+scroll or
      // a touch pinch — cooperativeGestures (kept, so a page-scroll over the
      // map isn't hijacked) makes even that first gesture non-obvious, and
      // double-click/box-zoom only ever zoom IN. An explicit +/- control gives
      // every viewer (mouse-only included) a discoverable way to zoom out.
      // This is a point-detail embed (case/lost-pet/refugio location), never
      // the dashboard choropleth family (components/charts/MapChoropleth.tsx)
      // — that lockdown (no pan, no zoom, no controls) is untouched.
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [activated, lat, lng, zoom]);

  const precisionLabel = precision === "approx" ? "Ubicación aproximada" : "Ubicación exacta";

  return (
    <div className="w-full overflow-hidden rounded-[var(--radius-lg)] border border-ln-op-line">
      {activated ? (
        <div
          ref={containerRef}
          className={`${heightClassName} w-full`}
          aria-label={`Mapa interactivo${label ? ` de ${label}` : ""}, latitud ${lat}, longitud ${lng}. ${precisionLabel}.`}
        />
      ) : (
        // role="img" makes its ENTIRE subtree presentational. It used to sit on
        // this container, which holds the only control that activates the map
        // AND the sr-only text explaining it — so a screen-reader user could
        // not reach either, and the interactive map was unreachable to them
        // outright. Same defect class as RA-9 BR-7 in ForecastChart; the fix is
        // the same: the role wraps the picture only, and everything actionable
        // is a sibling.
        <div
          className={`${heightClassName} relative flex w-full flex-col items-center justify-center gap-2 bg-ln-op-stripe px-4 text-center text-ln-op-mute`}
        >
          <div
            role="img"
            aria-label={`Mapa estático${label ? ` de ${label}` : ""}, latitud ${lat}, longitud ${lng}. ${precisionLabel}.`}
            className="flex flex-col items-center gap-2"
          >
            <Icon name="ubicacion" size={28} decorative />
            {label && <p className="text-sm font-semibold text-ln-op-ink">{label}</p>}
            <p className="text-xs text-ln-op-mute">{precisionLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => setActivated(true)}
            aria-describedby={helpId}
            className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] bg-ln-op-azul px-4 text-md font-medium text-white hover:bg-ln-op-azul-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul"
          >
            Activar mapa interactivo
          </button>
          <p id={helpId} className="sr-only">
            El mapa se muestra estático hasta que lo actives. Al activarlo se carga un mapa
            interactivo con controles de navegación.
          </p>
        </div>
      )}
    </div>
  );
}
