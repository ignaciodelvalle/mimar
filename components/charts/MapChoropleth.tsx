"use client";

import {
  choroplethClassed,
  choroplethColorStops,
  choroplethDomain,
  divergentLegendBins,
} from "@/components/charts/choropleth-stops";
import { stepColorExpr } from "@/components/panorama/class-scale";
import { cellsPaintHatch } from "@/components/panorama/hatch-pattern";
import {
  type GeoLevel,
  type RawDatum,
  departmentBelongsToProvince,
  isCABA,
  joinChoroplethData,
} from "@/lib/infra/geo-join";
import { GOB_MAP_HEIGHT } from "@/lib/ui/map-bounds";
import { loadMapLibre } from "@/lib/ui/maplibre-loader";
import { escapeHtml } from "@/lib/utils/escape-html";
import {
  COLOR_DIVERGENT_ABOVE,
  COLOR_DIVERGENT_BELOW,
  COLOR_DIVERGENT_NEUTRAL,
  COLOR_NO_DATA,
  COLOR_SUPPRESSED,
  RAMP_BLUE,
} from "@dim/contract/viz";
// Namespace type import, not a default import: maplibre-gl v6 is ESM-only
// and publishes NO default export, so `import type maplibregl from ...` no
// longer names anything. The namespace carries the same type members, which
// is what keeps every `maplibregl.Xxx` reference below unchanged.
import type * as maplibregl from "maplibre-gl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Mapa coroplético v2 — MapLibre GL JS con:
 *  - Drill jerárquico: provincia → departamento → barrio (CABA).
 *  - Cross-filter: selección persiste en searchParams (mismo patrón que PeriodPicker).
 *  - Escala tokenizada: colorScale viene de @dim/contract/viz (no hex literal).
 *  - Escala secuencial CLASIFICADA (dataviz review #5): fill discreto por
 *    clases vía components/panorama/class-scale.ts (reutilizado) — la
 *    interpolación continua min→max comprimía los conteos y el mapa "leía
 *    plano". Leyenda y fill derivan de la MISMA ClassScale (choropleth-stops).
 *  - Join robusto: normalizador por nivel, orphanData explícito, flag de supresión.
 *  - A11y: <details> con tabla de datos; aria-label; teclado (Escape para volver).
 *
 * Backward-compatible: los callers que no pasen `allowDrill` ni `level` obtienen
 * el comportamiento v1 sin ningún cambio.
 *
 * Skin audit (consistency/op-skin-followups, 2026-07-19): every current caller
 * is 100% operator surface (/gob/perdidas, /gob/censo, /gob/vigilancia,
 * /gob/campanas + the design/dashboards QA showcase) — same shape as the
 * already-fixed JurisdictionSwitcher/PeriodPicker/DateRangePicker precedent.
 * UI-chrome tokens (breadcrumb, legend labels/captions, swatch/table/map
 * borders, "Ver datos" link) were swapped ln-* → ln-op-*. The DATA-VIZ palette
 * (colorScale/RAMP_BLUE, COLOR_DIVERGENT_*, COLOR_NO_DATA, COLOR_SUPPRESSED,
 * the CARTO_* cartographic stroke constants, and the raw hex used in MapLibre
 * paint expressions / popup HTML) is intentionally UNCHANGED — that's a
 * dataviz-governed encoded palette, not skin chrome.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChoroplethRegionDatum = {
  /** Código de región — emparejado por normalizador de nivel con feature.properties.code. */
  code: string;
  /** Valor numérico que determina el color. */
  value: number;
  /** Etiqueta para tooltip y tabla a11y. */
  label?: string;
  /** Celda suprimida por k-anonimato — se renderiza en COLOR_SUPPRESSED. */
  suppressed?: boolean;
};

export type MapChoroplethProps = {
  /** URL del GeoJSON. Default "/geo/ar-provinces.geojson". */
  geojsonUrl?: string;
  /** Datos de regiones — emparejados con features por `code` normalizado. */
  data: ChoroplethRegionDatum[];
  /**
   * Nivel geográfico del GeoJSON provisto.
   * Determina el normalizador de código. Default: "province".
   */
  level?: GeoLevel;
  /**
   * Ramp de colores [bajo, alto] — DEBE venir de @dim/contract/viz.
   * Acepta tanto ColorRamp (readonly) como [string, string] mutable
   * para compatibilidad con callers v1. Migrar a ColorRamp de viz-scales.ts.
   * Default: RAMP_BLUE.
   *
   * NOTE (dataviz review #5): the SEQUENTIAL fill is now CLASSED — discrete
   * steps sampled from the governed SCALE_BLUE_SEQ ramp via the shared
   * panorama class-scale helpers (RAMP_BLUE is that ramp's poles). This prop
   * no longer drives the sequential fill; it remains only as the fallback
   * palette for the divergent stop sanitizer.
   */
  colorScale?: readonly [string, string] | [string, string];
  /** Centro del mapa [lng, lat]. Default: centroide de Argentina. */
  center?: [number, number];
  /** Zoom inicial. Default 4. */
  zoom?: number;
  /**
   * Alto del mapa: número (px) o cualquier valor CSS válido (p.ej. un
   * `clamp()`). Default: `GOB_MAP_HEIGHT` (lib/ui/map-bounds.ts) — el
   * tratamiento de altura compartido por los 4 mapas de gob.
   */
  height?: number | string;
  className?: string;
  /** Etiqueta de la tabla a11y. */
  fallbackTableLabel?: string;
  /**
   * Whitelist de `feature.properties.code` a renderizar.
   * Cuando se provee y es no-vacía, el GeoJSON se filtra antes de agregar
   * la fuente. Viewport se ajusta solo a esas features.
   */
  visibleCodes?: string[];
  /**
   * Habilita el drill jerárquico interactivo.
   * province → department (o barrio para CABA).
   * Default: false (comportamiento v1).
   */
  allowDrill?: boolean;
  /**
   * Claves de searchParams para cross-filter.
   * Al hacer click en una región actualiza el param del nivel activo,
   * filtrando KPIs y charts de la página vía URL state.
   * Si no se provee, el cross-filter está deshabilitado.
   */
  paramKeys?: {
    province?: string;
    department?: string;
    barrio?: string;
  };
  /**
   * Human-readable label for the scale legend (e.g. "Casos abiertos").
   * When provided, a gradient scale legend with the data min→max range
   * is rendered below the map. Required for dashboards where the color
   * encodes a quantitative variable.
   */
  scaleLabel?: string;
  /**
   * One-line muted caption rendered under the map + legend (es-AR). The /gob
   * dashboards use it for the honesty note that the choropleth encodes
   * ABSOLUTE COUNTS, not a population rate (dataviz review #5; per-capita
   * comparison is fase 3).
   */
  caption?: string;
  /**
   * Color scale rendering mode.
   *  - `"sequential"` (default): linear interpolation from colorScale[0] → colorScale[1].
   *  - `"divergent"`: divergent scale anchored at `target` using SCALE_DIVERGENT_COMPLIANCE
   *    (orange=below target, neutral=at target, teal=above target — colorblind-safe).
   *    Requires `target` to be provided; falls back to sequential if `target` is absent.
   */
  scaleMode?: "sequential" | "divergent";
  /**
   * Compliance target value used when `scaleMode === "divergent"`.
   * Anchors the neutral midpoint of the divergent ramp (e.g. 80 for an 80% coverage goal).
   * Has no effect when `scaleMode` is `"sequential"` (the default).
   */
  target?: number;
  /**
   * Visual review 2026-07-23 (#1): scope-level aggregate for the TOTAL-
   * suppression in-map notice. When every datum in `data` is k-anon suppressed
   * the map paints 100% hatch — an anchored corner card then states the privacy
   * treatment plus this aggregate ("… — N {noun} en el total del alcance").
   * MUST be a figure the page already discloses elsewhere (a KPI tile, the
   * list count): the notice may never introduce a number the k-anon treatment
   * hides, and a total already public on the same screen adds no
   * complementary-disclosure risk. Absent → the card states the treatment
   * without an aggregate clause.
   */
  scopeAggregate?: { count: number; noun: string };
  /**
   * Cartographic form.
   *  - `"flat"` (default): the v1 look — a single flat white 1px region outline
   *    and a plain hover tooltip. Every pre-existing caller keeps this untouched.
   *  - `"panorama"`: brings the Panorama SituationalMap's cartographic polish to
   *    this LIGHT keeper map WITHOUT changing the ChoroplethRegionDatum contract:
   *    a tonal stroke hierarchy (soft white halo + a crisp mid-slate admin
   *    stroke, analog of SituationalMap's COLOR_ADMIN_STROKE), a slightly crisper
   *    data fill, and a structured hover card (place / value / scale-label
   *    caption) with a polished popup skin. Opt-in so the other callers
   *    (campanas, censo, perdidas, design/dashboards) do not regress.
   */
  cartography?: "flat" | "panorama";
};

// ---------------------------------------------------------------------------
// GeoJSON URL per level
// ---------------------------------------------------------------------------

const GEOJSON_BY_LEVEL: Record<GeoLevel, string> = {
  province: "/geo/ar-provinces.geojson",
  department: "/geo/ar-departments.geojson",
  barrio: "/geo/caba-barrios.geojson",
};

const LEVEL_LABELS: Record<GeoLevel, string> = {
  province: "Provincias",
  department: "Departamentos",
  barrio: "Barrios",
};

/** Singular unit noun per level for the total-suppression notice ("Detalle por
 *  departamento protegido…"). */
const LEVEL_UNIT_NOUN: Record<GeoLevel, string> = {
  province: "jurisdicción",
  department: "departamento",
  barrio: "barrio",
};

/** "N <unidad> ocultA/O" per level for the k-anon disclosure line (RA-3 C5).
 *  Written out instead of derived from LEVEL_UNIT_NOUN: es-AR needs the real
 *  plural ("jurisdicciones", not "jurisdiccións") AND the adjective gender
 *  ("jurisdicción oculta" feminine vs "departamento oculto" masculine). */
const LEVEL_HIDDEN_PHRASE: Record<GeoLevel, (n: number) => string> = {
  province: (n) => (n === 1 ? "jurisdicción oculta" : "jurisdicciones ocultas"),
  department: (n) => (n === 1 ? "departamento oculto" : "departamentos ocultos"),
  barrio: (n) => (n === 1 ? "barrio oculto" : "barrios ocultos"),
};

// ---------------------------------------------------------------------------
// Cartography tokens (opt-in `cartography="panorama"`)
// ---------------------------------------------------------------------------
//
// Mirror the Panorama SituationalMap's admin-boundary treatment, adapted to
// MapChoropleth's LIGHT basemap (#e8ecf0). Panorama gets its depth from strong
// admin strokes over a DIMMED dark basemap; on a light surface the analog is a
// soft white halo that lifts every boundary off the colored data fills, with a
// crisp mid-slate admin stroke on top (the light-surface counterpart of
// SituationalMap's COLOR_ADMIN_STROKE "#5b6b8c"). Slightly crisper data fill so
// the regions "sit on" the territory instead of tinting it translucently.
const CARTO_HALO_COLOR = "#ffffff";
const CARTO_HALO_WIDTH = 1.75;
const CARTO_HALO_OPACITY = 0.65;
const CARTO_ADMIN_COLOR = "#64748b"; // slate-500 — reads as a boundary on light + over fills
const CARTO_ADMIN_WIDTH = 0.75;
const CARTO_ADMIN_OPACITY = 0.9;
const CARTO_FILL_OPACITY = 0.88;
const FLAT_FILL_OPACITY = 0.75;

// ---------------------------------------------------------------------------
// Internal drill state
// ---------------------------------------------------------------------------

type DrillCrumb = {
  label: string;
  level: GeoLevel;
  geojsonUrl: string;
  provinceIso?: string;
};

type DrillState = {
  level: GeoLevel;
  geojsonUrl: string;
  breadcrumb: DrillCrumb[];
  provinceIso?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MapChoropleth({
  geojsonUrl,
  data,
  level = "province",
  colorScale = RAMP_BLUE,
  center = [-63.6167, -38.4161],
  zoom = 4,
  height = GOB_MAP_HEIGHT,
  className = "",
  fallbackTableLabel = "Datos del mapa",
  visibleCodes,
  allowDrill = false,
  paramKeys,
  scaleLabel,
  caption,
  scaleMode = "sequential",
  target,
  scopeAggregate,
  cartography = "flat",
}: MapChoroplethProps) {
  const searchParams = useSearchParams();

  const [drillState, setDrillState] = useState<DrillState>({
    level,
    geojsonUrl: geojsonUrl ?? GEOJSON_BY_LEVEL[level],
    breadcrumb: [],
  });

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Refs so event handlers always see the latest state without re-mounting
  const drillStateRef = useRef(drillState);
  drillStateRef.current = drillState;

  const dataRef = useRef(data);
  dataRef.current = data;

  const paramKeysRef = useRef(paramKeys);
  paramKeysRef.current = paramKeys;

  // Classed sequential scale (dataviz review #5) — computed ONCE from the data
  // prop and consumed by BOTH the MapLibre step fill (via ref, map init reads
  // refs) and the legend bins below. Single source of truth: the legend can
  // never imply classes the fill doesn't paint.
  const classed = useMemo(() => choroplethClassed(data), [data]);
  const classedRef = useRef(classed);
  classedRef.current = classed;

  // ---------------------------------------------------------------------------
  // Cross-filter
  // ---------------------------------------------------------------------------
  //
  // `paramKeys` has no current wired consumer (confirmed: all 6 gob/*
  // dashboard pages + design/dashboards + the 2 MapChoropleth/Dynamic
  // wrappers omit it) — it's a documented, not-yet-used extension point
  // ("mismo patrón que PeriodPicker" at the top of this file), not accidental
  // dead code. Curing the mechanism now (rather than deleting it) keeps it
  // correct-by-default whenever a caller wires it.
  //
  // Router-drop defect (engram #621/#622, same reasoning as
  // components/gob/PeriodPicker.tsx / JurisdictionSwitcher.tsx): every
  // current and plausible MapChoropleth host (gob/vigilancia, gob/poblacion,
  // gob/perdidas, gob/censo, gob/campanas, gob/analytics) is an async Server
  // Component that fetches its KPIs/charts from `searchParams` on every
  // request — this is NOT a same-route client-only rerender the way the
  // pet-profile sheets are (lib/ui/sheet-nav.ts's shallow History API
  // helpers do not apply here: a shallow pushState/replaceState would update
  // the URL but never re-run the server fetch, so the "filtrando KPIs y
  // charts de la página" this prop promises would silently never happen —
  // arguably worse than the original defect, since it would look like it
  // works). A full document navigation is the one mechanism proven immune to
  // the silent-drop defect and the only one that actually re-runs the server
  // component with the new searchParams — same as PeriodPicker's
  // updateParams.
  const updateCrossFilter = useCallback(
    (selectedCode: string, currentLevel: GeoLevel) => {
      const keys = paramKeysRef.current;
      if (!keys) return;
      const key = keys[currentLevel];
      if (!key) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set(key, selectedCode);
      window.location.assign(`?${params.toString()}`);
    },
    [searchParams],
  );

  // ---------------------------------------------------------------------------
  // Drill back
  // ---------------------------------------------------------------------------

  function handleDrillBack() {
    setDrillState((prev) => {
      if (prev.breadcrumb.length === 0) return prev;
      const last = prev.breadcrumb[prev.breadcrumb.length - 1];
      return {
        level: last.level,
        geojsonUrl: last.geojsonUrl,
        provinceIso: last.provinceIso,
        breadcrumb: prev.breadcrumb.slice(0, -1),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Map init — re-runs when drill level/url changes
  // ---------------------------------------------------------------------------

  // biome-ignore lint/correctness/useExhaustiveDependencies: MapLibre map initializes once per drill level; data/center/zoom intentionally read from refs inside the effect to avoid full re-init on every prop change. Only re-init when the geographic level/url or drill context changes.
  useEffect(() => {
    if (!mapContainer.current) return;

    // Tear down previous map
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    const {
      level: curLevel,
      geojsonUrl: curUrl,
      provinceIso: curProvinceIso,
    } = drillStateRef.current;
    const curData = dataRef.current;

    let cancelled = false;

    // maplibre-gl v6 is ESM-only and has no default export: the module NAMESPACE
    // is the thing that carries `Map`, `Marker`, `NavigationControl`, so the
    // dynamic import resolves straight to it instead of being destructured.
    loadMapLibre().then((maplibregl) => {
      if (cancelled || !mapContainer.current) return;

      // Privacy (spec §13.4 mirror): tiles-free basemap — background layer only,
      // no external raster source. The choropleth region polygons (per-level
      // local geojson) are added as a data layer on top of this background.
      // No third-party tile provider means no viewport beacon to OSM or similar.
      const STYLE: maplibregl.StyleSpecification = {
        version: 8,
        sources: {},
        layers: [
          {
            id: "bg",
            type: "background",
            paint: { "background-color": "#e8ecf0" },
          },
        ],
      };

      const map = new maplibregl.Map({
        container: mapContainer.current,
        style: STYLE,
        center,
        zoom,
        attributionControl: false,
        // Camera lockdown (gob/map-zoom-lockdown, 2026-07-21): the viewport is
        // fully determined by the selected jurisdiction filter (see the
        // fitBounds call below), never by free user panning/zooming — every
        // operator sees the same framing for the same scope. This turns OFF
        // only camera navigation; region click (drill/cross-filter) and hover
        // (tooltip) stay wired below, unaffected.
        dragPan: false,
        scrollZoom: false,
        boxZoom: false,
        doubleClickZoom: false,
        touchZoomRotate: false,
        dragRotate: false,
        keyboard: false,
        touchPitch: false,
      });

      mapRef.current = map;

      map.on("load", () => {
        if (cancelled) return;

        fetch(curUrl)
          .then((r) => r.json())
          .then((geojson: GeoJSON.FeatureCollection) => {
            if (cancelled) return;

            // Filter features by visibleCodes or province prefix
            let sourceFeatures = geojson.features;

            if (visibleCodes && visibleCodes.length > 0) {
              const visibleSet = new Set(visibleCodes);
              sourceFeatures = sourceFeatures.filter((f) => {
                const code = String((f.properties as Record<string, string>)?.code ?? "");
                return visibleSet.has(code);
              });
            } else if (curLevel === "department" && curProvinceIso) {
              sourceFeatures = sourceFeatures.filter((f) => {
                const code = String((f.properties as Record<string, string>)?.code ?? "");
                return departmentBelongsToProvince(code, curProvinceIso);
              });
            }

            // Robust join — exposes orphanData instead of silently dropping it
            const rawData: RawDatum[] = curData.map((d) => ({
              code: d.code,
              value: d.value,
              label: d.label,
              suppressed: d.suppressed,
            }));

            const { features: joinedFeatures, orphanData } = joinChoroplethData(
              sourceFeatures,
              rawData,
              curLevel,
            );

            if (orphanData.length > 0) {
              console.warn(
                `[MapChoropleth] ${orphanData.length} dato(s) sin feature matching en ${curUrl}:`,
                orphanData.map((o) => o.code),
              );
            }

            const values = joinedFeatures
              .filter((f) => !f.missingData && !f.suppressed)
              .map((f) => f.value ?? 0);
            // Interpolate stops must be strictly ascending or MapLibre rejects
            // the whole fill-color expression (QA round 2 #3). Domain + stop
            // construction live in choropleth-stops.ts, which guarantees a
            // finite, widened domain and sorted/deduped stops for every
            // degenerate input (uniform values, single region, NaN, empty).
            const { minVal, maxVal } = choroplethDomain(values);

            // Enrich GeoJSON features with choropleth metadata
            const enriched: GeoJSON.FeatureCollection = {
              type: "FeatureCollection",
              features: sourceFeatures.map((originalFeature, idx) => {
                const joined = joinedFeatures[idx];
                const extraProps: Record<string, unknown> = {};

                if (joined && !joined.missingData) {
                  extraProps.choropleth_value = joined.suppressed ? minVal : (joined.value ?? 0);
                  extraProps.choropleth_label = joined.label ?? joined.code;
                  extraProps.choropleth_suppressed = joined.suppressed ? "yes" : "no";
                } else {
                  extraProps.choropleth_missing = "yes";
                }

                return {
                  ...originalFeature,
                  properties: { ...originalFeature.properties, ...extraProps },
                };
              }),
            };

            // MapLibre color expression:
            // - suppressed: COLOR_SUPPRESSED
            // - no data:    COLOR_NO_DATA
            // - has data:
            //     · sequential (dataviz review #5): CLASSED step fill — discrete
            //       color per class from the SAME ClassScale that builds the
            //       legend bins (components/panorama/class-scale.ts, reused).
            //       The old continuous 2-stop min→max interpolation compressed
            //       clustered counts into a low-contrast slice ("reads flat").
            //     · divergent: continuous interpolation anchored at `target`
            //       (orange=below, neutral=at, teal=above) — unchanged.
            const isDivergent =
              scaleMode === "divergent" && typeof target === "number" && Number.isFinite(target);

            const dataFillExpr = isDivergent
              ? ([
                  "interpolate",
                  ["linear"],
                  ["get", "choropleth_value"],
                  ...choroplethColorStops({
                    domain: { minVal, maxVal },
                    colorScale,
                    scaleMode,
                    target,
                  }).flat(),
                ] as maplibregl.ExpressionSpecification)
              : // A break-less (flat) scale returns a plain color string — a
                // valid `case` branch output.
                (stepColorExpr(["get", "choropleth_value"], classedRef.current.scale) as
                  | maplibregl.ExpressionSpecification
                  | string);

            const colorExpr: maplibregl.ExpressionSpecification = [
              "case",
              ["==", ["get", "choropleth_suppressed"], "yes"],
              COLOR_SUPPRESSED,
              ["has", "choropleth_value"],
              dataFillExpr,
              COLOR_NO_DATA,
            ];

            map.addSource("regions", { type: "geojson", data: enriched });

            map.addLayer({
              id: "regions-fill",
              type: "fill",
              source: "regions",
              paint: {
                "fill-color": colorExpr,
                "fill-opacity": cartography === "panorama" ? CARTO_FILL_OPACITY : FLAT_FILL_OPACITY,
              },
            });

            // Cartography: panorama-style tonal stroke hierarchy vs the flat v1 outline.
            if (cartography === "panorama") {
              // Soft white halo UNDER the admin stroke — lifts every boundary off
              // the colored fills so adjacent regions separate cleanly (the depth
              // panorama gets from its dimmed dark basemap, on the light surface).
              map.addLayer({
                id: "regions-outline-halo",
                type: "line",
                source: "regions",
                paint: {
                  "line-color": CARTO_HALO_COLOR,
                  "line-width": CARTO_HALO_WIDTH,
                  "line-opacity": CARTO_HALO_OPACITY,
                },
              });
              // Crisp mid-slate admin boundary on top — the hierarchy-aware stroke
              // that reads as a border over both the basemap and the data fill
              // (light-surface analog of SituationalMap's COLOR_ADMIN_STROKE).
              map.addLayer({
                id: "regions-outline",
                type: "line",
                source: "regions",
                paint: {
                  "line-color": CARTO_ADMIN_COLOR,
                  "line-width": CARTO_ADMIN_WIDTH,
                  "line-opacity": CARTO_ADMIN_OPACITY,
                },
              });
            } else {
              map.addLayer({
                id: "regions-outline",
                type: "line",
                source: "regions",
                paint: { "line-color": "#ffffff", "line-width": 1 },
              });
            }

            // map-QOL: diagonal hatching over SUPPRESSED cells — suppression is
            // encoded by pattern + tooltip text, never by color alone.
            const hatchSize = 8;
            const hatchCanvas = document.createElement("canvas");
            hatchCanvas.width = hatchSize;
            hatchCanvas.height = hatchSize;
            const hatchCtx = hatchCanvas.getContext("2d");
            if (hatchCtx) {
              hatchCtx.strokeStyle = "rgba(71, 85, 105, 0.9)";
              hatchCtx.lineWidth = 1.5;
              hatchCtx.beginPath();
              hatchCtx.moveTo(0, hatchSize);
              hatchCtx.lineTo(hatchSize, 0);
              hatchCtx.stroke();
              const hatchImage = hatchCtx.getImageData(0, 0, hatchSize, hatchSize);
              if (!map.hasImage("suppressed-hatch")) {
                map.addImage("suppressed-hatch", hatchImage, { pixelRatio: 1 });
              }
              map.addLayer({
                id: "regions-suppressed-hatch",
                type: "fill",
                source: "regions",
                filter: ["==", ["get", "choropleth_suppressed"], "yes"],
                paint: { "fill-pattern": "suppressed-hatch", "fill-opacity": 0.75 },
              });
            }

            // Selection highlight layer (starts with no-match filter)
            map.addLayer({
              id: "regions-selected",
              type: "line",
              source: "regions",
              filter: ["==", ["get", "code"], "__none__"],
              paint: { "line-color": "#1d4ed8", "line-width": 3 },
            });

            // map-QOL: legend-bin highlight layer (outlines every region whose
            // value falls in the clicked legend bin; no-match filter initially).
            map.addLayer({
              id: "regions-bin-highlight",
              type: "line",
              source: "regions",
              filter: ["==", ["get", "code"], "__none__"],
              paint: { "line-color": "#0e7490", "line-width": 2.5 },
            });

            // Auto-fit bounds
            try {
              let lngMin = Number.POSITIVE_INFINITY;
              let lngMax = Number.NEGATIVE_INFINITY;
              let latMin = Number.POSITIVE_INFINITY;
              let latMax = Number.NEGATIVE_INFINITY;

              function walkCoords(coords: unknown): void {
                if (!Array.isArray(coords)) return;
                if (typeof coords[0] === "number") {
                  const lng = coords[0] as number;
                  const lat = coords[1] as number;
                  if (lng < lngMin) lngMin = lng;
                  if (lng > lngMax) lngMax = lng;
                  if (lat < latMin) latMin = lat;
                  if (lat > latMax) latMax = lat;
                } else {
                  for (const c of coords) walkCoords(c);
                }
              }

              for (const feature of enriched.features) {
                const geom = feature.geometry;
                if (geom && "coordinates" in geom) walkCoords(geom.coordinates);
              }

              const validBbox =
                Number.isFinite(lngMin) &&
                Number.isFinite(lngMax) &&
                Number.isFinite(latMin) &&
                Number.isFinite(latMax) &&
                lngMax > lngMin &&
                latMax > latMin;

              if (validBbox) {
                // Camera lockdown: this is the ONLY place the viewport moves —
                // derived from the real geometry of whatever is actually
                // rendered (visibleCodes-filtered features), never a fixed
                // per-level zoom. National (~24 provinces) naturally lands
                // around z3.5 (Argentina's bbox is tall/narrow — height-bound,
                // already close to the tightest fit a landscape container
                // allows); a single province lands higher; a department/barrio
                // scope (e.g. CABA) lands higher still. `maxZoom: 9` used to
                // cap every scope at the SAME ceiling, which was tight enough
                // for national but silently held CABA/department views back
                // from their natural (much higher, ~11+) fit — the reported
                // "CABA looks too far / tiny" bug. 13 is a generous ceiling
                // that only ever engages for small, dense scopes.
                map.fitBounds(
                  [
                    [lngMin, latMin],
                    [lngMax, latMax],
                  ],
                  { padding: 24, animate: false, maxZoom: 13 },
                );
              }
            } catch {
              // Bbox failed — initial center/zoom stays.
            }

            // Tooltip — the panorama form gets a polished popup skin (self-sufficient
            // card styling in globals.css; no base maplibre CSS import needed).
            const tooltip = new maplibregl.Popup({
              closeButton: false,
              closeOnClick: false,
              ...(cartography === "panorama" ? { className: "mapchoropleth-popup" } : {}),
            });

            map.on("mousemove", "regions-fill", (e) => {
              if (!e.features?.length) return;
              const props = e.features[0].properties as Record<string, string | number>;
              const labelText = props.choropleth_label ?? props.name ?? props.code ?? "";
              const isSuppressed = props.choropleth_suppressed === "yes";
              const isMissing = props.choropleth_missing === "yes";
              const drillable = allowDrill && curLevel !== "barrio";

              // map-QOL: suppressed cells state DATOS INSUFICIENTES explicitly —
              // the operator learns WHY there is no number, not just that it's absent.
              const valStr = isSuppressed
                ? "Datos insuficientes (protegidos por privacidad · k-anonimato)"
                : isMissing
                  ? "Sin datos"
                  : String(props.choropleth_value ?? "—");

              map.getCanvas().style.cursor = drillable ? "pointer" : "default";

              if (cartography === "panorama") {
                // Panorama-structured card: place (muted) / value (strong) / the
                // scale-label caption — mirrors SituationalMap's popup hierarchy.
                // Suppressed + missing stay muted (never a number for a k-anon
                // cell). All interpolated text is escaped (parity with panorama).
                const valueMarkup =
                  isSuppressed || isMissing
                    ? `<span style="color:#64748b">${escapeHtml(valStr)}</span>`
                    : `<strong>${escapeHtml(valStr)}</strong>`;
                const caption = scaleLabel
                  ? `<br/><em style="font-size:11px;color:#64748b">${escapeHtml(scaleLabel)}</em>`
                  : "";
                const pHint = drillable
                  ? `<br/><em style="font-size:11px;color:#64748b">Clic para ver detalle</em>`
                  : "";
                tooltip
                  .setLngLat(e.lngLat)
                  .setHTML(
                    `<div style="font-size:12px;padding:2px 6px"><div style="color:#334155">${escapeHtml(labelText)}</div>${valueMarkup}${caption}${pHint}</div>`,
                  )
                  .addTo(map);
              } else {
                const drillHint = drillable
                  ? `<br/><em style="font-size:11px;color:#6b7280">Clic para ver detalle</em>`
                  : "";
                tooltip
                  .setLngLat(e.lngLat)
                  .setHTML(
                    `<div style="font-size:13px;padding:4px 8px"><strong>${labelText}</strong><br/>${valStr}${drillHint}</div>`,
                  )
                  .addTo(map);
              }
            });

            map.on("mouseleave", "regions-fill", () => {
              map.getCanvas().style.cursor = "";
              tooltip.remove();
            });

            // Click — cross-filter + optional drill
            map.on("click", "regions-fill", (e) => {
              if (!e.features?.length) return;
              const props = e.features[0].properties as Record<string, string>;
              const clickedCode = String(props.code ?? "");
              const clickedName = String(props.name ?? clickedCode);

              // Highlight selection
              map.setFilter("regions-selected", ["==", ["get", "code"], clickedCode]);

              // Cross-filter via searchParams
              updateCrossFilter(clickedCode, curLevel);

              // Drill down
              if (allowDrill && curLevel === "province") {
                const nextLevel: GeoLevel = isCABA(clickedCode) ? "barrio" : "department";
                setDrillState((prev) => ({
                  level: nextLevel,
                  geojsonUrl: GEOJSON_BY_LEVEL[nextLevel],
                  provinceIso: clickedCode,
                  breadcrumb: [
                    ...prev.breadcrumb,
                    {
                      label: clickedName,
                      level: "province",
                      geojsonUrl: GEOJSON_BY_LEVEL.province,
                    },
                  ],
                }));
              }
            });
          })
          .catch((err) => {
            console.error("[MapChoropleth] Error cargando GeoJSON:", err);
          });
      });
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    drillState.level,
    drillState.geojsonUrl,
    drillState.provinceIso,
    colorScale,
    allowDrill,
    scaleMode,
    target,
    cartography,
  ]);

  // ---------------------------------------------------------------------------
  // Scale range for gradient legend — derived from non-suppressed data values.
  // ---------------------------------------------------------------------------

  const scaleBounds = useMemo(() => {
    const values = data.filter((d) => !d.suppressed).map((d) => d.value);
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return { min, max };
  }, [data]);

  // ---------------------------------------------------------------------------
  // map-QOL: legend bins — clicking one outlines every region in that range.
  // Sequential: 4 equal intervals; divergent: below/above the compliance target.
  // ---------------------------------------------------------------------------

  const [activeBin, setActiveBin] = useState<number | null>(null);

  // Bin construction lives in choropleth-stops.ts (unit-tested there).
  // Sequential bins come from the SAME ClassScale as the painted step fill
  // (dataviz review #5 — legend === encoding by construction); the narrow
  // INTEGER domain still collapses to one bucket per value ("4", "5", "6" —
  // visual review 2026-07-23 #3). Divergent keeps its two target-split bins.
  const divergentActive =
    scaleMode === "divergent" && typeof target === "number" && Number.isFinite(target);

  const legendBins = useMemo(() => {
    if (divergentActive) return divergentLegendBins(target as number);
    return classed.bins;
  }, [divergentActive, target, classed]);

  // A drill re-init rebuilds the map with the no-match filter — reset the bin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the drill identity is the intended trigger.
  useEffect(() => {
    setActiveBin(null);
  }, [drillState.level, drillState.geojsonUrl]);

  const onBinClick = (index: number) => {
    const map = mapRef.current;
    if (!map || !map.getLayer("regions-bin-highlight")) return;
    const next = activeBin === index ? null : index;
    setActiveBin(next);
    if (next === null) {
      map.setFilter("regions-bin-highlight", ["==", ["get", "code"], "__none__"]);
      return;
    }
    // Half-open bin semantics (mirrors the step fill): lo inclusive, hi
    // EXCLUSIVE, null = unbounded — a value exactly AT a break highlights in
    // the UPPER class only, exactly as it is painted.
    const bin = legendBins[next];
    const conditions: unknown[] = [
      "all",
      ["has", "choropleth_value"],
      ["!=", ["get", "choropleth_suppressed"], "yes"],
    ];
    if (bin.lo !== null) conditions.push([">=", ["get", "choropleth_value"], bin.lo]);
    if (bin.hi !== null) conditions.push(["<", ["get", "choropleth_value"], bin.hi]);
    map.setFilter("regions-bin-highlight", conditions as maplibregl.FilterSpecification);
  };

  // map-QOL empty states — the note says WHY the map is empty, not just that it is.
  const isEmpty = data.length === 0;
  const allSuppressed = data.length > 0 && data.every((d) => d.suppressed);

  // RA-3 C6: does THIS frame actually paint a hatch? The shared atom
  // (components/panorama/hatch-pattern.ts) that already gates LegendPill and
  // MapLegends — same question, same module, one answer. The legend's
  // "Datos insuficientes (privacidad)" swatch was unconditional on every
  // caller, which is the exact defect legend-suppression-parity.test.tsx was
  // written for, reappearing in the OTHER map component.
  const framePaintsHatch = cellsPaintHatch(data);
  const suppressedInFrame = data.filter((d) => d.suppressed).length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={className}>
      {/* Breadcrumb + Volver */}
      {allowDrill && drillState.breadcrumb.length > 0 && (
        <nav aria-label="Nivel de mapa" className="mb-2 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={handleDrillBack}
            className="text-ln-op-azul hover:underline font-medium"
          >
            ← Volver
          </button>
          <ol className="flex items-center gap-1 list-none m-0 p-0">
            {drillState.breadcrumb.map((crumb, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumbs are positional
                key={i}
                className="flex items-center gap-1"
              >
                <span className="text-ln-op-ink-2">{crumb.label}</span>
                <span className="text-ln-op-mute" aria-hidden="true">
                  /
                </span>
              </li>
            ))}
            <li className="text-ln-op-ink font-medium">{LEVEL_LABELS[drillState.level]}</li>
          </ol>
        </nav>
      )}

      {/* Mapa */}
      <div className="relative">
        <div
          ref={mapContainer}
          style={{ height }}
          className="w-full rounded-xl overflow-hidden border border-ln-op-line"
          aria-label={fallbackTableLabel}
          role="img"
        />
        {/* Visual review 2026-07-23 (#1): TOTAL-suppression in-map notice. When
            EVERY region is k-anon suppressed the map paints 100% hatch and the
            only explanation was the hover tooltip — operators read it as a
            broken map. An anchored corner card (same skin family as the legend
            chrome) states the treatment IN the map, plus the scope aggregate
            when the caller provides one (a figure its page already discloses —
            see the scopeAggregate prop doc). Sits OUTSIDE the role="img" node
            so assistive tech reads it as its own note, not image alt content;
            pointer-events-none keeps the hatched regions hoverable under it. */}
        {allSuppressed && (
          <p
            role="note"
            className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-xs rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card/95 px-3 py-2 text-xs leading-snug text-ln-op-ink-2 shadow-md"
          >
            {`Detalle por ${LEVEL_UNIT_NOUN[drillState.level]} protegido por privacidad (k<5)`}
            {scopeAggregate
              ? ` — ${scopeAggregate.count.toLocaleString("es-AR")} ${scopeAggregate.noun} en el total del alcance.`
              : "."}{" "}
            Las regiones se muestran con trama, sin números.
          </p>
        )}
      </div>

      {/* map-QOL empty state — states the REASON, not just the absence. The
          all-suppressed state moved INTO the map as the anchored corner card
          above (visual review 2026-07-23 #1); this below-map note now covers
          only the genuinely-empty scope. */}
      {isEmpty && (
        <p
          role="note"
          className="mt-2 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-3 py-2 text-xs text-ln-op-ink-2"
        >
          Sin datos para el filtro seleccionado: no hay valores que mostrar en este alcance y
          período.
        </p>
      )}

      {/* Leyenda del mapa */}
      <figure
        className="mt-2 space-y-1.5"
        aria-label={`Leyenda: ${scaleLabel ?? fallbackTableLabel}`}
      >
        <figcaption className="sr-only">
          {scaleLabel ?? fallbackTableLabel} — escala de colores y estados especiales del mapa
        </figcaption>

        {/* Divergent scale — continuous gradient anchored at the target.
            (Unchanged; the classed redesign applies to sequential only.) */}
        {scaleLabel && divergentActive && scaleBounds && scaleBounds.min !== scaleBounds.max && (
          <div
            role="img"
            aria-label={`Escala de color para ${scaleLabel}: bajo meta ${target}% (naranja) — sobre meta (verde azulado)`}
          >
            <p className="text-xs text-ln-op-mute mb-0.5">{scaleLabel}</p>
            {/* Divergent legend: two poles with the target anchor labeled.
                Mirrors the F5 Panorama province-choropleth legend semantics.
                Colorblind-safe: orange=below, neutral=at target, teal=above. */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-ln-op-mute">bajo meta</span>
                <div
                  className="h-2.5 flex-1 rounded-sm border border-ln-op-line"
                  style={{
                    background: `linear-gradient(to right, ${COLOR_DIVERGENT_BELOW}, ${COLOR_DIVERGENT_NEUTRAL}, ${COLOR_DIVERGENT_ABOVE})`,
                  }}
                  aria-hidden="true"
                />
                <span className="text-xs text-ln-op-mute">sobre meta</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-ln-op-mute">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-[var(--radius-xs)] border border-ln-op-line"
                  style={{ background: COLOR_DIVERGENT_NEUTRAL }}
                  aria-hidden="true"
                />
                <span>
                  meta <strong>{target}%</strong>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Sequential scale (dataviz review #5): the old min→max gradient bar
            is GONE — a continuous ramp implied resolution the classed fill
            doesn't paint. The clickable class bins below now double as the
            color legend: each carries the exact painted class color + its
            half-open value range, derived from the SAME ClassScale as the
            fill. Only the scale-label line remains here. */}
        {scaleLabel && !divergentActive && legendBins.length > 0 && (
          <p className="text-xs text-ln-op-mute mb-0.5">{scaleLabel}</p>
        )}

        {/* map-QOL: clickable legend bins — outline the regions in a range. */}
        {legendBins.length > 0 && (
          <fieldset
            aria-label="Resaltar regiones por rango de valores"
            className="flex flex-wrap items-center gap-1.5 border-0 p-0"
          >
            {legendBins.map((bin, i) => (
              <button
                key={bin.label}
                type="button"
                aria-pressed={activeBin === i}
                onClick={() => onBinClick(i)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  activeBin === i
                    ? "border-ln-op-azul bg-ln-op-azul/10 font-medium text-ln-op-azul"
                    : "border-ln-op-line text-ln-op-mute hover:border-ln-op-azul/40"
                }`}
              >
                {/* Classed sequential: the chip shows the EXACT painted class
                    color (same ClassScale as the fill) — the bin row IS the
                    color legend. Divergent bins carry no color (gradient
                    legend above covers them). */}
                {bin.color && (
                  <span
                    className="inline-block h-2.5 w-2.5 flex-none rounded-[var(--radius-xs)] border border-ln-op-line"
                    style={{ background: bin.color }}
                    aria-hidden="true"
                  />
                )}
                {bin.label}
              </button>
            ))}
            {activeBin !== null && (
              <span className="text-xs text-ln-op-mute">resaltando el rango en el mapa</span>
            )}
          </fieldset>
        )}

        {/* Discrete swatches: no-data + suppressed. The suppressed row is GATED
            on the frame actually painting a hatch (RA-3 C6) — a legend that
            names a mark the canvas does not paint teaches the operator that the
            key does not describe the map, and the notice they learn to skip is
            the privacy one. "Sin datos" stays unconditional: any province absent
            from `data` renders in COLOR_NO_DATA, so that swatch is describing
            the basemap's own default state, not a data-dependent mark. */}
        <ul
          className="flex items-center gap-3 list-none m-0 p-0 text-xs text-ln-op-mute"
          aria-label="Estados especiales"
        >
          <li className="flex items-center gap-1">
            <span
              className="inline-block w-3 h-3 rounded-sm border border-ln-op-line"
              style={{ background: COLOR_NO_DATA }}
              aria-hidden="true"
            />
            Sin datos
          </li>
          {framePaintsHatch && (
            <li className="flex items-center gap-1">
              {/* Hatched swatch mirrors the on-map fill-pattern — the suppressed
                  state is encoded by texture + text, never color alone. */}
              <span
                className="inline-block w-3 h-3 rounded-sm border border-ln-op-line"
                style={{
                  background: `repeating-linear-gradient(45deg, ${COLOR_SUPPRESSED}, ${COLOR_SUPPRESSED} 3px, rgba(71, 85, 105, 0.9) 3px, rgba(71, 85, 105, 0.9) 4px)`,
                }}
                aria-hidden="true"
              />
              Datos insuficientes (privacidad)
            </li>
          )}
        </ul>

        {/* RA-3 C5 disclosure: the frame says HOW MANY units it is withholding,
            and does it from the frame's own marks (never a caller-supplied
            count, which can describe a different grain). Suppressed only when
            EVERY unit is hidden → the anchored in-map card already says it, so
            this line would be the third copy of the same sentence. */}
        {framePaintsHatch && !allSuppressed && (
          <p className="text-xs text-ln-op-mute">
            {suppressedInFrame} {LEVEL_HIDDEN_PHRASE[drillState.level](suppressedInFrame)}{" "}
            {"por privacidad (k<5) — con trama, sin número."}
          </p>
        )}

        {/* Honesty caption (dataviz review #5): e.g. the /gob dashboards state
            the values are absolute counts, not a population rate. A <p>, not a
            second <figcaption> — the figure already has its sr-only one. */}
        {caption && <p className="text-xs text-ln-op-mute">{caption}</p>}
      </figure>

      {/* Tabla a11y.
          RA-9 BR-7: the sr-only suffix disambiguates N "Ver datos" toggles on a
          multi-chart dashboard (WCAG 2.4.6) — the <caption> below cannot, it is
          inside the still-collapsed table. */}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ln-op-azul hover:underline text-xs font-medium">
          Ver datos<span className="sr-only"> — {fallbackTableLabel}</span>
        </summary>
        <table className="mt-2 w-full border-collapse text-xs">
          <caption className="sr-only">{fallbackTableLabel}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="border border-ln-op-line px-3 py-1.5 text-left font-semibold text-ln-op-ink-2 bg-ln-op-stripe"
              >
                Región
              </th>
              <th
                scope="col"
                className="border border-ln-op-line px-3 py-1.5 text-left font-semibold text-ln-op-ink-2 bg-ln-op-stripe"
              >
                Valor
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.code}>
                <td className="border border-ln-op-line px-3 py-1.5 text-ln-op-ink">
                  {d.label ?? d.code}
                </td>
                <td className="border border-ln-op-line px-3 py-1.5 text-ln-op-ink tabular-nums">
                  {d.suppressed ? <span className="text-ln-op-mute">— (suprimido)</span> : d.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
