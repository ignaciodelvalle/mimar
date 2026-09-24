"use client";

// MapLibre + OpenStreetMap tile renderer. Loaded via next/dynamic from
// server pages (Next 15 forbids `ssr:false` in server components). Because
// the heavy `maplibre-gl` runtime is imported inside the useEffect below,
// it never participates in SSR; the server-rendered output is just the
// loading skeleton from the dynamic() wrapper, and the JS chunk is only
// fetched on the client when this component mounts.
//
// Consumed by:
//   - app/(app)/mis-mascotas/[publicToken]/eventos/[eventId] — pet event detail
//   - app/(app)/denuncias/[id]                                — welfare report authed
//   - app/denuncias/codigo/[code]                             — welfare report anon

import { loadMapLibre } from "@/lib/ui/maplibre-loader";
import { MAPLIBRE_LOCALE_ES } from "@/lib/ui/maplibre-locale";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";

type Props = {
  lat: number;
  lng: number;
};

export default function LocationMap({ lat, lng }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: MapLibreMap | null = null;
    let cancelled = false;
    (async () => {
      // maplibre-gl v6 is ESM-only and has no default export — the module
      // namespace itself carries `Map` and `Marker`.
      const maplibregl = await loadMapLibre();
      if (cancelled || !containerRef.current) return;
      map = new maplibregl.Map({
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
        zoom: 14,
        attributionControl: { compact: true },
        // es-AR labels for MapLibre's built-in controls — otherwise a screen
        // reader hears "Map marker" / "Toggle attribution" in English on the
        // public lost-credential map. Shared vocabulary with the Panorama map.
        locale: { ...MAPLIBRE_LOCALE_ES, "Map.Title": "Mapa de ubicación" },
      });
      new maplibregl.Marker({ color: "#dc2626" }).setLngLat([lng, lat]).addTo(map);
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [lat, lng]);

  return (
    <div
      ref={containerRef}
      className="w-full h-64 rounded-lg overflow-hidden border border-ln-line "
      aria-label={`Mapa con marcador en latitud ${lat}, longitud ${lng}`}
    />
  );
}
