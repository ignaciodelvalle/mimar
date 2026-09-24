"use client";

// Interactive MapLibre + OpenStreetMap picker. Click anywhere on the map to
// place (or move) a marker; the parent receives `{ lat, lng }` via onChange.
//
// Companion to EventMap (which is read-only display). Both share the
// maplibre-gl CSS side-effect; loading either pulls the CSS chunk into the
// shared stylesheet. The runtime is dynamic-imported inside useEffect so
// neither component blocks SSR.

import { loadMapLibre } from "@/lib/ui/maplibre-loader";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import { useEffect, useRef } from "react";

// Default to Buenos Aires city center when the parent hasn't given us a
// starting point. Picked over CABA's exact centroid because it's more
// recognizable to Argentine users and centers the map on the most populated
// jurisdiction.
const DEFAULT_CENTER = { lat: -34.6083, lng: -58.3712 };
const DEFAULT_ZOOM = 11;
const PINNED_ZOOM = 14;

type Props = {
  value: { lat: number; lng: number } | null;
  onChange: (point: { lat: number; lng: number }) => void;
  /**
   * Where to center the EMPTY map (no marker is placed). Used by the public
   * sighting form to open on the pet's disclosed last-known location instead
   * of the Buenos Aires default. Ignored once `value` is set.
   */
  defaultCenter?: { lat: number; lng: number } | null;
};

// Zoom for a context-biased empty map (defaultCenter): closer than the
// city-wide DEFAULT_ZOOM but wider than a pinned point, so the finder sees
// the neighborhood around the last-known location.
const BIASED_ZOOM = 13;

export default function LocationPicker({ value, onChange, defaultCenter = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);
  // Latest onChange held in a ref so we don't tear the map down every time
  // the parent re-renders with a new closure identity.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // `latestValueRef` is updated on every render so the init IIFE — which
  // resolves asynchronously after the maplibre import — can read the most
  // recent parent state when it finally runs. Without this, a user who taps
  // "Usar mi ubicación" between mount and the import settling would have
  // their pin silently dropped (the sync effect's `if (!map) return` guard
  // would fire early, and `[value]` wouldn't change again afterwards).
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  // Same pattern for defaultCenter: read at async-init time without making it
  // an effect dependency (the map is built exactly once).
  const defaultCenterRef = useRef(defaultCenter);
  defaultCenterRef.current = defaultCenter;

  // Init: build the map once, dispose on unmount.
  useEffect(() => {
    let cancelled = false;
    let mapInstance: MapLibreMap | null = null;
    (async () => {
      // maplibre-gl v6 is ESM-only and has no default export — the module
      // namespace itself carries `Map` and `Marker`.
      const maplibregl = await loadMapLibre();
      if (cancelled || !containerRef.current) return;
      // Read the LATEST value at this moment — the parent may have called
      // setPoint while the import was resolving (e.g. via "Usar mi ubicación"
      // resolving faster than the maplibre chunk fetch).
      const initial = latestValueRef.current;
      const center = initial ?? defaultCenterRef.current ?? DEFAULT_CENTER;
      // Bind the map to a `const` and let the outer `let mapInstance` merely
      // TRACK it for the cleanup function. Everything below then closes over a
      // value that is non-null by construction. v6's types are strict enough
      // that TypeScript will not narrow a `let` that two different closures
      // touch (this async body assigns it, the cleanup reads it), and the
      // honest fix is to stop asking it to rather than to assert the null
      // away — which is also what lets the click handler below drop the
      // `as MapLibreMap` cast it used to need.
      const map = new maplibregl.Map({
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
        center: [center.lng, center.lat],
        zoom: initial ? PINNED_ZOOM : defaultCenterRef.current ? BIASED_ZOOM : DEFAULT_ZOOM,
        attributionControl: { compact: true },
      });
      mapInstance = map;
      mapRef.current = map;

      function attachDragListener(marker: MapLibreMarker) {
        marker.on("dragend", () => {
          const { lng, lat } = marker.getLngLat();
          onChangeRef.current({ lat, lng });
        });
      }

      if (initial) {
        const marker = new maplibregl.Marker({ color: "#dc2626", draggable: true })
          .setLngLat([initial.lng, initial.lat])
          .addTo(map);
        markerRef.current = marker;
        attachDragListener(marker);
      }

      map.on("click", (e) => {
        const { lng, lat } = e.lngLat;
        if (!markerRef.current) {
          const marker = new maplibregl.Marker({ color: "#dc2626", draggable: true })
            .setLngLat([lng, lat])
            .addTo(map);
          markerRef.current = marker;
          attachDragListener(marker);
        } else {
          markerRef.current.setLngLat([lng, lat]);
        }
        onChangeRef.current({ lat, lng });
      });
    })();
    return () => {
      cancelled = true;
      mapInstance?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Sync: when the parent's value changes externally (e.g. "Usar mi ubicación"
  // button below the map fills the inputs), move the marker to match.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    (async () => {
      // maplibre-gl v6 is ESM-only and has no default export — the module
      // namespace itself carries `Marker`.
      const maplibregl = await loadMapLibre();
      if (!markerRef.current) {
        const marker = new maplibregl.Marker({ color: "#dc2626", draggable: true })
          .setLngLat([value.lng, value.lat])
          .addTo(map);
        marker.on("dragend", () => {
          const { lng, lat } = marker.getLngLat();
          onChangeRef.current({ lat, lng });
        });
        markerRef.current = marker;
      } else {
        markerRef.current.setLngLat([value.lng, value.lat]);
      }
      map.flyTo({ center: [value.lng, value.lat], zoom: PINNED_ZOOM, duration: 600 });
    })();
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="w-full h-64 rounded-lg overflow-hidden border border-ln-line cursor-crosshair"
      aria-label="Mapa. Tocá para marcar una ubicación."
    />
  );
}
