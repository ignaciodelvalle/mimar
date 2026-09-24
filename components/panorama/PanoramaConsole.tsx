"use client";

// PanoramaConsole — the client orchestrator for the situational map.
//
// Owns the per-layer runtime state, fetches /api/panorama/[layer] on toggle
// (threading the active scope/period searchParams so client toggles re-fetch
// with the same filters the server used), and feeds the active layers to the
// (dynamic) SituationalMap. Perdidas is mounted server-side and seeded here as
// the default-on layer, so its features paint on first render without a fetch.
//
// map-QOL fluid state: the whole board (active layers, aggregation level,
// preset, period) is URL-encoded (`?layers=&level=&preset=&period=`) and
// committed via the shallow History API (lib/ui/map-layer-nav.ts) — never a
// document navigation. This SUPERSEDES the interim `window.location.assign`
// cure from commit 0e94f198: preset period commits now stay on the client
// (shallow pushState + client refetch of KPIs and layers), immune to the
// Next 15.5.x router-drop defect because no router transition is involved.
// The URL is the state; localStorage only remembers the last board so a bare
// URL can offer a one-time, subtle restore.

import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import {
  type JurisdictionScope,
  JurisdictionSwitcher,
} from "@/components/gob/JurisdictionSwitcher";
import { CalendarHeatmap } from "@/components/panorama/CalendarHeatmap";
import { ComplianceMetricSelector } from "@/components/panorama/ComplianceMetricSelector";
import { ConsoleNoticeStack } from "@/components/panorama/ConsoleNoticeStack";
import { ContextBar } from "@/components/panorama/ContextBar";
import { DetailDrawer, type SelectedFeature } from "@/components/panorama/DetailDrawer";
import { FiltroPanel } from "@/components/panorama/FiltroPanel";
import { KpiChips } from "@/components/panorama/KpiChips";
import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import { LegendCaptionBlock } from "@/components/panorama/LegendCaptionBlock";
import { LegendPill } from "@/components/panorama/LegendPill";
import { MapErrorBoundary } from "@/components/panorama/MapErrorBoundary";
import { MapLegendsDynamic } from "@/components/panorama/MapLegendsDynamic";
import { ModeSwitcher } from "@/components/panorama/ModeSwitcher";
import { OverlayDisclosure } from "@/components/panorama/OverlayDisclosure";
import { PanoramaBoardNotices } from "@/components/panorama/PanoramaBoardNotices";
import { PanoramaCaption } from "@/components/panorama/PanoramaCaption";
import { PanoramaDataTable } from "@/components/panorama/PanoramaDataTable";
import { PanoramaDock, type PanoramaDockTab } from "@/components/panorama/PanoramaDock";
import { PanoramaDockRegistros } from "@/components/panorama/PanoramaDockRegistros";
import { PanoramaInformeSituacion } from "@/components/panorama/PanoramaInformeSituacion";
import { PanoramaKpiFooter } from "@/components/panorama/PanoramaKpiFooter";
import {
  PanoramaRail,
  type RailItem,
  type RailPanelItem,
} from "@/components/panorama/PanoramaRail";
import { PanoramaReading } from "@/components/panorama/PanoramaReading";
import { PanoramaStatSection } from "@/components/panorama/PanoramaStatSection";
import { PanoramaSuppressionNotice } from "@/components/panorama/PanoramaSuppressionNotice";
import { PeriodPanel } from "@/components/panorama/PeriodPanel";
import { PresetPanel } from "@/components/panorama/PresetPanel";
import { SavedViewsPopover } from "@/components/panorama/SavedViewsPopover";
import { ScopeDisclosure } from "@/components/panorama/ScopeDisclosure";
import type {
  ActiveLayer,
  DivisionLegendDescriptor,
  PointRenderMode,
  ProvinceSeqLegend,
} from "@/components/panorama/SituationalMap";
import { SituationalMapDynamic } from "@/components/panorama/SituationalMapDynamic";
import { TimeScrubberDynamic } from "@/components/panorama/TimeScrubberDynamic";
import { buildAllSuppressedNotice } from "@/components/panorama/all-suppressed-notice";
import { coalescedGet } from "@/components/panorama/coalesced-get";
import { buildContextSegments } from "@/components/panorama/context-bar-model";
import type { GraduatedBin, GraduatedScale } from "@/components/panorama/graduated-scale";
import { frameHasSuppressedMark } from "@/components/panorama/hatch-pattern";
import { type MapTableRow, useMapTableCsvHref } from "@/components/panorama/map-table-csv";
import { pinCitationAsOf } from "@/components/panorama/panorama-export";
import { buildInformeModel } from "@/components/panorama/panorama-informe";
import {
  activeVistaName,
  capasCountLabel,
  countFiltroModifiers,
  describeCapasMeta,
  filtroBadgeAriaLabel,
  legendRampEndpointLabels,
  legendRampTitle,
} from "@/components/panorama/panorama-labels";
import { buildMapModeControlModel } from "@/components/panorama/panorama-map-modes";
import {
  buildMapTableRows,
  sumSuppressedTableUnits,
  summarizeDockRecords,
} from "@/components/panorama/panorama-map-table";
import type { RuleChangeMarkerDatum } from "@/components/panorama/rule-change-markers";
import {
  buildMapTableCaption,
  deriveLiveScopeLabel,
  resolveScopeLabel,
} from "@/components/panorama/scope-truth";
import {
  binDailyCounts,
  binTimestamps,
  dailyCountsFromTimestamps,
} from "@/components/panorama/signal-histogram";
import {
  Z_LOCALITY,
  mountPlaceholderZoom,
  resolveDataLevel,
} from "@/components/panorama/situational-map-utils";
import { useAsOfFrame } from "@/components/panorama/use-asof-frame";
import { useKeyedAbort } from "@/components/panorama/use-keyed-abort";
import { usePanoramaKpis } from "@/components/panorama/use-panorama-kpis";
import { usePanoramaRanking } from "@/components/panorama/use-panorama-ranking";
import { useVistaMetricProjection } from "@/components/panorama/use-vista-metric-projection";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { PANORAMA_DEFAULT_PRESET, resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import type { LocalityCentroids } from "@/lib/infra/ar-localidades";
import { deferPrint } from "@/lib/infra/defer-print";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import {
  type MapCamera,
  encodeAsOfToParams,
  encodeCameraToParams,
  parseAsOfFromParams,
  parseCameraFromParams,
  pushMapStateUrl,
  replaceMapStateUrl,
  stripCameraParams,
} from "@/lib/ui/map-layer-nav";
import { makeViewScopeDescriptor } from "@/lib/ui/view-scope-descriptor";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import {
  BIVARIATE_MIN_UNITS,
  bivariateAxesLabel,
  bivariateCaptionText,
  bivariatePairFor,
  bivariateRefusalReason,
  buildBivariateCells,
} from "@/src/modules/panorama/domain/bivariate";
import {
  type PanoramaCapabilities,
  ZOOM_REPRESENTATIONS,
  type ZoomBand,
  bivariateEligibleFor,
  capabilitiesFor,
  lodProvinceRollupHint,
  markForZoom,
} from "@/src/modules/panorama/domain/capabilities";
import { captionFor } from "@/src/modules/panorama/domain/caption";
import { checkCompatibility, roleOf } from "@/src/modules/panorama/domain/compatibility";
import { derivePreset } from "@/src/modules/panorama/domain/derive-preset";
import {
  AGGREGATED_POINT_IDS,
  AGGREGATED_POINT_LAYERS,
  CHOROPLETH_LAYERS,
  PANORAMA_LAYERS,
  aggregationBadgeLabel,
  getLayer,
  isAggregatedPointLayer,
  isProvinceOnlyChoropleth,
  isTemporalLayer,
} from "@/src/modules/panorama/domain/layers";
import {
  censusMetaOf,
  isPercapitaEligible,
  percapitaEligibleFor,
  percapitaFooterLabel,
  percapitaLayerLabel,
  projectPerCapita,
} from "@/src/modules/panorama/domain/percapita";
import {
  type ComplianceMetricId,
  DEFAULT_PANORAMA_PRESET_ID,
  PANORAMA_PRESETS,
  type PanoramaPreset,
  type PresetFraming,
  type PresetId,
  getPreset,
  presetLayerIds,
  presetLayerIdsWithBase,
  resolveLegacyPreset,
  shouldEmitPresetFrame,
} from "@/src/modules/panorama/domain/presets";
import { type TimeBasis, formatAsOfDayLong } from "@/src/modules/panorama/domain/time-scrub";
import type {
  AggregationLevel,
  FeatureCollection,
  LayerId,
  PanoramaPeriod,
} from "@/src/modules/panorama/domain/types";
import {
  type AnalyticsPeriodPreset,
  type PanoramaViewState,
  type ViewPeriod,
  makeViewState,
  scopeFromFilter,
  toPeriodSearchParams,
  toScopeFilter,
} from "@/src/modules/panorama/domain/view-state";
import {
  explainViewState,
  layerIdsAreAllCurrentState,
  verifiedOnlyIsHonored,
} from "@/src/modules/panorama/domain/view-state-caption";
import { toast } from "sonner";

export type { SeededLayer } from "@/components/panorama/panorama-console-helpers";
import {
  type ApiResponse,
  BOARD_STORAGE_KEY,
  CHOROPLETH_IDS,
  EMPTY_FC,
  PRESET_FETCH_DEBOUNCE_MS,
  type PanoramaConsoleProps,
  type SavedBoard,
  type SeededLayer,
  applyHintsAfterActivate,
  buildViewMeta,
  calendarEmptyMessage,
  canonicalLayersKey,
  fetchLandingOverridden,
  findRankedFeature,
  initBoardOnMount,
  initialState,
  isAbortError,
  layerFetchPatch,
  loadingPanoramaKpis,
  parseLayersParam,
  pointsDisclosureLine,
  rankingUnitNounFor,
  resolveRowDrillTarget,
  saveBoard,
  scopePeriodQsOf,
  seededLayerUsesProvinceCache,
  shouldParkAtLive,
  unknownLayerIds,
} from "@/components/panorama/panorama-console-helpers";

// Stable empty fallback for the memo()-wrapped CalendarHeatmap (P4).
const EMPTY_DAILY_COUNTS: Array<{ date: string; count: number }> = [];
// Produced nothing AND withheld nothing: an error is not a suppression.
const EMPTY_HISTOGRAM = { days: EMPTY_DAILY_COUNTS, suppressed: false };

export function PanoramaConsole({
  defaultLayerId,
  defaultFeatures,
  defaultTruncated = false,
  defaultSuppressedCount = 0,
  defaultNoLocalityCount = 0,
  initialKpis,
  kpisPromise,
  initialBounds,
  localityCentroids = {},
  initialLevel = "province",
  filtersSlot,
  initialDivisionProvince = null,
  initialDivisionLocality = null,
  defaultPresetId = DEFAULT_PANORAMA_PRESET_ID,
  seededPresetId,
  seededLayers,
  scopeLabel,
  allowedProvinces,
  localities: initialLocalities = [],
  aboutSlot,
  demoNotice,
  boundedJurisdiction = false,
  cubeBuiltAt = null,
  scopeAuthority,
}: PanoramaConsoleProps) {
  // perf plan 1.2: a first-visit seed is present only when the server handed
  // down BOTH the preset id and at least one layer envelope. Everything below
  // gates on this so a non-seeded (normal) render keeps today's behavior.
  const hasSeed = seededPresetId != null && seededLayers != null && seededLayers.length > 0;
  const searchParams = useSearchParams();
  // política → resultado: which surface hosts this console. The marker card's
  // single link out points at /admin/inteligencia (the Política → resultado
  // table with the full causality caveat) — admin-only, so a gob operator
  // gets NO link rather than a dead 403 (presentation only; the marker FETCH
  // is scope-enforced server-side regardless).
  const pathname = usePathname();
  // panorama-redesign Fase 1: per-key fetch cancellation. Key = layer id for
  // /api/panorama/[layer] fetches, "kpis" for the KPI strip — last click wins
  // per key; superseded fetches abort instead of racing the UI state.
  const { signalFor } = useKeyedAbort();

  // Cube-freshness stamp describes the SSR-SEEDED frame only: the first client
  // layer refetch invalidates "Datos precalculados al …" (review 2026-07-17).
  // One-way latch — dropCubeStamp() fires beside every layer fetch below; after
  // it the caption reads "Datos en vivo". (Pessimistic; per-response source
  // threading deferred — fence panorama-dropcubestamp-adjacency.test.ts.)
  const [seedCubeBuiltAt, setSeedCubeBuiltAt] = useState(cubeBuiltAt);
  const cubeStampDroppedRef = useRef(false);
  const dropCubeStamp = useCallback(() => {
    if (cubeStampDroppedRef.current) return;
    cubeStampDroppedRef.current = true;
    setSeedCubeBuiltAt(null);
  }, []);

  // panorama embedded-drill — CLIENT-COMMITTED scope. A province/locality drill
  // (map click, "← Volver", or the JurisdictionSwitcher) commits via a shallow
  // History pushState, which — like the preset/period commits — is NOT observed
  // by useSearchParams() in production (the same router-drop-immune mechanism
  // this whole console uses, engram #621/#622). So the committed scope lives in
  // THIS state, not in searchParams; everything scope-derived reads the
  // EFFECTIVE scope below. `null` = no drill yet → the SSR searchParams win.
  const [scopeOverride, setScopeOverride] = useState<{
    province: string | null;
    locality: string | null;
  } | null>(null);
  // Validate the URL province against the known set (cowork round 2): an invalid
  // `?province=AR-ZZ` used to flow into the scope key + KPI fetch and leave the
  // strip stuck on "Cargando indicadores…" (the incoherent state never resolved).
  // Drop an unknown code → national, so every surface stays coherent.
  const urlProvince = searchParams.get("province");
  const validUrlProvince = urlProvince && provinceByCode(urlProvince) ? urlProvince : null;
  const effectiveScopeProvince = scopeOverride ? scopeOverride.province : validUrlProvince;
  const rawScopeLocality = scopeOverride
    ? scopeOverride.locality
    : (searchParams.get("locality") ?? null);
  // Fork A normalization (task #50 P1b): a locality is meaningless without a
  // province SOMEWHERE — the URL/override scope OR the operator's jurisdiction
  // (initialDivisionProvince). A crafted ?locality=X with no province anywhere
  // used to force locality-level aggregation on a nationally-framed map (and a
  // "Palermo" scope label over a national view) — an incoherent latent state no
  // real UI path produces. Drop the orphan at this single scope source so EVERY
  // surface (label, level, fetches) stays coherently national; matches the
  // canonical ViewScope's illegal-state design. Legitimate localities (a drill,
  // or a jurisdiction operator whose province is implicit) are always preserved.
  const effectiveScopeLocality =
    effectiveScopeProvince != null || initialDivisionProvince != null ? rawScopeLocality : null;
  // Ref mirror of the effective province so the popstate handler (below) can
  // read the CURRENT scope without re-subscribing the listener on every scope
  // change — it decides whether a reverted URL needs a fresh scope bundle.
  const effectiveScopeProvinceRef = useRef(effectiveScopeProvince);
  effectiveScopeProvinceRef.current = effectiveScopeProvince;
  // Ref mirror of the effective locality — read by applyPreset (a stable
  // useCallback) so the vista-switch frame decision sees the CURRENT scope
  // without re-creating the callback on every locality change.
  const effectiveScopeLocalityRef = useRef(effectiveScopeLocality);
  effectiveScopeLocalityRef.current = effectiveScopeLocality;
  // MAP-2: the popstate handler (declared below, before applyPreset) re-derives the
  // board (preset/layers) from the popped URL through this ref, so it can reach the
  // re-derivation defined AFTER applyPreset without a forward reference. Assigned
  // during render once applyPreset exists (mirrors the onZoomRef idiom).
  const resyncBoardFromUrlRef = useRef<((params: URLSearchParams) => void) | null>(null);

  // The selected province's localities + centroids. Seeded from the server props
  // (the scope the page rendered); an embedded drill refreshes it from
  // /api/panorama/scope so the switcher dropdown + the map's locality autozoom
  // centroids track the drilled province without a reload.
  const [scopeData, setScopeData] = useState<{
    localities: Array<{ slug: string; name: string }>;
    centroids: LocalityCentroids;
  }>({ localities: initialLocalities, centroids: localityCentroids });
  // Feature data per layer (the default is seeded; others fetched on toggle).
  // This is the LIVE cache (asOf=null). The temporal as-of cache is separate.
  // When the server seeded the default layer at locality level (scoped view,
  // initialLevel="locality"), the seed lands here — this IS the locality cache.
  const dataRef = useRef<Map<LayerId, FeatureCollection>>(
    (() => {
      // First-visit fast path (perf plan 1.2): seed every server-seeded layer
      // whose features live in the LOCALITY cache at `initialLevel` (the level
      // the page seeded them at). seededLayerUsesProvinceCache mirrors the
      // activeLayers read-routing, so seed placement == read placement (C2).
      if (hasSeed) {
        const m = new Map<LayerId, FeatureCollection>();
        for (const seed of seededLayers) {
          if (!seededLayerUsesProvinceCache(seed.id, initialLevel)) m.set(seed.id, seed.features);
        }
        return m;
      }
      return initialLevel === "locality" ? new Map([[defaultLayerId, defaultFeatures]]) : new Map();
    })(),
  );
  // As-of feature cache (F4): the features each layer had at the CURRENT scrub
  // instant. Refreshed when the scrubber moves; cleared when the period/scope
  // changes (a new window invalidates the axis). Live layers stay in dataRef.
  //
  // Keyed by layer id ALONE — one frame, overwritten on every asOf change (an
  // earlier comment claimed "per (layer, asOf-iso)"; the code never did). That
  // blocks B2's frame PREFETCH: warming N+1 clobbers the N on screen. Prefetch
  // needs re-keying to `${layerId}@${iso}` across 13 sites, invalidations kept.
  const asOfDataRef = useRef<Map<LayerId, FeatureCollection>>(new Map());
  // U5 PROVINCE-level choropleth cache. `dataRef` holds the LOCALITY (and point)
  // features; this holds the province-aggregated features for the two choropleth
  // layers. Keyed by layer id; populated lazily when the toggle is on "Provincia"
  // and the layer is active. Cleared (with dataRef's choropleth entries) when the
  // scope/period changes so a new window refetches at the active level.
  //
  // C2 fix: seed the default layer (perdidas, an aggregated point layer) into
  // the cache that matches the axis the SERVER resolved the seed at
  // (initialLevel — see app/*/panorama/page.tsx). Seeding into the other cache
  // would leave the active cache empty on first render, causing the
  // activeLayers memo to find EMPTY_FC → blank map.
  const provinceDataRef = useRef<Map<LayerId, FeatureCollection>>(
    (() => {
      // First-visit fast path: the province-cache counterpart of dataRef above —
      // seed every server-seeded layer that reads from provinceDataRef at
      // `initialLevel` (choropleth / aggregated-point at province level).
      if (hasSeed) {
        const m = new Map<LayerId, FeatureCollection>();
        for (const seed of seededLayers) {
          if (seededLayerUsesProvinceCache(seed.id, initialLevel)) m.set(seed.id, seed.features);
        }
        return m;
      }
      return initialLevel === "province" && isAggregatedPointLayer(defaultLayerId)
        ? new Map([[defaultLayerId, defaultFeatures]])
        : new Map();
    })(),
  );

  // task panorama-bivariate-2026-07-21: the province-grain, k=5-suppressed
  // fallback for the bivariate join's signal axis (currently only "zoonosis"
  // populates it — see ApiResponse.bivariateSignal jsdoc). Kept SEPARATE from
  // provinceDataRef so the standalone signal layer keeps painting its PO
  // 2026-07-16 department-grain bubbles unchanged; only the two bivariate
  // read sites below consult this cache. No server seed (first-visit cold
  // start behaves like any other not-yet-fetched cache: the bivariate
  // eligibility memos already treat a missing entry as "not computed yet").
  const bivariateSignalRef = useRef<Map<LayerId, FeatureCollection>>(new Map());

  // U5 aggregation axis — the granularity TOGGLE. Distinct from the scope filter
  // (JurisdictionSwitcher narrows WHAT is shown; this changes HOW the choropleth
  // layers are aggregated + rendered). The national view defaults to PROVINCE
  // (fast rollup, readable overview — and it keeps the default off the slow
  // rabies-coverage locality rollup); scoped views arrive with
  // initialLevel="locality" so the finest granularity is the default there.
  // map-QOL: the URL (`?level=…`) wins on mount so a shared/restored board
  // reproduces the same axis.
  const [level, setLevel] = useState<AggregationLevel>(() => {
    const urlLevel = searchParams.get("level");
    // MAP-5 fix: `level=locality` needs a province in scope to load divisions. A
    // deep-linked/shared national URL with a stale `level=locality` (no ?province
    // and no implicit jurisdiction province) would leave the choropleth on "Sin
    // datos para esta capa en todo el país" until the operator toggles to
    // Provincias — the KPIs load fine, only the map is stuck. Fall back to province
    // when no province is in scope so the map paints on land; the (scope, zoom)
    // hysteresis still flips to locality on an intentional zoom or a drill.
    if (urlLevel === "locality") {
      const hasProvinceInScope =
        searchParams.get("province") !== null || initialDivisionProvince !== null;
      return hasProvinceInScope ? "locality" : "province";
    }
    if (urlLevel === "province") return "province";
    return initialLevel;
  });
  const levelRef = useRef(level);
  levelRef.current = level;

  // task #78 Part 3: the "solo firmado por matrícula" toggle. Data-affecting (it
  // narrows the cobertura numerator to vet-signed doses), so it is URL-encoded
  // like `level` (?verified=1) — a shared/restored board reproduces it. Seeded
  // from the URL on mount. Only the cobertura layer honors it; every other layer
  // and the KPI strip ignore it (the KPI tile already shows BOTH numbers).
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(
    () => searchParams.get("verified") === "1",
  );
  const verifiedRef = useRef(verifiedOnly);
  verifiedRef.current = verifiedOnly;

  // Set/clear the `verified` query param for a layer fetch: ONLY the cobertura
  // layer carries it (the toggle is rabies-specific), and only while the toggle
  // is on. Kept as a ref-read so every fetch site (level change, scope refetch,
  // toggle-on) threads the SAME live value without re-subscribing.
  const applyVerifiedParam = useCallback((params: URLSearchParams, id: LayerId) => {
    if (id === "cobertura" && verifiedRef.current) params.set("verified", "1");
    else params.delete("verified");
  }, []);

  // panorama-ia-v2 §1.1: the aggregation level is no longer a manual control
  // (AggregationToggle was removed). It is DERIVED from (scope, zoom): scope
  // selection or zooming past Z_LOCALITY drills the map to the locality mark,
  // preferring the finer precision whenever it renders (PO decision #1). The
  // live camera zoom flows up from SituationalMap via `onZoom`.
  //
  // P4b: the placeholder (pre-map-load) zoom is SCOPE-AWARE — see
  // mountPlaceholderZoom for why, and for the landing-state grain contract it
  // now participates in. The first moveend/zoomend corrects to the real camera.
  const [mapZoom, setMapZoom] = useState<number>(mountPlaceholderZoom(initialLevel));
  const onMapZoom = useCallback((zoom: number) => setMapZoom(zoom), []);

  // panorama-event-points — near-zoom REAL event-location DOTS (design D1/D2).
  //
  // A DEDICATED, additive cache slot (A5): points features live HERE, never in
  // dataRef/provinceDataRef, so there is NO collision with the locality-aggregated
  // cache at the same `level` — toggling points↔aggregated repaints from the
  // correct source with no stale paint. The near-band gate is UX only; the server
  // independently re-derives it (see the points effect + route). Points-capable
  // layers (renderPolicy.points): perdidas (Slice 1, sightings), mordeduras
  // (Slice 2, operator-scoped incidents), denuncias (Slice 3, locality centroids).
  const pointsDataRef = useRef<Map<LayerId, FeatureCollection>>(new Map());
  // Version bump to recompute the activeLayers memo after a points fetch resolves
  // (the cache is a ref). The disclosure meta (cap + "sin ubicación" residual) is
  // kept OUT of `states` (A6: distinct copy) so it never races the aggregated fetch.
  const [pointsVersion, setPointsVersion] = useState(0);
  // Per-layer disclosure meta, keyed by layer id (a layer may go active/inactive
  // independently; a single record avoids one layer's fetch clobbering another's).
  const [pointsInfo, setPointsInfo] = useState<
    Record<string, { count: number; truncated: boolean; sinUbicacion: number }>
  >({});
  // Effective scope for the LOD bands: an explicit picker province wins
  // (embedded-drill: the CLIENT-committed scope, not the stale searchParams);
  // otherwise the govt operator's implicit single-province scope.
  const pointsScopeProvince = effectiveScopeProvince ?? initialDivisionProvince;
  const provinceInScope = pointsScopeProvince != null;

  // P4b — the LOD band per layer, resolved from the DECLARATION (renderPolicy →
  // ZOOM_REPRESENTATIONS) against the live camera. This replaces the imperative
  // `pointsEligible`/`POINTS_LAYER_IDS` switch (A7): the band is a pure function
  // of (declaration, zoom, scope), re-evaluated on every camera settle, so no
  // stale mark can linger. `zoomBandsSig` is the stable identity — downstream
  // memos key on it so a zoom settle that flips NO band repaints nothing.
  const zoomBandsSig = PANORAMA_LAYERS.map(
    (l) => markForZoom(ZOOM_REPRESENTATIONS[l.id], mapZoom, provinceInScope).band,
  ).join(",");
  const zoomBands = useMemo(() => {
    const bands = zoomBandsSig.split(",") as ZoomBand[];
    const out = {} as Record<LayerId, ZoomBand>;
    PANORAMA_LAYERS.forEach((l, i) => {
      out[l.id] = bands[i];
    });
    return out;
  }, [zoomBandsSig]);

  // Panorama hardening (task #39): a monotonic key that forces a full remount of
  // the map island. Bumped by the MapErrorBoundary's retry when a render throw
  // took the map down — a fresh SituationalMap re-inits MapLibre from scratch.
  const [mapReloadKey, setMapReloadKey] = useState(0);

  const [states, setStates] = useState<Record<LayerId, LayerPanelState>>(() => {
    const s = initialState();
    const urlLayerIds = parseLayersParam(searchParams.get("layers"));
    if (urlLayerIds === null) {
      if (hasSeed) {
        // First-visit fast path (perf plan 1.2): the server seeded the
        // role-default preset's layers. Mark each active + NON-loading with its
        // seeded envelope so the map paints on first render with no client
        // fetch (perdidas is NOT seeded on this path — the preset owns the board).
        for (const seed of seededLayers) {
          s[seed.id] = {
            active: true,
            loading: false,
            count: seed.features.features.length,
            suppressedCount: seed.suppressedCount,
            noLocalityCount: seed.noLocalityCount,
            truncated: seed.truncated,
          };
        }
        return s;
      }
      // No explicit board in the URL — the server-seeded default layer is on.
      s[defaultLayerId] = {
        active: true,
        loading: false,
        count: defaultFeatures.features.length,
        suppressedCount: defaultSuppressedCount,
        noLocalityCount: defaultNoLocalityCount ?? 0,
        truncated: defaultTruncated,
      };
      return s;
    }
    // URL board: the `layers` param defines the active set. The default layer
    // keeps its server seed only at the axis the server seeded it at
    // (initialLevel); everything else starts loading and is resolved by the
    // mount effect below.
    const urlLevelRaw = searchParams.get("level");
    const urlLevel: AggregationLevel =
      urlLevelRaw === "locality" || urlLevelRaw === "province" ? urlLevelRaw : initialLevel;
    for (const id of urlLayerIds) {
      const seeded =
        id === defaultLayerId && urlLevel === initialLevel && isAggregatedPointLayer(id);
      s[id] = seeded
        ? {
            active: true,
            loading: false,
            count: defaultFeatures.features.length,
            suppressedCount: defaultSuppressedCount,
            noLocalityCount: defaultNoLocalityCount,
            truncated: defaultTruncated,
          }
        : {
            active: true,
            loading: true,
            count: 0,
            suppressedCount: 0,
            noLocalityCount: 0,
            truncated: false,
          };
    }
    return s;
  });
  // Mirror of `states` for effects that must read the latest active set without
  // re-subscribing (the as-of refetch keys on asOf, not on every layer toggle).
  const statesRef = useRef(states);
  statesRef.current = states;

  const qs = searchParams.toString();
  // map-QOL: KPI refetches key on the SCOPE+PERIOD subset only — the shallow
  // board params (layers/level/preset) don't change what the KPIs measure.
  // Embedded-drill: fold the CLIENT-committed scope (effectiveScope*) over the
  // searchParams scope so a shallow drill recomputes this key — which is exactly
  // what re-triggers the generic KPI-refetch + layer-invalidation effects below
  // (they already read window.location.search, updated by the pushState).
  const scopePeriodQs = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (effectiveScopeProvince) params.set("province", effectiveScopeProvince);
    else params.delete("province");
    if (effectiveScopeLocality) params.set("locality", effectiveScopeLocality);
    else params.delete("locality");
    return scopePeriodQsOf(params);
  }, [searchParams, effectiveScopeProvince, effectiveScopeLocality]);
  // "Copiar vista" fidelity: a restored scrub position decoded ONCE from the mount
  // URL. Declared here (ahead of the KPI refetch, which folds asOf into its key) so
  // a deep-linked ?asOf frame reconciles the strip on mount. Client-only.
  const [initialAsOf] = useState<Date | null>(() =>
    typeof window === "undefined"
      ? null
      : parseAsOfFromParams(new URLSearchParams(window.location.search)),
  );
  // Current as-of upper bound. null = live (parked at "ahora"). Starts null even on
  // a deep-linked ?asOf so the FIRST client render matches SSR (which can't read
  // window) — a mount effect below applies the restored cutoff post-hydration,
  // avoiding a React #418 text/structure mismatch (round-2: ?asOf became a
  // first-class deep link, which surfaced the pre-existing divergence).
  const [asOf, setAsOf] = useState<Date | null>(null);

  // Coherence hybrid (cowork QA H1): the temporal-scrub cutoff as a stable ISO
  // string (a new Date identity per render must not thrash the as-of KPI effect
  // below). Null = parked at live.
  /**
   * The as-of INSTANT as a stable string. Both the KPI fetch and the layer fetch
   * key on this, never on the `asOf` Date object: TimeScrubber re-mints that Date
   * from a useMemo, so an unrelated re-render produces a NEW object at the SAME
   * instant. The KPI path already keyed on the string; the layer path did not,
   * and paid for it with a duplicate fetch of every temporal layer on every
   * frame — measured at exactly 2× the necessary traffic during playback
   * (perf review 2026-07-25).
   */
  const asOfIso = asOf ? asOf.toISOString() : null;
  // The KPI strip's state + fetch effects (scope/period refetch, as-of refetch,
  // streamed-seed resolution) live in the hook — extracted verbatim (file-size
  // split). The setters + bookkeeping refs come back because commitPeriod, the
  // popstate resync, applyPreset (seed pre-arm) and the selective refresh below
  // still write the strip imperatively.
  const {
    kpis,
    setKpis,
    kpisPending,
    kpisStale,
    setKpisStale,
    kpisScopeChanging,
    clientKpiTookOverRef,
    seededQsRef,
    kpiFetchQsRef,
  } = usePanoramaKpis({ initialKpis, kpisPromise, scopePeriodQs, asOfIso, initialAsOf, signalFor });

  // W2 fix: the COMMITTED period preset. A preset commit / board restore writes
  // `period=` via a SHALLOW History replace that `useSearchParams()` can't observe,
  // so keying the period chrome (scrubber axis + PeriodPicker) off searchParams
  // alone left it stuck on the 3y default while the data showed the preset window.
  // This state carries the truth; both chrome consumers prefer it (searchParams
  // fallback). Lazy-init on the seeded first-visit so the chrome agrees with the
  // seeded data from FIRST paint (SSR + hydration compute the same initializer, so
  // no hydration mismatch); null on the normal path → searchParams wins as before.
  //
  // C3 period-drift fix (2026-07-22, plan-maestro-integridad §C3 repro): this
  // used to seed unconditionally from `getPreset(seededPresetId)?.periodPreset`
  // — the preset's OWN default window — even when the URL carried an EXPLICIT
  // `?period=` override. `/gob/panorama?preset=sintomas&period=90d` verified the
  // drift live: the server (app/*/panorama/page.tsx `seedPeriod`) correctly
  // honors the explicit 90d override for the KPI fan-out AND the seeded layer
  // features, but this initializer still wrote committedPeriod="30d" (sintomas's
  // own periodPreset) — and `periodParam` below prefers committedPeriod over
  // searchParams, so every caption/scrubber/PeriodPicker reader disagreed with
  // the 90d data actually on screen ("Síntomas / vigilancia sindrómica — CABA,
  // últimos 30 días" over a 90-day KPI/map fetch). Mirror the server's own
  // precedence EXACTLY: an explicit URL `?period=` always wins; only a BARE
  // `?preset=X` (no period param) falls back to the preset's window.
  const [committedPeriod, setCommittedPeriod] = useState<string | null>(() => {
    if (!hasSeed || seededPresetId == null) return null;
    return searchParams.get("period") ?? getPreset(seededPresetId)?.periodPreset ?? null;
  });
  // Root B (panorama QA #3b): the committed CUSTOM window. A custom período now
  // commits SHALLOW (see commitPeriod) — a write useSearchParams() can't observe —
  // so the from/to that feed the analytic window + the DateRangePicker must be
  // carried in state too, exactly as committedPeriod carries the preset id. Both
  // are null on the preset path (from/to fall back to searchParams, as before).
  const [committedFrom, setCommittedFrom] = useState<string | null>(null);
  const [committedTo, setCommittedTo] = useState<string | null>(null);

  // --- F4 temporal reproduction -------------------------------------------
  // The active period window [since, until] drives the scrubber axis. Resolved
  // from the committed period (a shallow preset commit) when present, else the
  // SAME searchParams the server used (parity). `until` is "ahora".
  //
  // Memo keys are the PARAM STRINGS, not the searchParams object identity:
  // `until` is minted from Date.now() on every recompute, so an identity-only
  // searchParams refresh (e.g. an ?asOf= camera/scrub write that never touches
  // period/from/to) would re-mint a drifted `until`, which the TimeScrubber
  // reads as a WINDOW CHANGE and parks the scrub back at live — silently
  // cancelling an active scrub (v2C dock QA, 2026-07-11). String keys make the
  // window stable until the period actually changes.
  const periodParam = committedPeriod ?? searchParams.get("period") ?? PANORAMA_DEFAULT_PRESET;
  // Root B: the committed custom window shadows searchParams (the shallow write
  // useSearchParams can't see), mirroring how periodParam prefers committedPeriod.
  const fromParam = committedFrom ?? searchParams.get("from") ?? undefined;
  const toParam = committedTo ?? searchParams.get("to") ?? undefined;
  // task #50 P1b — the analytic window as a canonical ViewPeriod value. The raw
  // period string passes THROUGH unchanged (a preset id, "custom", or even an
  // unknown value): toPeriodSearchParams + resolveAnalyticsPeriod reproduce the
  // exact same {since,until} the scattered read produced, so this is a pure
  // plumbing change. This same value seeds the canonical viewState below.
  const viewPeriod = useMemo<ViewPeriod>(
    () =>
      periodParam === "custom" && fromParam && toParam
        ? { kind: "custom", from: fromParam, to: toParam }
        : { kind: "preset", preset: periodParam as AnalyticsPeriodPreset },
    [periodParam, fromParam, toParam],
  );
  const { since, until } = useMemo(
    // Panorama defaults to a multi-year window so the scrubber spans the seeded
    // history; the detail dashboards keep their own short defaults. The period
    // search-params now derive from the ViewPeriod via the domain converter.
    () => resolveAnalyticsPeriod(toPeriodSearchParams(makeViewState({ period: viewPeriod }))),
    [viewPeriod],
  );

  // "Copiar vista" fidelity: decode the shared camera + scrub position ONCE from
  // the mount URL (client-only — the map + scrubber consume these only in mount
  // effects, never in SSR render, so a server/client value difference is inert).
  // The camera is reproduced by SituationalMap's load handler; the scrub day
  // seeks the TimeScrubber post-mount so the reproduced view matches the sender.
  const [initialCamera] = useState<MapCamera | null>(() =>
    typeof window === "undefined"
      ? null
      : parseCameraFromParams(new URLSearchParams(window.location.search)),
  );
  // H14 (cowork QA): a deep link with an explicit ?province but NO ?z/lat/lng
  // (camera) used to stay framed on the NATIONAL view — the drill-by-select/click
  // frames, but the URL entry did not. Signal SituationalMap to frame the province
  // polygon ONCE on load, but ONLY when: (a) the URL pins a province, (b) no exact
  // camera is being restored (that wins), and (c) the operator is not
  // jurisdiction-pinned (a scoped govt keeps their own server bbox). Mount-once,
  // client-only — like initialCamera, it drives an imperative post-load map action
  // so an SSR/client difference is inert.
  const [frameProvinceOnLoad] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const p = new URLSearchParams(window.location.search);
    const province = p.get("province");
    return (
      province != null &&
      province !== "" &&
      provinceByCode(province) != null &&
      parseCameraFromParams(p) == null &&
      initialDivisionProvince == null
    );
  });
  const scrubbing = asOf !== null;
  // panorama-vista-redesign QA fix: bumped whenever THIS console forces asOf
  // back to null OUTSIDE a since/until (period) change — a scope-only change
  // (see the invalidation effect below) or temporal availability flipping
  // off (see the temporalAvailable effect near the end). Threaded into
  // TimeScrubber as `resetToken` so its internal slider index resets even
  // when `since`/`until` stay identical (its own win-change reset never
  // fires in that case) — otherwise the scrubber immediately re-emits its
  // stale non-live asOf and undoes this console's own reset.
  const [scrubResetToken, setScrubResetToken] = useState(0);
  // Two-step timeline (PO 2026-08-01): configure tall, play minimal. Held here
  // because the dock sizes on it and the scrubber owns it.
  const [scrubberPlaying, setScrubberPlaying] = useState(false);
  // WP4 — true while the scrub thumb is dragged; useAsOfFrame debounces the
  // layer fan-out on it (click-to-seek never sets it, so clicks stay instant).
  const [scrubDragging, setScrubDragging] = useState(false);

  // Round-2: apply a deep-linked ?asOf AFTER hydration (SSR can't read window, so
  // the render-affecting states above start at their SSR defaults — asOf null, dock
  // closed). This mount-once effect restores the shared scrub frame: sets asOf
  // (which triggers the as-of KPI + layer refetch), opens the dock on the timeline
  // tab so the restored scrubber is visible, and marks the scale as as-of-anchored.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once restore; initialAsOf is a stable per-load value.
  useEffect(() => {
    if (initialAsOf === null) return;
    setAsOf(initialAsOf);
    setDockOpen(true);
    setDockTab("timeline");
  }, []);

  // v2C floating dock — collapsed by default (PO re-ratified 2026-07-11: "MÁS
  // MAPA, la lista es opcional"). A deep link that pins a scrub position (?asOf=)
  // opens on the timeline tab — but that is applied in the mount effect below (not
  // the initializer) so the FIRST client render matches SSR (dock closed), avoiding
  // the hydration mismatch.
  const [dockOpen, setDockOpen] = useState<boolean>(false);
  // Cowork QA ronda 3 §6 (C10): the dock used to open on "Registros" whose badge
  // reads "0" (event count) even when per-unit data exists — a false "vacío"
  // first impression. Default to "Estadísticas" (the ranked per-unit view, which
  // also carries the small-scope fallback so a jurisdiction operator sees their
  // N units ordered by the metric), so the first focused tab is a meaningful view.
  const [dockTab, setDockTab] = useState<PanoramaDockTab>("stats");

  // task #77 bitemporal — the replay basis. "valid" (occurred_at, default) replays
  // "what happened when"; "transaction" (recorded_at) replays "what the State KNEW
  // when". Threaded into the as-of layer fetch as `?basis=`; only matters while
  // scrubbing (the live view is current-state, basis-agnostic). Client-only view
  // state — intentionally NOT URL-encoded (a replay basis is a viewing lens, not a
  // data-scope filter like level/verified).
  const [timeBasis, setTimeBasis] = useState<TimeBasis>("valid");
  const timeBasisRef = useRef(timeBasis);
  timeBasisRef.current = timeBasis;

  // A new period/scope window invalidates the as-of cache and parks at live. It
  // also invalidates the province-level cache and the LOCALITY-level entries in
  // dataRef for choropleth layers AND aggregated point layers (their counts are
  // period-sensitive). Reference layers keep their cache — they refetch on toggle.
  //
  // W2 fix: after clearing the caches, refetch any CURRENTLY ACTIVE layers that
  // are period-sensitive (aggregated point + choropleth). This still applies to
  // period/scope changes that stay within a client-router transition (e.g. the
  // aggregation-level toggle); the preset button now commits its period via a
  // full navigation (see onPreset below), which remounts the console instead of
  // relying on this effect.
  // The fetch uses the NEW searchParams via the effect closure.
  // Mount guard for the cache-invalidation effect below: the server already
  // seeded the default layer at the initial params (C2), so skip the first run.
  const layerSeededQsRef = useRef<string | null>(scopePeriodQs);
  // map-QOL: a preset commit (or board restore) pushes a new period AND fetches
  // its own layers in the same tick — this ref carries the scope+period qs that
  // commit already handled, so the invalidation effect skips one run instead of
  // double-fetching / wiping the just-seeded caches.
  const presetCommittedQsRef = useRef<string | null>(null);
  useEffect(() => {
    // Skip the FIRST run (mount): clearing + refetching here would wipe the C2
    // seed in provinceDataRef and flash a redundant load. Only react to ACTUAL
    // scope/period changes (board params layers/level/preset are excluded).
    if (layerSeededQsRef.current === scopePeriodQs) {
      layerSeededQsRef.current = null;
      return;
    }
    if (presetCommittedQsRef.current === scopePeriodQs) {
      presetCommittedQsRef.current = null;
      return;
    }
    asOfDataRef.current.clear();
    provinceDataRef.current.clear();
    bivariateSignalRef.current.clear();
    for (const id of CHOROPLETH_IDS) dataRef.current.delete(id);
    for (const l of AGGREGATED_POINT_LAYERS) dataRef.current.delete(l.id);
    setAsOf(null);
    // QA fix (finding 3): a scope-only change (province/locality, period
    // unchanged) leaves `since`/`until` identical — TimeScrubber's win-change
    // reset never fires for it, so force its internal position back to live too.
    setScrubResetToken((v) => v + 1);

    // Refetch active period-sensitive layers at the new params.
    const activePeriodSensitive = [...CHOROPLETH_LAYERS, ...AGGREGATED_POINT_LAYERS].filter(
      (l) => statesRef.current[l.id]?.active,
    );
    if (activePeriodSensitive.length === 0) return;

    // Mark them loading before the async fetch.
    setStates((s) => {
      const next = { ...s };
      for (const l of activePeriodSensitive) {
        next[l.id] = { ...s[l.id], loading: true };
      }
      return next;
    });

    const currentQs = new URLSearchParams(window.location.search).toString();
    const currentLevel = levelRef.current;

    void Promise.all(
      activePeriodSensitive.map(async (l) => {
        const params = new URLSearchParams(currentQs);
        if (currentLevel === "province") params.set("level", "province");
        else if (isAggregatedPointLayer(l.id)) params.set("level", "locality");
        applyVerifiedParam(params, l.id);
        try {
          dropCubeStamp();
          const res = await fetch(
            `/api/panorama/${l.id}${params.toString() ? `?${params.toString()}` : ""}`,
            { headers: { accept: "application/json" }, signal: signalFor(l.id) },
          );
          // RA-7 F4: every settle arm routes through layerFetchPatch — the ONE
          // rule for "what does this layer now claim" — so a failure (here a
          // !res.ok, below a network throw) always publishes degraded:true and
          // keeps the last-known privacy envelope. The M1 fix (2026-07-18)
          // covered the HTTP-failure arm inline; the catch arm was left
          // clearing `loading` with degraded UNSET while the caches above were
          // already wiped — the forbidden "Sin datos" fallthrough
          // (situational-map-utils emptyOverlayMessage) for a network throw on
          // a province drill.
          if (!res.ok) {
            setStates((s) => ({ ...s, [l.id]: { ...s[l.id], ...layerFetchPatch(null) } }));
            return;
          }
          const body = (await res.json()) as ApiResponse;
          if (currentLevel === "province") {
            provinceDataRef.current.set(l.id, body.features);
            if (body.bivariateSignal) bivariateSignalRef.current.set(l.id, body.bivariateSignal);
          } else {
            dataRef.current.set(l.id, body.features);
          }
          setStates((s) => ({ ...s, [l.id]: { ...s[l.id], ...layerFetchPatch(body) } }));
        } catch (err) {
          // Superseded fetch — the newer request owns the layer state now.
          if (isAbortError(err)) return;
          // RA-7 F4: a thrown fetch is a FAILURE, not a quiet un-load — same
          // patch as the !res.ok arm (degraded declares itself).
          setStates((s) => ({ ...s, [l.id]: { ...s[l.id], ...layerFetchPatch(null) } }));
        }
      }),
    ).then(() => setLevelVersion((v) => v + 1));
  }, [scopePeriodQs, signalFor, applyVerifiedParam, dropCubeStamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the as-of moves, refetch the ACTIVE TEMPORAL layers at that instant and
  // repaint. Non-temporal layers are not refetched (they are dimmed instead).
  // A version counter forces the activeLayers memo to recompute after fetches
  // resolve (the caches are refs, so we bump state to re-render).
  const [asOfVersion, setAsOfVersion] = useState(0);
  /**
   * Layers the opened URL named that no longer exist. A shared link written
   * before a rename reopens SILENTLY smaller — the operator reads a complete-
   * looking board that is not the one they were sent. Under the "compartir
   * vista" identity that is the same class of defect as a broken deep-link.
   */
  const droppedLayerIds = useMemo(
    () => unknownLayerIds(searchParams.get("layers")),
    [searchParams],
  );

  const frameBaseQs = useMemo(() => {
    const p = new URLSearchParams(searchParams.toString());
    for (const k of ["asOf", "z", "lat", "lng"]) p.delete(k);
    return p.toString();
  }, [searchParams]);
  // The temporal FRAME pipeline (see use-asof-frame.ts for the two defects it
  // fixes by construction: instant-keyed fetches, and reported failures).
  const staleFrame = useAsOfFrame({
    asOfIso,
    // Strip the VOLATILE params the scrub itself writes back into the URL
    // (asOf + camera). Including them made the frame's own URL write re-fire the
    // fan-out a second time for the same instant. `verified`/`encoding` stay —
    // they change what the server returns.
    baseQs: frameBaseQs,
    timeBasis,
    level,
    activeLayerIds: () =>
      PANORAMA_LAYERS.filter((l) => statesRef.current[l.id]?.active).map((l) => l.id),
    asOfData: asOfDataRef.current,
    signalFor,
    dropCubeStamp,
    onFrameSettled: () => setAsOfVersion((v) => v + 1),
    dragging: scrubDragging,
  });

  // Selected map feature → DetailDrawer. Null when the drawer is closed.
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  const onFeatureClick = useCallback(
    (layerId: string, properties: Record<string, unknown>) => {
      const reg = getLayer(layerId as LayerId);
      if (!reg) return;
      // Thread the active period/scope query string so the DetailDrawer's
      // unit-history fetch uses the SAME window as the map (F4).
      setSelected({ layerId: reg.id, layerLabel: reg.label, properties, periodQs: qs });
    },
    [qs],
  );
  const closeDrawer = useCallback(() => setSelected(null), []);

  // panorama embedded-drill — commit a province/locality scope change WITHOUT a
  // reload. Supersedes the interim `window.location.assign` cure (task #55): the
  // scope commit is now a shallow History pushState (immune to the Next
  // router-drop defect, engram #621/#622, exactly like the preset/period
  // commits) + a client refetch. Ordering:
  //   1. Build + push the new `?province=/?locality=` URL (dropping the stale
  //      camera — a frame is only valid for the scope it was captured in).
  //   2. setScopeOverride → recomputes the EFFECTIVE scope, which (a) re-frames
  //      the map via the existing A1 autozoom effect (province bbox from the
  //      in-map polygons — NO server bounds needed), (b) re-derives the level
  //      (scope-wins → locality), and (c) recomputes scopePeriodQs so the
  //      generic KPI-refetch + layer-invalidation effects refetch in place.
  //   3. Fetch the scope bundle (localities + centroids) so the switcher
  //      dropdown + the map's locality autozoom track the drilled province.
  // GRACEFUL FALLBACK: if the scope-bundle fetch fails (network/500), fall back
  // to a full document navigation so a broken drill degrades to today's behavior
  // (the server re-renders the drilled scope), never a half-updated dead map.
  // Shared scope-bundle fetch — refreshes the switcher localities + the map's
  // locality-autozoom centroids for `province`, using the caller-supplied abort
  // signal (so both the drill path and the popstate path get last-write-wins
  // cancellation via the same "scope" key). A non-abort failure degrades to a
  // full document navigation to `fallbackUrl` (the server re-renders the scope),
  // never a half-updated dead map.
  const fetchScopeBundle = useCallback(
    (province: string, signal: AbortSignal, fallbackUrl: string) => {
      const sp = new URLSearchParams({ province });
      fetch(`/api/panorama/scope?${sp.toString()}`, {
        headers: { accept: "application/json" },
        signal,
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{
            localities: Array<{ slug: string; name: string }>;
            localityCentroids: LocalityCentroids;
          }>;
        })
        .then((body) => {
          setScopeData({
            localities: body.localities ?? [],
            centroids: body.localityCentroids ?? {},
          });
        })
        .catch((err) => {
          // Superseded fetch (a newer drill supersedes this one) — not a failure.
          if (isAbortError(err)) return;
          window.location.assign(fallbackUrl);
        });
    },
    [],
  );
  const commitScopeDrill = useCallback(
    (province: string | null, locality: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (province) params.set("province", province);
      else params.delete("province");
      if (locality) params.set("locality", locality);
      else params.delete("locality");
      stripCameraParams(params);
      const qsStr = params.toString();
      const targetUrl = `${window.location.pathname}${qsStr ? `?${qsStr}` : ""}`;
      const provinceChanged = province !== effectiveScopeProvince;
      // Finding 3: abort any in-flight scope bundle UNCONDITIONALLY — a
      // return-to-national (or a locality-only pick) must not let a slow province
      // bundle resolve LATER and clobber scopeData back to the abandoned province.
      const scopeSignal = signalFor("scope");
      pushMapStateUrl(targetUrl);
      setScopeOverride({ province, locality });

      // National scope (return-to-national) needs no bundle — reset in place.
      if (!province) {
        setScopeData({ localities: [], centroids: {} });
        // Return-to-national: the scope-only level effect flips the axis back to
        // "province" on its own (P4c). The camera-baseline reset is for the P4b
        // LOD bands — pre-seed the national band so the first paint after the
        // return doesn't render the drilled band off the stale drilled-in zoom
        // until the fit animation settles.
        setMapZoom(Z_LOCALITY - 1);
        return;
      }
      // Only the PROVINCE change needs a fresh localities/centroids bundle; a
      // locality-only pick keeps the already-loaded province bundle.
      if (!provinceChanged) return;
      fetchScopeBundle(province, scopeSignal, targetUrl);
    },
    [signalFor, effectiveScopeProvince, fetchScopeBundle],
  );

  // Click-to-drill (task #55): a clicked province → embedded scope commit.
  const onProvinceDrill = useCallback(
    (provinceCode: string) => commitScopeDrill(provinceCode, null),
    [commitScopeDrill],
  );
  // In-map "← Volver": pop the province drill back to the national view.
  const onReturnNational = useCallback(() => commitScopeDrill(null, null), [commitScopeDrill]);
  // JurisdictionSwitcher (embedded): a province/locality pick → embedded commit.
  const onSwitcherScopeCommit = useCallback(
    (scope: JurisdictionScope) => commitScopeDrill(scope.province, scope.locality),
    [commitScopeDrill],
  );

  // panorama embedded-drill — browser Back/Forward. A drill commits scope via a
  // NATIVE history.pushState (immune to the router-drop defect, engram
  // #621/#622) and mirrors it in `scopeOverride`, which SHADOWS useSearchParams.
  // But useSearchParams does NOT observe a native popstate in this Next version
  // either — so without this, Back would pop the URL while the map/KPIs/switcher
  // stayed drilled (URL ⇄ view diverge). On popstate we read the POPPED URL
  // straight off window.location and drive the SAME state the drill path does —
  // state-driven, so it is correct whether or not the router re-syncs. The
  // reverted scope's bundle is refreshed for a ?province= URL, aborting any
  // in-flight bundle via the shared "scope" key.
  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      const province = params.get("province");
      const locality = params.get("locality");
      const prevProvince = effectiveScopeProvinceRef.current;
      setScopeOverride({ province, locality });
      // MAP-2: also re-derive the board (preset/layers) from the popped URL — the
      // scope resync alone left the tab/legend/bubbles/KPIs on the previous preset.
      resyncBoardFromUrlRef.current?.(params);
      if (!province) {
        // Return-to-national: abort any in-flight province bundle, reset in place.
        signalFor("scope");
        setScopeData({ localities: [], centroids: {} });
        // Same reset as commitScopeDrill's national branch: the scope-only level
        // effect restores the province axis (P4c); the camera-baseline reset
        // pre-seeds the national LOD band (P4b) so Back never paints the drilled
        // band off the stale drilled-in zoom until the fit settles.
        setMapZoom(Z_LOCALITY - 1);
        return;
      }
      // Same province popped (locality-only change) — the loaded bundle still holds.
      if (province === prevProvince) return;
      fetchScopeBundle(province, signalFor("scope"), window.location.href);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [signalFor, fetchScopeBundle]);

  // Province-fetch version counter — bumped after a province-level choropleth
  // fetch resolves so the activeLayers memo recomputes (the cache is a ref).
  const [levelVersion, setLevelVersion] = useState(0);

  // map-QOL: per-layer opacity multiplier (Personalizar slider). Client-only
  // presentation state — intentionally NOT URL-encoded (the board shares WHAT
  // is shown; how translucent a layer looks is a local viewing preference).
  const [opacities, setOpacities] = useState<Partial<Record<LayerId, number>>>({});
  const onOpacity = useCallback((id: LayerId, value: number) => {
    setOpacities((prev) => ({ ...prev, [id]: value }));
  }, []);

  // panorama-vista-redesign Phase 2: CapasBox Simple/Detalle. Client-only UI
  // pref — persisted (tolerantly) in the board key by Phase 5, never a URL
  // param. Defaults to Simple (false) so a fresh load stays additive-looking.
  const [capasDetail, setCapasDetail] = useState(false);
  // panorama-vista-redesign Phase 4: TimeScrubber Simple/Detalle. Same
  // treatment as capasDetail — client-only, persisted tolerantly (Phase 5).
  const [scrubDetail, setScrubDetail] = useState(false);
  // panorama-vista-redesign Phase 5: ref mirrors so saveBoard's callers (which
  // don't want to depend on — and re-create their identity around — every
  // Simple/Detalle flip) always read the LIVE values, matching the existing
  // verifiedRef/levelRef/timeBasisRef pattern.
  const capasDetailRef = useRef(capasDetail);
  capasDetailRef.current = capasDetail;
  const scrubDetailRef = useRef(scrubDetail);
  scrubDetailRef.current = scrubDetail;

  // task #38 v3 rail — the open rail panel id (null = closed). Controlled here so
  // only one panel is ever open. The Filtro panel reuses `capasDetail`; Vista/
  // Período/Exportar/Acerca have no Simple/Detalle toggle of their own — they
  // always render full detail (panorama QA root-cause #2/3a/5/6). (#49 item
  // 10: the methodology affordance is the rail's own "Acerca" icon now — no
  // KPI-cluster text link.)
  //
  // ContextBar (2026-08-01): this ONE state is shared by three surfaces — the
  // rail, the sticky bar above the map, and the scope disclosure inside it
  // (OverlayDisclosure's controlled mode). `anchor` says only WHERE the single
  // open panel renders; it never duplicates it. So "Período" opened from the bar
  // and from the rail is one instance, and two panels can never be open at once.
  const [panelOpen, setPanelOpen] = useState<{ id: string; anchor: "rail" | "bar" } | null>(null);
  const railOpen = panelOpen?.anchor === "rail" ? panelOpen.id : null;
  const barOpen = panelOpen?.anchor === "bar" ? panelOpen.id : null;
  const setRailOpen = useCallback(
    (id: string | null) => setPanelOpen(id === null ? null : { id, anchor: "rail" }),
    [],
  );
  const setBarOpen = useCallback(
    (id: string | null) => setPanelOpen(id === null ? null : { id, anchor: "bar" }),
    [],
  );
  // task #38 v3 — the map's exportPng, bridged up from SituationalMap (map-ref
  // coupled) so the "Exportar" rail panel can fire it.
  const exportPngFnRef = useRef<(() => void) | null>(null);
  const registerExportPng = useCallback((fn: (() => void) | null) => {
    exportPngFnRef.current = fn;
  }, []);
  // "Copiar vista" — a deep link to the current board (was map-owned; lifted to
  // the Exportar rail panel — it only needs window.location + the clipboard).
  const [copied, setCopied] = useState(false);
  const copyView = useCallback(() => {
    if (typeof window === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => {
        /* clipboard denied — the URL is still shareable from the address bar. */
      },
    );
  }, []);

  // "Citar esta vista" v1 — the honest-by-disclosure frozen citation: pin the
  // corte FIRST, then copy. At the live edge the pin is the generation day
  // (pinCitationAsOf — UTC-day precision, the exact value a URL round-trip
  // restores). The URL write is synchronous (the asOf URL-sync effect only
  // runs after this click returns, and then re-encodes the same day → no
  // churn) so the clipboard NEVER captures a live link; the SAME value goes to
  // state, so the console immediately replays the cut it just cited (as-of
  // serving path — the citation never depends on cache/cube parity) and a
  // subsequent "Informe de situación" prints "Situación al {fecha}" plus the
  // provenance disclosure. An existing scrub corte is preserved untouched.
  const [cited, setCited] = useState(false);
  const citeView = useCallback(() => {
    if (typeof window === "undefined" || !navigator.clipboard) return;
    if (asOf === null) {
      const params = new URLSearchParams(window.location.search);
      const pinned = pinCitationAsOf(params, null);
      replaceMapStateUrl(`${window.location.pathname}?${params.toString()}`);
      setAsOf(pinned);
    }
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setCited(true);
        window.setTimeout(() => setCited(false), 1800);
      },
      () => {
        /* clipboard denied — the pinned URL is still shareable from the address bar. */
      },
    );
  }, [asOf]);

  // task #63: the bivariate "riesgo-brotes" map encoding. P5 (PO 2026-07-14): the
  // selection is a SHAREABLE coordinate — seeded from `?encoding=bivariate` on
  // mount and shallow-synced back (the URL-sync effect), so "Copiar vista"
  // reproduces the operator's favorite view. Offered ONLY while eligible
  // (cobertura × zoonosis at province framing); default OFF otherwise.
  //
  // The DEFAULT is the vista's own declaration, not a hardcoded OFF: a preset
  // that lists `bivariate` in `encodings` opens in it. `brotes-activos` does —
  // the combined-risk read (cobertura × zoonosis) IS the point of that vista, and
  // making the operator find a toggle to get there buried it. An explicit
  // `?encoding=` always wins, in BOTH directions, so a shared link that chose
  // the plain fill still reproduces the plain fill.
  const [bivariateMode, setBivariateMode] = useState(() => {
    const explicit = searchParams.get("encoding");
    if (explicit !== null) return explicit === "bivariate";
    const openingPreset = getPreset((seededPresetId ?? defaultPresetId) as PresetId);
    return openingPreset?.encodings?.includes("bivariate") === true;
  });

  // panorama-percapita: the "por 10.000 hab." encoding selection. Same P5
  // contract as bivariateMode — shallow-synced to `?encoding=` so "Copiar
  // vista" reproduces it — but DELIBERATELY seeded ONLY from an explicit URL
  // selection, never from the opening preset's declaration: bienestar (the
  // preset that declares `percapita`) is ALSO the first-visit DEFAULT preset,
  // so the bivariate "opens in its declared encoding" rule would silently flip
  // the flagship national landing to normalized rates — a product change the
  // PO did not ratify. The declaration still does its two jobs (the URL parses
  // `?encoding=percapita`; derivePreset keeps the vista badge honest); the
  // encoding itself stays one explicit click away. The selection is a MODE;
  // whether it APPLIES (province grain, eligible set, census present) is
  // derived below — a drill below province falls back to counts with an
  // EXPLICIT note, never silently.
  const [percapitaMode, setPercapitaMode] = useState(
    () => searchParams.get("encoding") === "percapita",
  );

  // P5 gift (#32): presentation mode — `?presentation=1` hides the chrome
  // projections (masthead, top-left cluster, rail, dock) and keeps the map +
  // legends + caption. A ViewState with chrome hidden, nothing else. Read once
  // at mount (it is a per-load lens, not a runtime toggle).
  const [presentationMode] = useState(() => searchParams.get("presentation") === "1");

  // ARCHETYPE A: the map's scale legends render OFF-canvas in the dock's
  // "Referencias" tab (MapLegends — moved from the LegendPill panel in the dock
  // redesign). The province ramp + bivariate legends are derived there from
  // mapLayers; these two descriptors are computed imperatively inside
  // SituationalMap's syncLayers (from the rendered data) and lifted here.
  const [divisionLegend, setDivisionLegend] = useState<DivisionLegendDescriptor | null>(null);
  const [graduatedScale, setGraduatedScale] = useState<GraduatedScale | null>(null);
  // Sequential province choropleth classed scale(s), lifted so MapLegends paints
  // the SAME breaks/colors the fill renders (parity with divisionLegend) — never
  // a live-edge recompute that diverges from the locked fill mid-scrub.
  const [provinceSeqLegend, setProvinceSeqLegend] = useState<ProvinceSeqLegend>({});

  // Build the active-layers array for the map from current state + cached data.
  // Under a scrub (asOf !== null): temporal layers paint their AS-OF features;
  // non-temporal layers are DIMMED (current-state data shown muted, never as if
  // it were as-of-t). asOfVersion forces a recompute after as-of fetches resolve.
  const activeLayers = useMemo<ActiveLayer[]>(() => {
    // The as-of features live in a ref (not React state), so `asOfVersion` is the
    // explicit recompute trigger bumped after each as-of fetch resolves. Reading
    // it here keeps the dependency honest (no unused-dep lint). levelVersion does
    // the same for the province cache.
    void asOfVersion;
    void levelVersion;
    void pointsVersion;
    const out: ActiveLayer[] = [];
    for (const l of PANORAMA_LAYERS) {
      if (!states[l.id]?.active) continue;
      const temporal = isTemporalLayer(l.id);
      const isAggregatedPoint = AGGREGATED_POINT_IDS.has(l.id);
      const rep = ZOOM_REPRESENTATIONS[l.id];
      const band = zoomBands[l.id];
      // panorama-event-points Slice 1: near-zoom REAL sighting dots override the
      // aggregated mark for a points-capable layer ONCE its dedicated points
      // cache has resolved. Until then it falls back to the aggregated features
      // below, so the map never blanks while the points fetch is inflight.
      // P4b: the gate is the declared LOD band (near ∧ pointsCapable), not the
      // former global pointsEligible switch.
      const usesPoints = band === "near" && rep.pointsCapable && pointsDataRef.current.has(l.id);
      // Choropleth layers in province mode fill basemap polygons (province cache).
      // Aggregated point layers (F1 density+signal) in province mode also read the
      // province cache — the server returned province-grouped AggregatedPointCells.
      //
      // P4b GHOST FIX: the NATIONAL band also routes here. Scope-wins keeps
      // `level="locality"` at any zoom, so before P4b a scoped operator zooming
      // out past the layer's declared autoLevel.belowZoom kept painting hundreds
      // of locality marks over the national frame. The declaration now wins at
      // national zoom: paint the province-axis rollup (the cache-warm effect
      // below fetches it when missing).
      const usesProvinceCache =
        !usesPoints &&
        (CHOROPLETH_IDS.has(l.id) || isAggregatedPoint) &&
        (level === "province" || band === "national");
      // Order matters: a SCRUB on a temporal layer reads the as-of frame FIRST,
      // even at province framing — the as-of effect now fetches that frame at the
      // active level (province/locality), so it is the correct axis. Before this
      // reorder, `usesProvinceCache` short-circuited ahead of the scrub branch and
      // province-framed temporal layers always painted the LIVE province cache
      // (the scrubber moved, the bubbles never did).
      const features = usesPoints
        ? (pointsDataRef.current.get(l.id) ?? EMPTY_FC)
        : scrubbing && temporal
          ? (asOfDataRef.current.get(l.id) ?? EMPTY_FC)
          : usesProvinceCache
            ? (provinceDataRef.current.get(l.id) ?? EMPTY_FC)
            : (dataRef.current.get(l.id) ?? EMPTY_FC);

      // Resolve the point render mode:
      //   - points (perdidas real dots) → "points" (clustered pins, DetailDrawer)
      //   - density+signal → "graduated" (per-unit circles, no clustering)
      //   - reference (refugios/decomisos) → "reference" (discrete pins + clustering)
      //   - choropleth layers → renderMode omitted (handled by geomType path)
      const renderMode: PointRenderMode | undefined =
        l.geomType === "point"
          ? usesPoints
            ? "points"
            : isAggregatedPoint
              ? "graduated"
              : "reference"
          : undefined;

      out.push({
        id: l.id,
        color: l.color,
        label: l.label,
        // Claim #3 (cursor red-team 2026-07-23): threaded so the division-fill
        // count-fallback legend can use a count-truthful label — see
        // PanoramaLayer.countLabel's doc comment.
        countLabel: l.countLabel,
        geomType: l.geomType,
        renderMode,
        features,
        // Choropleth layers + aggregated point layers carry the axis their
        // FEATURES are on so the map labels popups honestly ("province" means
        // the feature represents a whole province). P4b: under the national-band
        // override the painted features ARE the province rollup even while the
        // scope-derived level is still "locality", so the axis follows the cache
        // routing, not `level`. Points-mode + reference layers omit it
        // (individual dots are not an aggregation unit).
        level:
          !usesPoints && (l.geomType === "choropleth" || isAggregatedPoint)
            ? usesProvinceCache
              ? "province"
              : "locality"
            : undefined,
        // Non-temporal layers can't be reproduced in time — mute them while scrubbing.
        dimmed: scrubbing && !temporal,
        // F5: thread data-type taxonomy + compliance target from the registry so
        // the map can choose divergent vs sequential choropleth rendering.
        dataType: l.dataType,
        complianceTarget: l.complianceTarget,
        // POLARITY (2026-07-26): a target-less layer whose HIGH value is the good
        // news (acceso-veterinario) must paint its sequential ramp BACKWARDS, or
        // the best-served jurisdictions get the alarm colour. Threaded from the
        // registry like the fields above; absent = higher is worse (every other layer).
        higherIsBetter: l.higherIsBetter,
        // new-vistas: delta-encoded layers (tendencia) render the zero-anchored
        // diverging classes — threaded from the registry like the fields above.
        deltaEncoded: l.deltaEncoded,
        // map-QOL: per-layer opacity multiplier from the Personalizar slider.
        opacity: opacities[l.id] ?? 1,
      });
    }
    return out;
    // asOfVersion + level + levelVersion + zoomBands/pointsVersion are
    // intentional triggers (the caches are refs). zoomBands has stable identity
    // per band signature, so a zoom settle that flips no band recomputes nothing.
  }, [states, scrubbing, asOfVersion, level, levelVersion, zoomBands, pointsVersion, opacities]);

  // C2 coherence disclosure — per ACTIVE layer, the LOD hint shown when the layer's
  // live zoom band resolved NATIONAL (it is painting the province/national rollup)
  // while the operator's scope is a drilled province/locality. Purely presentational:
  // the layer panel renders this note on the row, nothing here touches camera, scope,
  // or level (the ratified "scroll = camera, click = drill" contract is untouched).
  // "Drilled" = the console is scoped below the national overview: a locality axis, or
  // a province in scope. Reference layers (refugios/decomisos) are exempt in the pure
  // derivation. Keyed on the same (states, level, provinceInScope, zoomBands) inputs
  // the bands already depend on, so a zoom settle that flips no band recomputes nothing.
  const lodRollupHints = useMemo<Partial<Record<LayerId, string>>>(() => {
    const scopeIsDrilled = level === "locality" || provinceInScope;
    const out: Partial<Record<LayerId, string>> = {};
    for (const l of PANORAMA_LAYERS) {
      if (!states[l.id]?.active) continue;
      const hint = lodProvinceRollupHint({
        band: zoomBands[l.id],
        scopeIsDrilled,
        isReferenceLayer: l.dataType === "reference",
      });
      if (hint) out[l.id] = hint;
    }
    return out;
  }, [states, level, provinceInScope, zoomBands]);

  // panorama-event-points — resolve the REAL event-location dots for every ACTIVE
  // points-capable layer (perdidas / mordeduras / denuncias).
  //
  // Additive + orthogonal to the level/aggregation plumbing: this effect ONLY
  // populates the dedicated pointsDataRef + disclosure, it never touches the
  // aggregated caches. P4b: it runs when a layer's declared LOD band resolves
  // NEAR (zoom ≥ its nearAtZoom with a province in scope) — the former global
  // pointsMode gate, now read from the declaration. Keyed on the scope+period
  // subset AND the active near-band set so a province/period/toggle/zoom-band
  // change refetches. The SERVER is authoritative: it echoes `mode:"points"`
  // only when it actually returned dots; an aggregated/declined response clears
  // that layer's overlay (fall back to bubbles).
  const activePointsLayerIds = PANORAMA_LAYERS.filter(
    (l) =>
      ZOOM_REPRESENTATIONS[l.id].pointsCapable &&
      zoomBands[l.id] === "near" &&
      states[l.id]?.active,
  )
    .map((l) => l.id)
    .sort()
    .join(",");
  useEffect(() => {
    const activeIds = (activePointsLayerIds ? activePointsLayerIds.split(",") : []) as LayerId[];
    // Gate closed (no active layer in its near band) → clear every points
    // overlay + disclosure and fall back to bubbles.
    if (activeIds.length === 0) {
      if (pointsDataRef.current.size > 0) {
        pointsDataRef.current.clear();
        setPointsInfo({});
        setPointsVersion((v) => v + 1);
      }
      return;
    }
    // Drop cached points for any layer no longer active.
    for (const id of [...pointsDataRef.current.keys()]) {
      if (!activeIds.includes(id)) pointsDataRef.current.delete(id);
    }
    let cancelled = false;
    void Promise.all(
      activeIds.map(async (id) => {
        const params = new URLSearchParams(scopePeriodQs);
        params.set("mode", "points");
        try {
          dropCubeStamp();
          const r = await fetch(`/api/panorama/${id}?${params.toString()}`, {
            headers: { accept: "application/json" },
            signal: signalFor(`${id}:points`),
          });
          if (!r.ok) return null;
          const body = (await r.json()) as ApiResponse;
          if (cancelled) return null;
          // Honor only a genuine server-authorized points response.
          if (body.mode !== "points") {
            pointsDataRef.current.delete(id);
            return null;
          }
          pointsDataRef.current.set(id, body.features);
          return [
            id,
            {
              count: body.features.features.length,
              truncated: body.truncated,
              sinUbicacion: body.sinUbicacionCount ?? 0,
            },
          ] as const;
        } catch (err) {
          // Superseded fetch (keyed abort) — a newer points request will land.
          if (isAbortError(err)) return null;
          // Transient failure: leave the aggregated bubbles showing (no flash).
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, { count: number; truncated: boolean; sinUbicacion: number }> = {};
      for (const e of entries) if (e) next[e[0]] = e[1];
      setPointsInfo(next);
      setPointsVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [activePointsLayerIds, scopePeriodQs, signalFor, dropCubeStamp]);

  // Fetch a temporal layer's AS-OF features into the as-of cache (used when a
  // layer is toggled on mid-scrub, so it paints at the current instant, not live).
  const fetchAsOfFor = useCallback(
    async (id: LayerId, at: Date) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("asOf", at.toISOString());
      // task #77: honor the active replay basis (recorded_at when transaction).
      if (timeBasisRef.current === "transaction") params.set("basis", "transaction");
      try {
        // QA fix (finding 4): keyed abort — same `:asOf` key as the as-of
        // effect above, so a rapid re-toggle mid-scrub supersedes its own
        // prior in-flight request instead of racing it into asOfDataRef.
        dropCubeStamp();
        const res = await fetch(`/api/panorama/${id}?${params.toString()}`, {
          headers: { accept: "application/json" },
          signal: signalFor(`${id}:asOf`),
        });
        if (!res.ok) return;
        const body = (await res.json()) as ApiResponse;
        asOfDataRef.current.set(id, body.features);
        setAsOfVersion((v) => v + 1);
      } catch (err) {
        // Superseded fetch — the newer as-of request owns this layer now.
        if (isAbortError(err)) return;
        // Leave the live features showing on a transient failure (no flash).
      }
    },
    [searchParams, signalFor, dropCubeStamp],
  );

  // U5: fetch a choropleth layer at a given aggregation level into the right
  // cache (province → provinceDataRef; locality → dataRef). Returns the count so
  // the LayerPanel state can be refreshed. Threads the active scope/period qs.
  const fetchChoroplethAt = useCallback(
    async (id: LayerId, lvl: AggregationLevel, signalKey?: string): Promise<ApiResponse | null> => {
      const params = new URLSearchParams(searchParams.toString());
      if (lvl === "province") params.set("level", "province");
      applyVerifiedParam(params, id);
      try {
        // `signalKey` lets a caller (e.g. the boundary-prefetch warm fetch) use a
        // DISTINCT abort key so it never supersedes an active same-layer fetch.
        dropCubeStamp();
        const res = await fetch(`/api/panorama/${id}?${params.toString()}`, {
          headers: { accept: "application/json" },
          signal: signalFor(signalKey ?? id),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as ApiResponse;
        if (lvl === "province") {
          provinceDataRef.current.set(id, body.features);
          if (body.bivariateSignal) bivariateSignalRef.current.set(id, body.bivariateSignal);
        } else {
          dataRef.current.set(id, body.features);
        }
        return body;
      } catch (err) {
        // RETHROW aborts: `null` means "failed" to callers (they run the
        // failure branch, deactivating the layer) — a superseded fetch must
        // never look like a failure. Callers early-return on AbortError.
        if (isAbortError(err)) throw err;
        return null;
      }
    },
    [searchParams, signalFor, applyVerifiedParam, dropCubeStamp],
  );

  // P4b GHOST FIX (data side) — warm the province-axis cache for layers whose
  // LOD band resolved NATIONAL while the scope-derived level is still
  // "locality" (scope-wins at any zoom). The activeLayers memo routes their
  // read to provinceDataRef; without this warm fetch that cache is empty on the
  // first zoom-out (the level-flip effect never fires — level never changed)
  // and the national frame would paint blank instead of the honest rollup.
  // Keyed on the missing-set signature: cached bands repaint with zero fetches.
  const nationalBandMissing =
    level === "locality"
      ? PANORAMA_LAYERS.filter(
          (l) =>
            zoomBands[l.id] === "national" &&
            (CHOROPLETH_IDS.has(l.id) || AGGREGATED_POINT_IDS.has(l.id)) &&
            states[l.id]?.active &&
            !provinceDataRef.current.has(l.id),
        )
          .map((l) => l.id)
          .sort()
          .join(",")
      : "";
  useEffect(() => {
    if (!nationalBandMissing) return;
    const ids = nationalBandMissing.split(",") as LayerId[];
    void Promise.all(
      ids.map((id) =>
        // Distinct abort key: the warm fetch must never supersede an active
        // same-layer fetch (same idiom as the boundary prefetch).
        fetchChoroplethAt(id, "province", `${id}:national-band`).catch((err) => {
          if (isAbortError(err)) return null;
          // Transient failure — the band keeps painting EMPTY until the next
          // trigger; never deactivate the layer for a warm-cache miss.
          return null;
        }),
      ),
    ).then(() => setLevelVersion((v) => v + 1));
  }, [nationalBandMissing, fetchChoroplethAt]);

  // map-QOL: fetch a set of layers into the right caches at a given aggregation
  // level, updating each layer's panel state as it resolves. Used by the fluid
  // preset commit (onPreset) and the mount/board-restore effect — both mark the
  // layers active+loading BEFORE calling this. `baseParams` carries the target
  // scope/period (the client-only board params are stripped from the API URL).
  const fetchLayersInto = useCallback(
    async (
      ids: LayerId[],
      lvl: AggregationLevel,
      baseParams: URLSearchParams,
      opts?: { preserveOnError?: boolean; coalesce?: boolean },
    ) => {
      await Promise.all(
        ids.map(async (id) => {
          const params = new URLSearchParams(baseParams);
          params.delete("layers");
          params.delete("preset");
          params.delete("level");
          const levelSensitive = CHOROPLETH_IDS.has(id) || isAggregatedPointLayer(id);
          if (levelSensitive && lvl === "province") params.set("level", "province");
          else if (isAggregatedPointLayer(id)) params.set("level", "locality");
          applyVerifiedParam(params, id);
          try {
            dropCubeStamp();
            const qsStr = params.toString();
            const url = `/api/panorama/${id}${qsStr ? `?${qsStr}` : ""}`;
            const signal = signalFor(id);
            // Q10: on the INITIAL-load paths (opts.coalesce) dedupe identical
            // in-flight GETs — React StrictMode dev-remounts the console, and the
            // second instance's fresh abort registry cannot supersede the first's
            // in-flight cobertura/zoonosis fetch, so both hit the network. The
            // module-level URL map coalesces them. The preset-commit path does NOT
            // opt in: two DIFFERENT preset bursts requesting the same layer must
            // keep their per-request last-wins abort (a superseded burst's fetch is
            // observably aborted), which coalescing would collapse.
            const res = opts?.coalesce
              ? await coalescedGet(url, signal)
              : await fetch(url, { headers: { accept: "application/json" }, signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as ApiResponse;
            if (levelSensitive && lvl === "province") {
              provinceDataRef.current.set(id, body.features);
              if (body.bivariateSignal) bivariateSignalRef.current.set(id, body.bivariateSignal);
            } else {
              dataRef.current.set(id, body.features);
            }
            setStates((s) => {
              // A mid-flight deactivation outranks this resolution — the full
              // rationale lives with fetchLandingOverridden (helpers).
              const overridden = fetchLandingOverridden(s[id]);
              if (overridden) return { ...s, [id]: overridden };
              return {
                ...s,
                [id]: {
                  active: true,
                  loading: false,
                  count: body.features.features.length,
                  suppressedCount: body.suppressedCount,
                  noLocalityCount: body.noLocalityCount ?? 0,
                  truncated: body.truncated,
                  // Honesty: a budget-fallback empty is NOT "sin datos".
                  degraded: body.degraded === true,
                },
              };
            });
          } catch (err) {
            // Superseded fetch (keyed abort): the NEWER request owns this
            // layer's state — running the failure branch here would
            // deactivate the layer on every superseded fetch.
            if (isAbortError(err)) return;
            // REFRESH path (opts.preserveOnError, staging QA 2026-07-08 #2): the
            // layer is ALREADY active with last-known data — a failed REFETCH
            // must NOT deactivate it. Deactivating would shrink `activeLayersKey`,
            // and the URL-sync effect would then write `layers=` (empty) and lose
            // the operator's selection — exactly the "Actualizar drops the layers"
            // symptom under load. Keep it active, drop the loading flag, retain
            // the last-known count/envelope.
            if (opts?.preserveOnError) {
              // M2 (panorama honesty audit 2026-07-18): a failed REFRESH keeps the
              // last-known data + active state, but must SIGNAL the failure — mark
              // degraded so degradedLayerLabels reads "no pudimos calcular a
              // tiempo" instead of silently presenting stale numbers as fresh.
              setStates((s) => ({ ...s, [id]: { ...s[id], loading: false, degraded: true } }));
              return;
            }
            // Initial activation path: the layer had no data — leave it off and
            // clear loading; no silent half-state.
            setStates((s) => ({
              ...s,
              [id]: {
                active: false,
                loading: false,
                count: 0,
                suppressedCount: 0,
                truncated: false,
              },
            }));
          }
        }),
      );
      setLevelVersion((v) => v + 1);
    },
    [signalFor, applyVerifiedParam, dropCubeStamp],
  );

  // panorama QA root-cause #3b (Root B) — commit a PERÍODO change the SAME way
  // scope/layers/asOf already commit: a shallow History push + a client refetch,
  // superseding PeriodPanel's full `window.location.assign` reload (the last
  // control on the reload path — the "unify commit mechanism" follow-up the
  // ViewState design already named, viewstate-design §4.3 hazard #1). `nextPeriod`
  // is a preset id or "custom"; for "custom" the {from,to} window travels too.
  // useSearchParams() cannot observe the shallow write (Next 15.5.x router-drop,
  // engram #621/#622), so — exactly like applyPreset / resyncBoardFromUrl — this
  // records the committed window in state (committedPeriod/from/to drive the
  // scrubber axis + the PeriodPanel highlight) and imperatively refetches the KPIs
  // + active period-sensitive layers, instead of relying on the scopePeriodQs-keyed
  // effects (which the shallow write never triggers). Back/Forward stays coherent
  // via the popstate resync (resyncBoardFromUrl), which restores from/to too.
  // T2.7 — a preset switch overwrites the período with the vista's default by
  // CONTRACT (preserving an operator period across presets would change every
  // preset's meaning — deferred). What must not survive is the silence: when
  // the operator explicitly committed a different window this session, the
  // reset says so in one line. The ref tracks the explicit choice; the state
  // holds the es-AR label of the window the preset reset to (null = no notice).
  const operatorPeriodRef = useRef<string | null>(null);
  const [periodResetNotice, setPeriodResetNotice] = useState<string | null>(null);

  const commitPeriod = useCallback(
    (nextPeriod: string, from: string | null, to: string | null) => {
      // T2.7: an explicit operator commit — remember it, and clear any stale
      // reset notice (the operator owns the window again).
      operatorPeriodRef.current = nextPeriod;
      setPeriodResetNotice(null);
      const isCustom = nextPeriod === "custom" && from !== null && to !== null;
      // Build the shallow URL off the FRESHEST live URL (a scope drill may have
      // pushed ?province/?locality useSearchParams can't see). Camera params stay —
      // a period change keeps the same scope + frame (no re-frame, no reload).
      const params = new URLSearchParams(window.location.search);
      params.set("period", nextPeriod);
      if (isCustom) {
        params.set("from", from);
        params.set("to", to);
      } else {
        params.delete("from");
        params.delete("to");
      }
      const qsStr = params.toString();
      // Back-button undoable — an explicit operator action (push, not replace).
      pushMapStateUrl(`${window.location.pathname}${qsStr ? `?${qsStr}` : ""}`);

      // Record the committed window (the chrome truth useSearchParams can't see).
      setCommittedPeriod(nextPeriod);
      setCommittedFrom(isCustom ? from : null);
      setCommittedTo(isCustom ? to : null);

      // A new window invalidates the period-sensitive caches and parks the scrub at
      // live — the SAME invalidation set the scope/period effect + the popstate
      // resync use (as-of frames, province rollups, choropleth + aggregated-point
      // locality entries).
      asOfDataRef.current.clear();
      provinceDataRef.current.clear();
      bivariateSignalRef.current.clear();
      for (const id of CHOROPLETH_IDS) dataRef.current.delete(id);
      for (const l of AGGREGATED_POINT_LAYERS) dataRef.current.delete(l.id);
      setAsOf(null);
      setScrubResetToken((v) => v + 1);

      // KPIs key on scopePeriodQs (useSearchParams), which the shallow write does
      // NOT update — refetch them explicitly at the new window (the shared "kpis"
      // abort key dedupes against any concurrent refetch, last wins).
      clientKpiTookOverRef.current = true;
      const kpiQs = scopePeriodQsOf(params);
      fetch(`/api/panorama/kpis${kpiQs ? `?${kpiQs}` : ""}`, {
        headers: { accept: "application/json" },
        signal: signalFor("kpis"),
      })
        .then((r) => (r.ok ? (r.json() as Promise<PanoramaKpis>) : null))
        .then((body) => {
          if (body) {
            setKpis(body);
            setKpisStale(false);
          } else {
            setKpisStale(true);
          }
        })
        .catch((err) => {
          if (isAbortError(err)) return;
          console.error("[PanoramaConsole] period KPI refetch failed", err);
          setKpisStale(true);
        });

      // Refetch the ACTIVE period-sensitive layers at the new window. preserveOnError
      // keeps an already-active layer on its last-known data if the refetch fails
      // (never drops the operator's selection — the "Actualizar" degradation).
      const activePeriodSensitive = [...CHOROPLETH_LAYERS, ...AGGREGATED_POINT_LAYERS].filter(
        (l) => statesRef.current[l.id]?.active,
      );
      if (activePeriodSensitive.length === 0) return;
      setStates((s) => {
        const next = { ...s };
        for (const l of activePeriodSensitive) next[l.id] = { ...s[l.id], loading: true };
        return next;
      });
      void fetchLayersInto(
        activePeriodSensitive.map((l) => l.id),
        levelRef.current,
        params,
        { preserveOnError: true },
      );
    },
    [signalFor, fetchLayersInto, setKpis, setKpisStale, clientKpiTookOverRef],
  );

  // Switch the aggregation axis. Refetch the ACTIVE choropleth layers AND the
  // active density+signal point layers (F1 Panorama v2) at the new level if not
  // already cached, then repaint. Reference layers are not affected.
  // Cheap re-toggle: a cached level repaints instantly without a network round-trip.
  const onLevelChange = useCallback(
    (next: AggregationLevel) => {
      if (next === levelRef.current) return;
      setLevel(next);
      // A1 (2026-07-31) — sync the ref EAGERLY (the board restore already does).
      // `levelRef.current` is otherwise only assigned during RENDER, so effects
      // declared BELOW the scope-derived level effect read the OLD axis in the
      // SAME commit: the mount fetch then asked for the wrong grain and, sharing
      // the per-layer abort key, killed the right request — the whole country
      // painted "sin datos". Pinned by panorama-landing-level.test.ts.
      levelRef.current = next;

      // Layers affected by the axis change: choropleth + aggregated point layers.
      const affectedLayers = [...CHOROPLETH_LAYERS, ...AGGREGATED_POINT_LAYERS].filter(
        (l) => statesRef.current[l.id]?.active,
      );

      const needFetch = affectedLayers.filter((l) =>
        next === "province" ? !provinceDataRef.current.has(l.id) : !dataRef.current.has(l.id),
      );
      if (needFetch.length === 0) {
        // All cached — bump so the memo repaints at the new level.
        setLevelVersion((v) => v + 1);
        return;
      }
      // Mark the layers loading while their level features resolve.
      setStates((s) => {
        const out = { ...s };
        for (const l of needFetch) out[l.id] = { ...s[l.id], loading: true };
        return out;
      });
      Promise.all(
        needFetch.map(async (l) => {
          let body: ApiResponse | null;
          try {
            body = await fetchChoroplethAt(l.id, next);
          } catch (err) {
            // Superseded fetch — the newer request owns this layer's state.
            if (isAbortError(err)) return;
            body = null;
          }
          // RA-7 F4: a failed level change keeps its envelope and DECLARES
          // itself degraded — it never republishes zeros that read as "sin
          // datos". One rule, shared with the verified toggle below.
          setStates((s) => ({ ...s, [l.id]: { ...s[l.id], ...layerFetchPatch(body) } }));
        }),
      ).then(() => setLevelVersion((v) => v + 1));
    },
    [fetchChoroplethAt],
  );

  // task #78 Part 3: flip the "solo firmado por matrícula" toggle. ONLY the
  // cobertura layer is affected — the vet-signed numerator differs from the
  // all-doses one, so every cached cobertura feature set is stale. Drop them and
  // refetch the active cobertura at the current level with the new definition.
  // The URL-sync effect encodes ?verified into the board; the KPI strip is NOT
  // refetched (its cobertura tile already shows BOTH total and firmado numbers).
  const onToggleVerified = useCallback(() => {
    const next = !verifiedRef.current;
    verifiedRef.current = next;
    setVerifiedOnly(next);

    dataRef.current.delete("cobertura");
    provinceDataRef.current.delete("cobertura");
    asOfDataRef.current.delete("cobertura");

    if (!statesRef.current.cobertura?.active) return;

    const lvl = levelRef.current;
    setStates((s) => ({ ...s, cobertura: { ...s.cobertura, loading: true } }));
    void (async () => {
      let body: ApiResponse | null;
      try {
        body = await fetchChoroplethAt("cobertura", lvl);
      } catch (err) {
        // Superseded fetch — the newer request owns the layer state now.
        if (isAbortError(err)) return;
        body = null;
      }
      // RA-7 F4 — same defect, same rule as onLevelChange. This path DELETED the
      // cobertura caches before fetching, so a failure empties the canvas
      // outright; publishing `degraded: false` beside it made that emptiness
      // read as "sin datos".
      setStates((s) => ({ ...s, cobertura: { ...s.cobertura, ...layerFetchPatch(body) } }));
      setLevelVersion((v) => v + 1);
    })();
  }, [fetchChoroplethAt]);

  /**
   * F2: Recompute compatibility hints for all INACTIVE layers given the
   * provided `activeIds` set. Returns a partial state patch so the caller can
   * merge it in a single `setStates` call.
   *
   * Inactive layers that are blocked get a `compatibilityHint`; those that
   * are no longer blocked have their hint cleared (set to undefined).
   * Active layers are never patched here — a hint on an active layer makes
   * no sense and would be confusing.
   */
  const computeHints = useCallback(
    (activeIds: LayerId[]): Partial<Record<LayerId, Partial<LayerPanelState>>> => {
      const patch: Partial<Record<LayerId, Partial<LayerPanelState>>> = {};
      for (const layer of PANORAMA_LAYERS) {
        if (activeIds.includes(layer.id)) continue; // active — skip
        const result = checkCompatibility(activeIds, layer.id, PANORAMA_LAYERS);
        patch[layer.id] = { compatibilityHint: result.allowed ? undefined : result.hint };
      }
      return patch;
    },
    [],
  );

  const onToggle = useCallback(
    async (id: LayerId) => {
      // A manual toggle only edits the LAYERS. The active preset is DERIVED from
      // the resulting layer set (task #66 / WS-4) — no imperative discard. The
      // vista badge re-derives on its own: to "personalizada" (null) when the new
      // set matches no preset, or honestly to ANOTHER preset when it lands on one.
      // Read the LIVE active flag from the ref, not the closure `states`: a rapid
      // burst of unrelated re-renders (e.g. the coherence-hybrid KPI refetch firing
      // on an asOf scrub) can leave this async callback bound to a stale `states`
      // snapshot, so a closure read could misclassify an active layer as inactive
      // and re-activate it instead of turning it off (cowork QA H1 regression).
      const wasActive = statesRef.current[id]?.active ?? false;
      if (wasActive) {
        // Turn off — keep cached data so a re-toggle is instant.
        // Recompute hints: removing this layer may unblock others.
        setStates((s) => {
          const nextActiveIds = PANORAMA_LAYERS.filter(
            (l) => l.id !== id && (s[l.id]?.active ?? false),
          ).map((l) => l.id);
          const hints = computeHints(nextActiveIds);
          const next = { ...s, [id]: { ...s[id], active: false, compatibilityHint: undefined } };
          for (const [lid, patch] of Object.entries(hints) as [
            LayerId,
            Partial<LayerPanelState>,
          ][]) {
            next[lid] = { ...next[lid], ...patch };
          }
          return next;
        });
        return;
      }

      // F2: check compatibility BEFORE activating the layer.
      const activeIds = PANORAMA_LAYERS.filter((l) => states[l.id]?.active ?? false).map(
        (l) => l.id,
      );
      // map-QOL: BASE layers are radio-exclusive. Activating a base while
      // another base is on SWAPS it (deactivates the current base in the same
      // update) instead of blocking with a hint — the slot rule stays enforced
      // by checkCompatibility below, run against the post-swap active set.
      const proposedLayer = getLayer(id);
      const swapOutIds =
        proposedLayer && roleOf(proposedLayer) === "base"
          ? activeIds.filter((aid) => {
              const al = getLayer(aid);
              return al !== undefined && roleOf(al) === "base";
            })
          : [];
      const remainingActiveIds = activeIds.filter((aid) => !swapOutIds.includes(aid));
      // Applies the base-swap to a state object: swapped-out layers go inactive.
      const withSwapOut = (s: Record<LayerId, LayerPanelState>) => {
        if (swapOutIds.length === 0) return s;
        const next = { ...s };
        for (const out of swapOutIds) {
          next[out] = { ...next[out], active: false, compatibilityHint: undefined };
        }
        return next;
      };
      // M7 (review 2026-08-22): "solo firmado por matrícula" narrows ONLY the
      // cobertura numerator, and its checkbox leaves the screen with the layer —
      // but the flag itself was sticky and stayed in the URL, so a shared link
      // and a printed "Informe de situación" declared a filter no number in them
      // respected. Swapping the base away from a layer that honours it to one
      // that does not clears the flag with the checkbox.
      if (
        verifiedRef.current &&
        verifiedOnlyIsHonored(swapOutIds) &&
        !verifiedOnlyIsHonored([id])
      ) {
        verifiedRef.current = false;
        setVerifiedOnly(false);
      }
      const compat = checkCompatibility(remainingActiveIds, id, PANORAMA_LAYERS);
      if (!compat.allowed) {
        // Block the toggle — set the hint on this layer so the panel can explain why.
        setStates((s) => ({
          ...s,
          [id]: { ...s[id], compatibilityHint: compat.hint },
        }));
        return;
      }

      // F2 hint recomputation moved to helpers (applyHintsAfterActivate) —
      // pure over (states, nextActiveIds, id, computeHints).

      // Choropleth or aggregated-point layer toggled on while the axis is
      // "Provincia": resolve at province level, reading/writing the province cache.
      // Locality mode falls through to the standard fetch path below.
      const useProvinceCache =
        (CHOROPLETH_IDS.has(id) || isAggregatedPointLayer(id)) && levelRef.current === "province";
      if (useProvinceCache) {
        if (provinceDataRef.current.has(id)) {
          const fc = provinceDataRef.current.get(id) ?? EMPTY_FC;
          setStates((s) => {
            const nextActive = remainingActiveIds.concat(id);
            const base = {
              ...withSwapOut(s),
              [id]: { ...s[id], active: true, loading: false, count: fc.features.length },
            };
            return applyHintsAfterActivate(base, nextActive, id, computeHints);
          });
          setLevelVersion((v) => v + 1);
          return;
        }
        setStates((s) => ({ ...s, [id]: { ...s[id], active: true, loading: true } }));
        let body: ApiResponse | null;
        try {
          body = await fetchChoroplethAt(id, "province");
        } catch (err) {
          // Superseded fetch — the newer request owns this layer's state:
          // never run the failure branch (it would deactivate the layer).
          if (isAbortError(err)) return;
          body = null;
        }
        setStates((s) => {
          const overridden = fetchLandingOverridden(s[id]);
          if (overridden) return { ...s, [id]: overridden };
          const nextActive = remainingActiveIds.concat(id);
          const layerState: LayerPanelState = body
            ? {
                active: true,
                loading: false,
                count: body.features.features.length,
                suppressedCount: body.suppressedCount,
                noLocalityCount: body.noLocalityCount ?? 0,
                truncated: body.truncated,
                degraded: body.degraded === true,
              }
            : { active: false, loading: false, count: 0, suppressedCount: 0, truncated: false };
          // The swap only lands when the activation succeeded — a failed fetch
          // leaves the current base on instead of clearing both.
          const base = { ...(body ? withSwapOut(s) : s), [id]: layerState };
          return applyHintsAfterActivate(base, body ? nextActive : activeIds, id, computeHints);
        });
        setLevelVersion((v) => v + 1);
        return;
      }

      // If we already have data cached (e.g. the default layer), just re-activate.
      if (dataRef.current.has(id)) {
        const fc = dataRef.current.get(id) ?? EMPTY_FC;
        setStates((s) => {
          const nextActive = remainingActiveIds.concat(id);
          const base = {
            ...withSwapOut(s),
            [id]: { ...s[id], active: true, loading: false, count: fc.features.length },
          };
          return applyHintsAfterActivate(base, nextActive, id, computeHints);
        });
        // Mid-scrub: also resolve this temporal layer's as-of view if missing.
        if (asOf !== null && isTemporalLayer(id) && !asOfDataRef.current.has(id)) {
          void fetchAsOfFor(id, asOf);
        }
        return;
      }

      // Fetch the layer, threading the active scope/period searchParams so the
      // server scopes it identically to the page-load render. For aggregated
      // point layers (density+signal), also pass the current level so the server
      // groups at the right granularity (province or locality).
      setStates((s) => ({ ...s, [id]: { ...s[id], active: true, loading: true } }));
      try {
        const params = new URLSearchParams(searchParams.toString());
        if (isAggregatedPointLayer(id)) params.set("level", levelRef.current);
        applyVerifiedParam(params, id);
        const qs = params.toString();
        dropCubeStamp();
        const res = await fetch(`/api/panorama/${id}${qs ? `?${qs}` : ""}`, {
          headers: { accept: "application/json" },
          signal: signalFor(id),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ApiResponse;
        dataRef.current.set(id, body.features);
        setStates((s) => {
          const overridden = fetchLandingOverridden(s[id]);
          if (overridden) return { ...s, [id]: overridden };
          const nextActive = remainingActiveIds.concat(id);
          const base = {
            ...withSwapOut(s),
            [id]: {
              active: true,
              loading: false,
              count: body.features.features.length,
              suppressedCount: body.suppressedCount,
              noLocalityCount: body.noLocalityCount ?? 0,
              truncated: body.truncated,
              degraded: body.degraded === true,
            },
          };
          return applyHintsAfterActivate(base, nextActive, id, computeHints);
        });
        // Mid-scrub: also resolve this temporal layer's as-of view.
        if (asOf !== null && isTemporalLayer(id)) {
          void fetchAsOfFor(id, asOf);
        }
      } catch (err) {
        // Superseded fetch — the newer request owns this layer's state now.
        if (isAbortError(err)) return;
        // On failure, leave the layer off and clear loading; no silent half-state.
        dataRef.current.delete(id);
        setStates((s) => ({
          ...s,
          [id]: { active: false, loading: false, count: 0, suppressedCount: 0, truncated: false },
        }));
      }
    },
    [
      searchParams,
      states,
      asOf,
      fetchAsOfFor,
      fetchChoroplethAt,
      computeHints,
      signalFor,
      applyVerifiedParam,
      dropCubeStamp,
    ],
  );

  // task #66 / WS-4: the active preset is DERIVED, not stored. It is a pure
  // projection of the current view — the preset (if any) whose LAYER SET +
  // encoding match what is on screen (see domain/derive-preset.ts). Storing it
  // is what let the vista badge diverge from the map: pressing a KPI chip used to
  // imperatively `setActivePresetId(null)` and jump the vista. Now the badge
  // FOLLOWS the layers truthfully — edit a layer and the preset re-derives (to
  // another preset if the config lands on one, else "personalizada"/null).
  //   - period / scope / asOf are orthogonal modifiers that stay ON a preset,
  //     so they are (correctly) NOT part of the match.
  //   - encoding (P5): the operator's selection is threaded — a preset-DECLARED
  //     encoding (brotes-activos owns "bivariate") keeps the badge on the preset;
  //     an encoding forced onto a set no preset owns derives "personalizada".
  //     The SELECTION (bivariateMode) is passed, not the active state: a scrub
  //     suspends the encoding without flipping the vista name.
  //   - First paint: the server seeds exactly `presetLayerIds(seededPresetId)`
  //     (app/*/panorama/page.tsx), so the derived value is `seededPresetId` on
  //     the very first render — the preset row + metrics column read active with
  //     no imperative init. A shared `?preset=` board reproduces because its
  //     `?layers=` (written alongside `?preset=`) derives back to that preset.
  const activePresetId = useMemo<PresetId | null>(
    () =>
      derivePreset(
        PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
        bivariateMode ? "bivariate" : null,
        PANORAMA_PRESETS,
      ),
    [states, bivariateMode],
  );
  // Ref mirror so the popstate board re-derivation can compare against the CURRENT
  // preset without re-running on every preset change (MAP-2).
  const activePresetIdRef = useRef(activePresetId);
  activePresetIdRef.current = activePresetId;

  // The active vista's metric projection (D1 metric option, curated metric
  // ids, reading/informe KPI subset) — use-vista-metric-projection.ts
  // (file-size split, behavior-preserving).
  const {
    activePreset,
    activeMetricOption,
    metricIds,
    activeLayerIdList,
    readingKpis,
    presetRelevantLayerIds,
  } = useVistaMetricProjection({ activePresetId, states, activeLayers, kpis });

  // #53 QOL — the honest "personalizada" moment. When the derived vista flips
  // from a named preset to null (a hand-edit via Personalizar / a chip-less
  // layer toggle), the board changed SILENTLY before; now an inline note says
  // so and offers a one-tap return to the vista it left. Only fires on the
  // TRANSITION (a personalizada board restored from a URL shows no note), and
  // clears itself the moment any preset re-derives. Dismissible.
  const prevPresetRef = useRef<PresetId | null>(null);
  // Review F2 (2026-08-15): the metric option left behind rides along — a bare
  // preset id would repaint cumplimiento's DEFAULT metric on "Volver a", the
  // exact silent-metric-loss D1's aliases exist to prevent, on an internal path.
  const prevMetricRef = useRef<ComplianceMetricId | null>(null);
  const [personalizadaFrom, setPersonalizadaFrom] = useState<PresetId | null>(null);
  const [personalizadaMetric, setPersonalizadaMetric] = useState<ComplianceMetricId | null>(null);
  // T1.6 — the honest "restored" moment (same visual pattern as personalizada):
  // a genuinely bare URL restored the saved board from localStorage, silently
  // rewriting the URL. One terse dismissible line says so.
  const [restoredBoardNotice, setRestoredBoardNotice] = useState(false);
  useEffect(() => {
    if (activePresetId !== null) {
      prevPresetRef.current = activePresetId;
      prevMetricRef.current = activeMetricOption?.metric ?? null;
      setPersonalizadaFrom(null);
      return;
    }
    if (prevPresetRef.current !== null) {
      setPersonalizadaFrom(prevPresetRef.current);
      setPersonalizadaMetric(prevMetricRef.current);
    }
  }, [activePresetId, activeMetricOption]);

  // task #63: the bivariate "riesgo-brotes" encoding is OFFERED only for the
  // "Señales de brote" preset at province framing with both inputs active — the
  // gate for the toggle UI + the caption override under the map.
  // P2: eligibility now reads the shared REGISTRY predicate (the same one
  // capabilitiesFor exposes as `allowedControls.bivariateEligible`) — NO preset
  // id string. It is satisfied by a rate-with-target base (the coverage axis)
  // crossed with an active signal (the outbreak axis) at province framing; the
  // "Señales de brote" preset SATISFIES it (cobertura × zoonosis) without being named.
  const bivariateEligible = bivariateEligibleFor(
    PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
    level,
  );
  // new-vistas wave: WHICH declared pair the active set matches (null unless
  // exactly a pair). The join, the degenerate check, the map label, the legend
  // axes, and the popup rows all read THIS — no axis id is hardcoded anymore.
  // Constant identities (BIVARIATE_PAIRS), so memo deps stay cheap.
  const bivariatePair = bivariatePairFor(
    PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
  );
  // The bivariate join reads the LIVE province cache for both axes. cobertura is
  // non-temporal (it can't be replayed), so during a scrub it stays frozen at the
  // live edge while zoonosis has an as-of frame — mixing two time bases into one
  // cell would be dishonest. So the encoding is offered ONLY at the live edge; a
  // scrub disables it (with an honest note by the toggle). CRITICAL-2 fix.
  // task #63 / WARNING 7: with a tiny scope (1–3 comparable units) the tercile
  // cut-points degenerate and a 95%-coverage lone province would still be labelled
  // "baja cobertura / riesgo medio". Detect that from the LIVE province caches and
  // disable the encoding (with an honest note by the toggle) instead of emitting a
  // false risk band. levelVersion/asOfVersion are the recompute triggers (refs).
  // Item 2: the encoding can be refused for TWO distinct reasons (too few
  // comparable units vs. a degenerate/flat distribution). Carry the REASON so the
  // toggle can explain WHICH one applies instead of the old one-size note. `null`
  // → viable; "count"/"tercile" → refused (see bivariateRefusalReason).
  const bivariateDegenerateReason = useMemo<"count" | "tercile" | "suppressed" | null>(() => {
    void levelVersion;
    void asOfVersion;
    if (!bivariateEligible || !bivariatePair) return null;
    const cov = provinceDataRef.current.get(bivariatePair.coverage);
    // task panorama-bivariate-2026-07-21: prefer the province-grain bivariate
    // fallback (currently only zoonosis populates it) over the standalone
    // province cache, which for zoonosis carries PO 2026-07-16 department-grain
    // cells — near-empty at national scope, refusing on "count" almost always.
    // Falls back to provinceDataRef for a signal that isn't national-department
    // grain (e.g. mordeduras in the ppp×mordeduras pair), unaffected either way.
    const sig =
      bivariateSignalRef.current.get(bivariatePair.signal) ??
      provinceDataRef.current.get(bivariatePair.signal);
    if (!cov || !sig || cov.features.length === 0) return null;
    return bivariateRefusalReason(cov, sig, BIVARIATE_MIN_UNITS);
  }, [bivariateEligible, bivariatePair, levelVersion, asOfVersion]);
  const bivariateDegenerate = bivariateDegenerateReason !== null;
  const bivariateActive = bivariateMode && bivariateEligible && !scrubbing && !bivariateDegenerate;

  // Reset the encoding toggle when its eligibility drops (preset/level/layer
  // change) — otherwise bivariateMode stays "on" invisibly and silently re-engages
  // the moment eligibility returns, surprising the operator. The toggle only
  // exists while eligible, so this keeps its state honest to what's on screen.
  useEffect(() => {
    if (!bivariateEligible && bivariateMode) setBivariateMode(false);
  }, [bivariateEligible, bivariateMode]);

  // panorama-percapita: the per-cápita eligibility splits in TWO on purpose.
  //  - LAYER-SET eligibility (percapitaLayersEligible): every aggregating active
  //    layer is a per-cápita-eligible count layer. Losing THIS resets the mode
  //    (the bivariate reset rule — a foreign layer set must not re-engage later).
  //  - LEVEL eligibility (percapitaEligible): province grain only, v1 has no
  //    department denominator. Losing ONLY the level (a drill) KEEPS the mode and
  //    falls back to counts with an EXPLICIT note by the switcher — the
  //    PO-ratified visible-roadmap pattern, never a silent swap.
  const percapitaLayersEligible = percapitaEligibleFor(
    PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
    "province",
  );
  const percapitaEligible = percapitaLayersEligible && level === "province";
  // Census metadata read from the ACTIVE eligible layer's enriched features
  // (get-layer-features carries population/per10k/censusYear/censusSource on the
  // province props). Null while eligible = the payload has no census (stale
  // cache within its TTL, or an unseeded census table) → honest fallback note.
  const percapitaCensusMeta = useMemo(() => {
    if (!percapitaEligible) return null;
    for (const l of activeLayers) {
      if (!isPercapitaEligible(l.id as LayerId)) continue;
      const meta = censusMetaOf(l.features);
      if (meta) return meta;
    }
    return null;
  }, [percapitaEligible, activeLayers]);
  const percapitaActive = percapitaMode && percapitaEligible && percapitaCensusMeta !== null;

  useEffect(() => {
    if (!percapitaLayersEligible && percapitaMode) setPercapitaMode(false);
  }, [percapitaLayersEligible, percapitaMode]);

  // Scale-lock honesty (WARNING 6): opening via a shared ?asOf link mounts the map
  // mid-scrub, so the color/size scale locks to THAT day's domain — it never saw
  // the live edge to anchor against. Disclose that anchor until the operator
  // visits the live edge once (returning to live refreshes the lock correctly).
  // SSR-safe init (false); a mount-once effect sets it true for a deep-linked ?asOf
  // (post-hydration, matching the asOf restore above), then it clears on live.
  const [scaleAnchoredToAsOf, setScaleAnchoredToAsOf] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once; initialAsOf is a stable per-load value.
  useEffect(() => {
    if (initialAsOf !== null) setScaleAnchoredToAsOf(true);
  }, []);
  useEffect(() => {
    if (asOf === null) setScaleAnchoredToAsOf(false);
  }, [asOf]);

  // task #63: the layer list actually painted by the map. When the bivariate
  // encoding is active, REPLACE the two stacked layers visually — drop the
  // zoonosis bubbles and repaint the cobertura province fill as the 3×3 matrix,
  // computed client-side from the two ALREADY-fetched province results (reuse,
  // no refetch). Otherwise it is `activeLayers` unchanged.
  const mapLayers = useMemo<ActiveLayer[]>(() => {
    // levelVersion/asOfVersion are the explicit recompute triggers for the
    // province caches (refs), mirroring the activeLayers memo's `void` idiom.
    void levelVersion;
    void asOfVersion;
    // panorama-percapita: project the eligible count layers into their per-10k
    // encoding — a PURE client swap over the already-enriched features (zero
    // refetch on toggle, so no new fetch dispatch and no cube-stamp concern).
    // The label gains the unit, so every surface that names the layer (legend,
    // popup readout, table header) switches units together with the marks.
    // Mutually exclusive with bivariate by construction (disjoint eligible sets).
    if (percapitaActive) {
      return activeLayers.map((l) =>
        isPercapitaEligible(l.id as LayerId) && l.level === "province"
          ? {
              ...l,
              label: percapitaLayerLabel(l.label),
              features: projectPerCapita(l.features),
              perCapita: true,
            }
          : l,
      );
    }
    if (!bivariateActive || !bivariatePair) return activeLayers;
    const cov = provinceDataRef.current.get(bivariatePair.coverage);
    // Mirrors the eligibility memo above — same province-grain fallback preference.
    const sig =
      bivariateSignalRef.current.get(bivariatePair.signal) ??
      provinceDataRef.current.get(bivariatePair.signal);
    if (!cov || !sig || cov.features.length === 0) return activeLayers;
    const cells = buildBivariateCells(cov, sig);
    return activeLayers
      .filter((l) => l.id !== bivariatePair.signal)
      .map((l) =>
        l.id === bivariatePair.coverage
          ? { ...l, label: bivariatePair.mapLabel, bivariateCells: cells, bivariatePair }
          : l,
      );
    // levelVersion/asOfVersion bump when the province caches (refs) change.
  }, [activeLayers, bivariateActive, bivariatePair, percapitaActive, levelVersion, asOfVersion]);

  // H12 (cowork QA): on a direct-URL entry the map paints its bubbles 2-4s late,
  // so the operator stares at a blank canvas wondering if it is empty or broken.
  // Show a loading skeleton over the map WHILE an active layer is still fetching
  // AND nothing is painted yet. It clears the instant features arrive; if the
  // fetch resolves to a legitimately empty scope the skeleton clears too and the
  // honest empty-state takes over (we gate on `loading`, never on emptiness).
  const mapIsPainting = useMemo(
    () => mapLayers.some((l) => l.features.features.length > 0),
    [mapLayers],
  );
  const mapDataLoading = activeLayers.some((l) => states[l.id as LayerId]?.loading);
  const showMapSkeleton = !mapIsPainting && mapDataLoading;

  // task #65: the signal histogram bins for the TimeScrubber. Built ONLY from
  // per-event timestamps ALREADY on the client — the real-event dots (points mode)
  // carry `occurredAt`/`lastSeenAt`; the aggregated overview features carry only a
  // count, so this stays null there (honest: no fabricated distribution). The bins
  // are SCOPE-AGGREGATE totals, never per-unit, so they reveal no suppressed cell.
  // The raw per-event timestamps of the active temporal layers that ALREADY
  // reached the client (real-event dots in points mode). Aggregated overview
  // features carry only a count, so this is undefined there (honest: no
  // fabricated distribution). ONE source feeds BOTH the scrubber histogram and
  // the calendar heatmap, so the two views can never diverge (viz-suite W1 #8).
  const signalTimestamps = useMemo<number[] | undefined>(() => {
    const times: number[] = [];
    for (const l of activeLayers) {
      if (!isTemporalLayer(l.id as LayerId)) continue;
      for (const f of l.features.features) {
        const p = f.properties as { occurredAt?: unknown; lastSeenAt?: unknown };
        const raw =
          typeof p.occurredAt === "string"
            ? p.occurredAt
            : typeof p.lastSeenAt === "string"
              ? p.lastSeenAt
              : null;
        if (raw === null) continue;
        const v = Date.parse(raw);
        if (Number.isFinite(v)) times.push(v);
      }
    }
    return times.length === 0 ? undefined : times;
  }, [activeLayers]);

  // task #65: the 48-bucket scrubber track. Bins are SCOPE-AGGREGATE totals,
  // never per-unit, so they reveal no suppressed cell.
  const signalHistogramBins = useMemo<number[] | undefined>(
    () =>
      signalTimestamps === undefined
        ? undefined
        : binTimestamps(signalTimestamps, since.getTime(), until.getTime(), 48),
    [signalTimestamps, since, until],
  );

  // The calendar's per-DAY counts for the POINTS path — the same timestamps,
  // UTC-day-bucketed (matching the server's date_trunc) instead of binned.
  const pointsDailyCounts = useMemo(
    () =>
      signalTimestamps === undefined ? undefined : dailyCountsFromTimestamps(signalTimestamps),
    [signalTimestamps],
  );

  // NIGHT-3 item #3: at AGGREGATE level the temporal layers carry only a count
  // per unit — no per-event timestamps — so `signalHistogramBins` above is empty
  // and the scrubber histogram was blind. Fetch SCOPE-TOTAL per-day counts from
  // the layer endpoint (?histogram=1), sum across the active temporal layers, and
  // bin them into the same 48-bucket track. Runs ONLY when the client has no
  // timestamps (points mode already feeds the histogram above). The counts are
  // scope totals, never per-unit, so they reveal no k-anon-suppressed cell.
  const activeTemporalKey = useMemo(
    () =>
      activeLayers
        .filter((l) => isTemporalLayer(l.id as LayerId))
        .map((l) => l.id)
        .join(","),
    [activeLayers],
  );
  const [aggregateHistogramBins, setAggregateHistogramBins] = useState<number[] | undefined>(
    undefined,
  );
  // The calendar's per-DAY counts for the AGGREGATE path — the merged server
  // histogram BEFORE it is binned into the 48-bucket scrubber track. Lifted to
  // state so the CalendarHeatmap reuses THIS fetch (no duplicate request).
  const [aggregateDailyCounts, setAggregateDailyCounts] = useState<
    Array<{ date: string; count: number }> | undefined
  >(undefined);
  // The endpoint's DECLARED suppression flag (4c8fe3b1): empty track + flag is
  // "protegido", empty track alone is "no hubo eventos". See calendarEmptyMessage.
  const [aggregateHistogramSuppressed, setAggregateHistogramSuppressed] = useState(false);
  useEffect(() => {
    // M2: effectiveScopeProvince/Locality are recompute TRIGGERS — the effect reads
    // the drilled scope off window.location.search (fresher than useSearchParams),
    // so it must re-run when the effective scope changes. `void` marks them used
    // (the codebase idiom for trigger-only deps — cf. `void levelVersion`).
    void effectiveScopeProvince;
    void effectiveScopeLocality;
    // Points-mode timestamps already feed the histogram — don't double-count.
    // (The calendar's points path derives from those same timestamps too.)
    if (signalHistogramBins !== undefined || activeTemporalKey === "") {
      setAggregateHistogramBins(undefined);
      setAggregateDailyCounts(undefined);
      setAggregateHistogramSuppressed(false);
      return;
    }
    const ids = activeTemporalKey.split(",") as LayerId[];
    // M2 fix: read the LIVE URL, not the (stale) useSearchParams. A scope drill
    // commits ?province/?locality via a shallow History pushState that
    // useSearchParams does not observe (engram #621/#622) — so `searchParams`
    // still reads the national scope and the aggregate histogram showed NATIONAL
    // activity under a drilled province. window.location.search carries the
    // drilled scope; effectiveScopeProvince/Locality are the effect triggers.
    const baseQs = window.location.search;
    const currentLevel = level;
    let cancelled = false;
    Promise.all(
      ids.map(async (id) => {
        const params = new URLSearchParams(baseQs);
        // No asOf: the histogram shows the FULL-period activity distribution the
        // scrub cursor navigates within — it must not shrink as the operator
        // scrubs back. Strip any asOf the scrub wrote into the URL (baseQs).
        params.delete("asOf");
        params.set("histogram", "1");
        if (currentLevel === "province") params.set("level", "province");
        else if (isAggregatedPointLayer(id)) params.set("level", "locality");
        // Basis still matters (valid vs transaction time).
        if (timeBasis === "transaction") params.set("basis", "transaction");
        try {
          dropCubeStamp();
          const res = await fetch(`/api/panorama/${id}?${params.toString()}`, {
            headers: { accept: "application/json" },
            signal: signalFor(`${id}:histogram`),
          });
          if (!res.ok) return EMPTY_HISTOGRAM;
          const body = (await res.json()) as {
            histogram?: Array<{ date: string; count: number }>;
            suppressed?: boolean;
          };
          return { days: body.histogram ?? [], suppressed: body.suppressed === true };
        } catch (err) {
          if (isAbortError(err)) return null; // superseded — bail on merge
          return EMPTY_HISTOGRAM;
        }
      }),
    ).then((results) => {
      if (cancelled || results.some((r) => r === null)) return;
      // Sum per-day counts across all active temporal layers, then bin.
      const byDay = new Map<string, number>();
      for (const r of results) {
        for (const d of r?.days ?? []) byDay.set(d.date, (byDay.get(d.date) ?? 0) + d.count);
      }
      // ANY layer withholding its window protects the merged track; the other
      // layers' zeros do not disprove it.
      setAggregateHistogramSuppressed(results.some((r) => r?.suppressed === true));
      const merged = Array.from(byDay, ([date, count]) => ({ date, count }));
      const bins = binDailyCounts(merged, since.getTime(), until.getTime(), 48);
      setAggregateHistogramBins(bins.some((b) => b > 0) ? bins : undefined);
      // Same merged series feeds the calendar heatmap (per-day, not binned).
      setAggregateDailyCounts(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [
    signalHistogramBins,
    activeTemporalKey,
    effectiveScopeProvince,
    effectiveScopeLocality,
    level,
    timeBasis,
    dropCubeStamp,
    signalFor,
    since,
    until,
  ]);

  // política → resultado (2026-08-02): recent rule changes for the scrubber's
  // marker layer. Scope-DEPENDENT but period-independent-ish — markers outside
  // the active window are dropped client-side by the bucketer, so the fetch
  // keys on the effective scope only (one tiny audit-log read per scope
  // change, never per frame). The province/locality params are a FILTER
  // REQUEST only: the route intersects them with the actor's jurisdiction
  // server-side (G1 — /gob/panorama access control), national rules always
  // included. A failed fetch keeps the last markers (annotation, not truth).
  const [ruleChangeMarkers, setRuleChangeMarkers] = useState<RuleChangeMarkerDatum[]>([]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (effectiveScopeProvince) params.set("province", effectiveScopeProvince);
    if (effectiveScopeLocality) params.set("locality", effectiveScopeLocality);
    const qs = params.toString();
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/panorama/rule-changes${qs ? `?${qs}` : ""}`, {
          headers: { accept: "application/json" },
          signal: signalFor("rule-changes"),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { changes?: RuleChangeMarkerDatum[] };
        if (!cancelled) setRuleChangeMarkers(body.changes ?? []);
      } catch (err) {
        if (!isAbortError(err)) {
          console.error("[panorama] rule-changes fetch failed:", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveScopeProvince, effectiveScopeLocality, signalFor]);

  // panorama-redesign Fase 1: preset map framing (camera-only). Set on preset
  // activation from the preset's optional `framing` field; the token is a
  // monotonic counter so re-clicking the same preset re-frames (new object
  // identity re-fires the map's frame effect). null = no framing (framing-less
  // presets keep today's map behavior).
  const frameTokenRef = useRef(0);
  const [presetFrame, setPresetFrame] = useState<{
    framing: PresetFraming;
    token: number;
  } | null>(null);

  // panorama-redesign Fase 1: trailing debounce handle for the preset-commit
  // layer fetch (see onPreset). Cleared on unmount so a pending burst never
  // fires into an unmounted console.
  const presetFetchTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (presetFetchTimerRef.current !== null) {
        window.clearTimeout(presetFetchTimerRef.current);
      }
    },
    [],
  );

  /**
   * F3: Activate a preset — FLUID (map-QOL).
   *
   * Supersedes the interim router-drop cure from commit 0e94f198 (a full
   * `window.location.assign` navigation on period commit). The router-drop
   * defect only affects Next router transitions (`router.push/replace`); this
   * path never touches the router: the period/board commit is a shallow
   * History API pushState (lib/ui/map-layer-nav.ts) and the data refetch is a
   * plain client fetch — nothing for the router to drop, no reload, the map
   * stays mounted and the layers cross-fade in place.
   *
   * Ordering:
   * 1. Clear all caches + park the scrubber (a new period invalidates both).
   * 2. Set level + mark the preset's layers active (loading=true).
   * 3. Commit the board URL (period/layers/level/preset) via shallow History
   *    API; flag the new scope+period as handled so the invalidation effect
   *    skips. `commit` picks the primitive: "push" for an explicit operator
   *    click (back-button undoable); "replace" for the first-visit default
   *    activation below (the operator didn't navigate — no history entry).
   * 4. Fetch the preset's layers directly against the NEW params (no closure
   *    over stale searchParams) + persist the board for the bare-URL restore.
   */
  // Which of `ids` are NOT yet cached for `lvl` — the layers a preset activation
  // must actually fetch. Routes each id to the same cache activeLayers reads it
  // from (seededLayerUsesProvinceCache). With server-seeded caches (first-visit
  // fast path) this is normally EMPTY, so the preset commit fires zero fetches.
  const missingFromCache = useCallback((ids: LayerId[], lvl: AggregationLevel) => {
    return ids.filter((lid) => {
      const cache = seededLayerUsesProvinceCache(lid, lvl)
        ? provinceDataRef.current
        : dataRef.current;
      return !cache.has(lid);
    });
  }, []);

  const applyPreset = useCallback(
    (
      id: PresetId,
      commit: "push" | "replace",
      opts?: { preserveSeededCaches?: boolean; metric?: ComplianceMetricId },
    ) => {
      const preset = getPreset(id);
      if (!preset) return;
      // D1 metric selector: an explicit metric override substitutes the option's
      // BASE before the layer set / URL are built — the SAME commit path as a
      // plain preset click, never a parallel one. An unknown metric (or one on a
      // preset without options) falls back to the preset's default base.
      const metricOption =
        opts?.metric !== undefined
          ? (preset.metricOptions?.find((o) => o.metric === opts.metric) ?? null)
          : null;
      // perf plan 1.2: preserve mode keeps the SERVER-seeded caches (first-visit
      // fast path). The scrubber is already parked at live (asOf init null), so
      // the only work is fetching layers MISSING from the seed (normally none).
      const preserve = opts?.preserveSeededCaches === true;

      if (!preserve) {
        // Clear all caches — an explicit preset commit always starts fresh.
        dataRef.current.clear();
        provinceDataRef.current.clear();
        bivariateSignalRef.current.clear();
        asOfDataRef.current.clear();
        setAsOf(null);
      }

      // PO-ratified 2026-07-09: a preset no longer PINS the aggregation level —
      // `level: "locality"` is an initial preference realized by the server seed
      // + the live camera, not a force. Activating a preset keeps whatever level
      // the scope+zoom hysteresis currently dictates (`levelRef.current`), so a
      // preset chosen in national framing stays at province and only drills to
      // locality on an intentional zoom or a jurisdiction selection. The layers
      // are fetched at — and the URL reflects — that current level.
      const lvl = levelRef.current;

      const presetIds = metricOption
        ? presetLayerIdsWithBase(preset, metricOption.base)
        : presetLayerIds(preset);
      // preserve → only the layers missing from the seeded caches; else all.
      const toFetch = preserve ? missingFromCache(presetIds, lvl) : presetIds;
      const toFetchSet = new Set(toFetch);

      // Flip all layers: deactivate current ones; mark preset layers active+loading.
      // A seeded-and-preserved layer is marked active + NON-loading (its envelope
      // stays from the initializer) — flipping it to loading:true would spin
      // forever, since no fetch is issued to clear it.
      setStates((s) => {
        const next = { ...s };
        for (const l of PANORAMA_LAYERS) {
          if (presetIds.includes(l.id)) {
            if (preserve && !toFetchSet.has(l.id)) {
              next[l.id] = { ...s[l.id], active: true, loading: false };
            } else {
              next[l.id] = {
                active: true,
                loading: true,
                count: 0,
                suppressedCount: 0,
                truncated: false,
              };
            }
          } else if (s[l.id]?.active) {
            next[l.id] = { ...s[l.id], active: false, compatibilityHint: undefined };
          }
        }
        return next;
      });

      // The active preset is DERIVED (task #66 / WS-4): flipping the layer states
      // above to this preset's set makes `activePresetId` re-derive to `id` — no
      // imperative set. The `?preset=id` URL write below stays (SSR/deep-link
      // seed + saveBoard), and it now agrees with the derived value by construction.
      // W2 fix: this commit writes `period=<preset>` via a shallow History replace
      // that useSearchParams() can't see — record the committed period so the
      // scrubber axis + PeriodPicker highlight track the loaded window, not the
      // stale bare-URL default.
      setCommittedPeriod(preset.periodPreset);
      // T2.7: overwriting an EXPLICIT operator window must not be silent —
      // surface the one-line notice (the overwrite semantics are unchanged).
      if (operatorPeriodRef.current !== null && operatorPeriodRef.current !== preset.periodPreset) {
        // Exhaustive by type: widening the preset period union breaks this
        // Record instead of silently mislabeling the notice (review 2026-08-01).
        const resetLabels: Record<PanoramaPreset["periodPreset"], string> = {
          "30d": "30 días",
          "90d": "90 días",
        };
        setPeriodResetNotice(resetLabels[preset.periodPreset]);
      } else {
        setPeriodResetNotice(null);
      }
      operatorPeriodRef.current = null;

      // riesgo-ppp gap fix: the bivariateMode useState initializer only seeds
      // from the OPENING preset's `encodings` declaration once, at mount (via
      // `seededPresetId ?? defaultPresetId`) — an in-session preset click never
      // ran through it. So navigating to "Riesgo PPP" (or any vista that OWNS
      // `bivariate`) from another preset left bivariateMode at whatever it was
      // before, and the vista opened silently on the plain fill — its whole
      // point ("¿dónde se cruzan mordeduras altas con bajo registro PPP?")
      // hidden behind a toggle the operator has to find. Mirror the mount-time
      // seed here so every preset commit (not just the first) opens in the
      // encoding its vista declares. Symmetric in both directions: switching
      // to a preset that does NOT declare bivariate turns it back off, same as
      // the eligibility-reset effect already does when the axes drop out.
      setBivariateMode(preset.encodings?.includes("bivariate") === true);

      // panorama-redesign Fase 1: apply the preset's optional map framing
      // (camera-only — data scope untouched). Framing-less presets clear it.
      // BUG FIX (vista-switch camera yank): a preset's `national` framing is a
      // DEFAULT overview — it must NOT teleport an operator who has an active
      // scope (a drilled province/locality OR a jurisdiction-scoped session) out
      // to the whole country. When suppressed, CLEAR the frame so the camera
      // stays where the user is; the vista still switches its layers/metrics.
      const hasActiveScope =
        effectiveScopeProvinceRef.current != null ||
        effectiveScopeLocalityRef.current != null ||
        initialDivisionProvince != null ||
        initialDivisionLocality != null;
      if (preset.framing && shouldEmitPresetFrame(preset.framing, hasActiveScope)) {
        frameTokenRef.current += 1;
        setPresetFrame({ framing: preset.framing, token: frameTokenRef.current });
      } else {
        setPresetFrame(null);
      }

      // Commit the board URL shallowly (back-button undoable — an explicit
      // user action) and fetch the preset layers against the NEW params.
      // Read the LIVE URL (not stale useSearchParams): a scope drill commits
      // ?province/?locality via a shallow pushState useSearchParams can't see, so
      // window.location.search is the freshest scope — and it makes applyPreset
      // safe to reuse from the popstate re-derivation below (MAP-2).
      const nextParams = new URLSearchParams(window.location.search);
      nextParams.set("period", preset.periodPreset);
      nextParams.set("layers", canonicalLayersKey(presetIds));
      if (lvl === "locality") nextParams.set("level", "locality");
      else nextParams.delete("level");
      nextParams.set("preset", id);
      presetCommittedQsRef.current = scopePeriodQsOf(nextParams);
      // perf plan 1.2: on the first-visit fast path the SERVER already seeded the
      // KPIs at this preset's window — pre-arm seededQsRef with the committed
      // scope+period qs so this commit's URL change can't trigger a redundant
      // /api/panorama/kpis refetch (the KPI effect skips a matching qs). Only for
      // preserve mode; an explicit preset click still refetches KPIs at its period.
      if (preserve) seededQsRef.current = scopePeriodQsOf(nextParams);
      const nextUrl = `${window.location.pathname}?${nextParams.toString()}`;
      if (commit === "push") pushMapStateUrl(nextUrl);
      else replaceMapStateUrl(nextUrl);
      // panorama-vista-redesign Phase 5: stamp the LIVE capasDetail/scrubDetail
      // via the ref mirrors (applyPreset's identity should not churn on every
      // Simple/Detalle flip — matches the verifiedRef/levelRef pattern).
      saveBoard(nextParams, {
        capasDetail: capasDetailRef.current,
        scrubDetail: scrubDetailRef.current,
      });
      // perf plan 1.2: nothing to fetch (every preset layer was seeded) → the
      // commit is state + URL only, ZERO network. This is the whole win.
      if (toFetch.length === 0) return;
      // panorama-redesign Fase 1: TRAILING debounce on the layer-fetch burst
      // ONLY — the state flips + shallow URL push above stay synchronous
      // (instant feedback). Rapid preset clicks coalesce into one burst for
      // the LAST selection; in-flight fetches are superseded via keyed abort.
      if (presetFetchTimerRef.current !== null) {
        window.clearTimeout(presetFetchTimerRef.current);
      }
      presetFetchTimerRef.current = window.setTimeout(() => {
        presetFetchTimerRef.current = null;
        void fetchLayersInto(toFetch, lvl, nextParams);
      }, PRESET_FETCH_DEBOUNCE_MS);
    },
    [
      fetchLayersInto,
      missingFromCache,
      initialDivisionProvince,
      initialDivisionLocality,
      seededQsRef,
    ],
  );

  /** F3: explicit preset click — a back-button-undoable board commit. */
  const onPreset = useCallback((id: PresetId) => applyPreset(id, "push"), [applyPreset]);

  // MAP-2: re-derive the board from a popped URL. useSearchParams does not
  // observe popstate (engram #621/#622), so browser Back reverted
  // ?preset/?layers/?period in the URL while the active tab, legend, bubbles and
  // KPIs stayed on the previous preset. Assigned to a ref during render (the
  // popstate listener is declared above, before this closure's dependencies).
  //
  // Adversarial-review fix (2026-07-11, MED #1): this used to reuse the
  // click-path applyPreset(preset, "replace"), which FORCES the period back to
  // preset.periodPreset, clears every cache, and re-applies the preset's camera
  // framing. Repro: preset A → change period to 12m (URL keeps period=12m) →
  // preset B → Back: the popped URL still says period=12m but the view rewrote
  // it to A's default (and jumped the camera). A popped URL is a HISTORICAL
  // board — restore its fields (preset, layers, period) verbatim:
  //   - period: from ?period (committedPeriod), never the preset default;
  //   - layers: from ?layers, falling back to the preset's canonical set;
  //   - caches: kept (Back is instant) unless the period actually changed —
  //     a different window makes every period-sensitive cache stale;
  //   - framing: NEVER re-applied (no camera jump on Back);
  //   - URL: never rewritten (it is already the popped one).
  resyncBoardFromUrlRef.current = (params: URLSearchParams) => {
    const rawPreset = params.get("preset");
    // D1: a popped historical URL may carry a RETIRED preset id (a pre-merge
    // entry still in this session's history). resolveLegacyPreset normalizes
    // the id AND reconstructs the legacy layer set for the ?layers-less
    // fallback below — resolving only the id would repaint the merged
    // preset's default base (silent metric loss).
    const resolvedPopped = rawPreset !== null ? resolveLegacyPreset(rawPreset) : undefined;
    const poppedPreset = resolvedPopped?.preset.id ?? null;
    const poppedPeriod = params.get("period");
    const poppedFrom = params.get("from");
    const poppedTo = params.get("to");

    // Resolve the loaded vs popped period through the SAME fallback chain the
    // since/until memo uses, so "changed" means the WINDOW actually changes.
    const fallbackPeriod = searchParams.get("period") ?? PANORAMA_DEFAULT_PRESET;
    const loadedPeriod = committedPeriod ?? fallbackPeriod;
    const nextPeriod = poppedPeriod ?? fallbackPeriod;
    // Root B: two CUSTOM windows share period="custom" but differ by {from,to} —
    // fold them into the changed test so Back across custom ranges refetches, and
    // so a custom⇄preset pop (from/to appearing or clearing) is caught.
    const loadedFrom = committedFrom ?? searchParams.get("from");
    const loadedTo = committedTo ?? searchParams.get("to");
    const periodChanged =
      nextPeriod !== loadedPeriod || poppedFrom !== loadedFrom || poppedTo !== loadedTo;

    // Popped layer set: explicit ?layers wins; a preset URL without ?layers
    // falls back to the RESOLVED set (legacy alias base included); a bare
    // manual URL is all-off.
    const ids = parseLayersParam(params.get("layers")) ?? resolvedPopped?.layerIds ?? [];
    const idSet = new Set<LayerId>(ids);
    const currentKey = canonicalLayersKey(
      PANORAMA_LAYERS.filter((l) => statesRef.current[l.id]?.active).map((l) => l.id),
    );
    const layersChanged = canonicalLayersKey(ids) !== currentKey;

    // No change vs the current board — nothing to re-derive.
    if (poppedPreset === activePresetIdRef.current && !periodChanged && !layersChanged) return;

    // `activePresetId` is DERIVED (task #66 / WS-4): flipping the layer states to
    // the popped set (below) re-derives it to `poppedPreset` — a popped board
    // writes `?preset` and `?layers` together, so they agree by construction.
    // The popped URL's period is the truth (null → the bare-URL default). Restore
    // the custom {from,to} shadow too (null unless the popped window IS custom).
    setCommittedPeriod(poppedPeriod);
    setCommittedFrom(poppedPeriod === "custom" ? poppedFrom : null);
    setCommittedTo(poppedPeriod === "custom" ? poppedTo : null);

    if (periodChanged) {
      // The loaded caches belong to the previous window — stale for the popped
      // one. Same invalidation set as the scope/period effect: as-of frames,
      // province rollups, and the period-sensitive locality entries.
      asOfDataRef.current.clear();
      provinceDataRef.current.clear();
      bivariateSignalRef.current.clear();
      for (const id of CHOROPLETH_IDS) dataRef.current.delete(id);
      for (const l of AGGREGATED_POINT_LAYERS) dataRef.current.delete(l.id);
      setAsOf(null);
      setScrubResetToken((v) => v + 1);
      // If the searchParams-keyed invalidation effect DOES observe this pop
      // (dev/router-version variance), skip its redundant clear+refetch run.
      presetCommittedQsRef.current = scopePeriodQsOf(params);
      // KPIs are keyed on scopePeriodQs (useSearchParams), which popstate does
      // not update — refetch them explicitly at the popped window. The shared
      // "kpis" abort key dedupes against any concurrent refetch (last wins).
      clientKpiTookOverRef.current = true;
      const kpiQs = scopePeriodQsOf(params);
      fetch(`/api/panorama/kpis${kpiQs ? `?${kpiQs}` : ""}`, {
        headers: { accept: "application/json" },
        signal: signalFor("kpis"),
      })
        .then((r) => (r.ok ? (r.json() as Promise<PanoramaKpis>) : null))
        .then((body) => {
          if (body) {
            setKpis(body);
            setKpisStale(false);
          } else {
            setKpisStale(true);
          }
        })
        .catch((err) => {
          if (isAbortError(err)) return;
          console.error("[PanoramaConsole] popstate KPI refetch failed", err);
          setKpisStale(true);
        });
    }

    // Flip the layer states to the popped set. Layers that need a fetch (period
    // changed, or missing from cache) flip to loading; already-cached layers
    // activate in place (Back stays instant — no cache wipe, no spinner).
    const toFetch = periodChanged ? ids : missingFromCache(ids, levelRef.current);
    const toFetchSet = new Set(toFetch);
    setStates((s) => {
      const next = { ...s };
      for (const l of PANORAMA_LAYERS) {
        const shouldActive = idSet.has(l.id);
        const isActive = s[l.id]?.active ?? false;
        if (shouldActive && toFetchSet.has(l.id)) {
          next[l.id] = {
            active: true,
            loading: true,
            count: 0,
            suppressedCount: 0,
            truncated: false,
          };
        } else if (shouldActive && !isActive) {
          next[l.id] = { ...s[l.id], active: true, loading: false };
        } else if (!shouldActive && isActive) {
          next[l.id] = { ...s[l.id], active: false, compatibilityHint: undefined };
        }
      }
      return next;
    });
    if (toFetch.length > 0) void fetchLayersInto(toFetch, levelRef.current, params);
  };

  // P4c (design §5.5): the aggregation level derives from the SCOPE alone —
  // a jurisdiction drill (explicit ?province/?locality, or the implicit
  // single-province scope of a jurisdiction-scoped operator) is locality;
  // national scope is province at any zoom. The camera no longer flips the
  // data axis (the old Schmitt-trigger hysteresis is gone with the wheel
  // takeover); rendering granularity is the P4b LOD bands' job.
  //
  // PO-ratified 2026-07-09 (unchanged): a preset's `level: "locality"` is an
  // INITIAL PREFERENCE realized by the server seed, never a force.
  const derivedProvince = effectiveScopeProvince ?? initialDivisionProvince;
  // effectiveScopeLocality is already orphan-normalized at its source (Fork A,
  // above) — a locality only survives when a province exists somewhere, so this
  // inherits a coherent value. Fall back to the operator's implicit single-
  // locality scope (initialDivisionLocality) — mirroring derivedProvince — so a
  // jurisdiction-scoped govt operator opens on their own locality.
  const derivedLocality = effectiveScopeLocality ?? initialDivisionLocality;

  // task #50 P1b — the single canonical PanoramaViewState (read-model). The
  // console's scattered selection inputs are assembled here into ONE value; the
  // map/fetch scope filter derives from it via the pure domain converter
  // (toScopeFilter), and the analytic window via toPeriodSearchParams (above),
  // so no surface re-derives scope or period from a different state slice. The
  // camera + ephemeral lenses (basis/representation) stay at their defaults
  // here; the encoding selection IS threaded (P5 — it round-trips the URL).
  const viewState = useMemo<PanoramaViewState>(
    () =>
      makeViewState({
        scope: scopeFromFilter({
          country: "AR",
          province: derivedProvince,
          locality: derivedLocality,
        }),
        period: viewPeriod,
        asOf: asOf ? asOf.toISOString() : null,
        layers: PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
        verifiedOnly,
        preset: activePresetId,
        // P5: the encoding selection is part of the canonical value — it feeds
        // the gate, explainViewState, and the URL boundary (?encoding=).
        encoding: bivariateMode
          ? ("bivariate" as const)
          : percapitaMode
            ? ("percapita" as const)
            : null,
      }),
    [
      derivedProvince,
      derivedLocality,
      viewPeriod,
      asOf,
      states,
      verifiedOnly,
      activePresetId,
      bivariateMode,
      percapitaMode,
    ],
  );

  // P2: the declarative capability gate — the ONE pure function every surface
  // projects from (design §2). `level` is the situational-map-derived aggregation
  // level (hysteresis state lives in the React layer); the gate echoes it as the
  // single value. Consumers below read `capabilities.*` instead of re-deriving.
  const capabilities = useMemo<PanoramaCapabilities>(
    () => capabilitiesFor(viewState, { zoom: mapZoom, level }),
    [viewState, mapZoom, level],
  );

  // P5 gift: the honest one-line es-AR description of the WHOLE view — rendered
  // beside "Copiar vista" so the operator reads in words exactly what the link
  // they are about to share reproduces (explainViewState is the proof the
  // canonical value is complete: every visible coordinate is describable).
  const explainNames = useMemo(
    () => ({
      provinceLabel: (code: string) => provinceByCode(code)?.name,
      localityLabel: (_prov: string, loc: string) =>
        scopeData.localities.find((l) => l.slug === loc)?.name,
      // Finding #1: a bounded (govt) operator's data is scoped — name their real
      // jurisdiction instead of "todas las provincias"; an admin at department
      // grain gets the grain-qualified national phrase.
      boundedScopeLabel: boundedJurisdiction ? (scopeLabel ?? undefined) : undefined,
      renderLevel: level,
    }),
    [scopeData.localities, boundedJurisdiction, scopeLabel, level],
  );
  const viewExplanation = useMemo(
    () => explainViewState(viewState, explainNames),
    [viewState, explainNames],
  );
  // The trimmed on-screen sentence (screenViewExplanation) USED to render above
  // the KPI chips. Removed 2026-08-01 with the ContextBar, which states the
  // period and the layer count once. `viewExplanation` above still carries the
  // WHOLE sentence to the link/informe/embed, which are read alone.

  // A2 (automatic department-grain LOD): a committed province/locality still reads
  // the locality axis at any zoom. National scope defaults to the province axis but
  // now flips to the LOCALITY (department) axis once the camera zooms past
  // Z_DIVISIONS WITH an active choropleth — so departments fill automatically with
  // the active metric as the operator looks closer, in the same color language.
  // This reinstates the camera half of the derivation P4c removed for COST; the
  // cost is gone because national+department is cube-served (a precomputed
  // superset), so the refetch is near-free. RENDER-detail-on-zoom only: it drives a
  // data refetch + repaint, NEVER a camera move (the vista-camera fix is untouched).
  // A province-ONLY choropleth (indice-territorial) must NOT trigger the
  // zoom→department LOD flip: its loader ignores `level` and always paints
  // provinces, so flipping to "locality" would make the badge/caption claim
  // "Departamentos" over province polygons (Cursor review, label≠map). Only a
  // department-capable choropleth counts here.
  const hasActiveChoropleth = useMemo(
    () => [...CHOROPLETH_IDS].some((id) => states[id]?.active && !isProvinceOnlyChoropleth(id)),
    [states],
  );
  useEffect(() => {
    const f = toScopeFilter(viewState);
    const desired = resolveDataLevel({
      hasProvinceScope: f.province != null,
      hasLocalityScope: f.locality != null,
      zoom: mapZoom,
      hasActiveChoropleth,
    });
    if (desired !== levelRef.current) onLevelChange(desired);
  }, [viewState, onLevelChange, mapZoom, hasActiveChoropleth]);

  // map-QOL URL sync: mirror the board (active layers / level / preset) into
  // the URL via shallow replaceState whenever it changes — toggles are silent
  // normalizations (replace), presets push (see onPreset). Skips the first run
  // (the mount URL already reflects the initial board or intentionally lacks
  // one). Also persists the board for the bare-URL restore.
  const activeLayersKey = useMemo(
    () =>
      PANORAMA_LAYERS.filter((l) => states[l.id]?.active)
        .map((l) => l.id)
        .join(","),
    [states],
  );
  const urlSyncReadyRef = useRef(false);
  useEffect(() => {
    if (!urlSyncReadyRef.current) {
      urlSyncReadyRef.current = true;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const before = params.toString();
    params.set("layers", activeLayersKey);
    if (level === "locality") params.set("level", "locality");
    else params.delete("level");
    if (activePresetId !== null) params.set("preset", activePresetId);
    else params.delete("preset");
    // task #78 Part 3: encode the vet-signed toggle so a shared board reproduces it.
    if (verifiedOnly) params.set("verified", "1");
    else params.delete("verified");
    // P5 (PO 2026-07-14): the encoding selection is a shareable coordinate —
    // "Copiar vista" reproduces the bivariate / per-cápita view.
    if (bivariateMode) params.set("encoding", "bivariate");
    else if (percapitaMode) params.set("encoding", "percapita");
    else params.delete("encoding");
    if (params.toString() !== before) {
      const qsStr = params.toString();
      replaceMapStateUrl(`${window.location.pathname}${qsStr ? `?${qsStr}` : ""}`);
    }
    // panorama-vista-redesign Phase 5: stamp capasDetail/scrubDetail on every
    // run of this effect — including a Simple/Detalle-only flip, which never
    // changes the URL params above — so the UI pref is never lost.
    saveBoard(params, { capasDetail, scrubDetail });
  }, [
    activeLayersKey,
    level,
    activePresetId,
    verifiedOnly,
    bivariateMode,
    percapitaMode,
    capasDetail,
    scrubDetail,
  ]);

  // map-QOL mount effect (runs once): resolve the initial board. The branching
  // (URL board vs `?preset=` deep-link vs saved-board restore vs first visit)
  // lives in initBoardOnMount (panorama-console-helpers); this effect is the
  // thin adapter that hands it the console's stable callbacks/refs.
  const mountInitDoneRef = useRef(false);
  useEffect(() => {
    if (mountInitDoneRef.current) return;
    mountInitDoneRef.current = true;
    initBoardOnMount({
      hasSeed,
      seededPresetId,
      defaultPresetId,
      levelRef,
      presetCommittedQsRef,
      seedDetailPrefs: (capas, scrub) => {
        setCapasDetail(capas);
        setScrubDetail(scrub);
      },
      missingFromCache,
      fetchLayersInto,
      // Same yank-guard as applyPreset: a national frame must NOT override a
      // scoped operator's own extent on a `?preset=` deep-link mount either.
      emitSeededPresetFrame: (seededPreset) => {
        const hasActiveScope =
          effectiveScopeProvinceRef.current != null ||
          effectiveScopeLocalityRef.current != null ||
          initialDivisionProvince != null ||
          initialDivisionLocality != null;
        if (seededPreset.framing && shouldEmitPresetFrame(seededPreset.framing, hasActiveScope)) {
          frameTokenRef.current += 1;
          setPresetFrame({ framing: seededPreset.framing, token: frameTokenRef.current });
        }
      },
      applyPreset,
      setBivariateMode,
      setPercapitaMode,
      clearPeriodSensitiveCaches: () => {
        dataRef.current.clear();
        provinceDataRef.current.clear();
        bivariateSignalRef.current.clear();
        asOfDataRef.current.clear();
      },
      setCommittedPeriod,
      setLevel,
      setStates,
      onSavedBoardRestored: () => setRestoredBoardNotice(true),
    });
    // hasSeed/seededPresetId are mount-stable props; the effect is mount-only
    // (mountInitDoneRef guard), so their inclusion never re-runs it.
  }, [
    fetchLayersInto,
    applyPreset,
    defaultPresetId,
    missingFromCache,
    hasSeed,
    seededPresetId,
    initialDivisionProvince,
    initialDivisionLocality,
  ]);

  const mapLabel = useMemo(() => {
    const names = activeLayers.map((l) => l.label);
    return names.length > 0 ? `Mapa: ${names.join(", ")}` : "Mapa situacional";
  }, [activeLayers]);

  // panorama-ia-v2 §2.4: the plain-language caption re-states what a map mark
  // means at the current VISTA + level. Caption the PRIMARY (base) layer of the
  // active board: the preset's base when a preset is active, else the first
  // active non-reference layer (rate/density/signal — the ones the caption verb
  // "Relleno/Tamaño" describes). Reference pins carry no per-view narrative.
  const captionLayer = useMemo(() => {
    if (activePresetId !== null) {
      // D1: under a metric-selector preset the EFFECTIVE base is the active
      // option's, not the preset default — captioning cobertura over an
      // esterilizacion fill would be a label≠paint lie.
      const base = activeMetricOption?.base ?? getPreset(activePresetId)?.base;
      if (base) return getLayer(base) ?? null;
    }
    for (const l of PANORAMA_LAYERS) {
      if (states[l.id]?.active && l.dataType !== "reference") return l;
    }
    return null;
  }, [activePresetId, activeMetricOption, states]);

  // The active period as a PanoramaPeriod (ISO dates) for the caption's
  // "últimos N días" phrase. since/until already resolve the active window.
  const captionPeriod = useMemo<PanoramaPeriod>(
    () => ({ from: since.toISOString().slice(0, 10), to: until.toISOString().slice(0, 10) }),
    [since, until],
  );

  const rankingUnitNoun = rankingUnitNounFor(level, effectiveScopeProvince);

  // panorama-ia-v2 §3.3 — the Estadísticas "Peores N" ranking: which layer it
  // orders by, the rows themselves, the honesty flags around emptiness and
  // k-anonymity, and the dock section's subtitle. The whole projection lives in
  // use-panorama-ranking.ts; the console only feeds it the five values it reads.
  const {
    rankingLayer,
    rankedActiveLayer,
    rankLocalityRateCount,
    effectiveRankingKind,
    rankingMeasureLabel,
    rankingAllInScope,
    rankingSmallScope,
    rankedRows,
    rankingDataUnavailable,
    dockSuppressedCount,
    rankingStructureHidden,
    dockRankingSubtitle,
  } = usePanoramaRanking({
    activePresetId,
    captionLayer,
    states,
    mapLayers,
    rankingUnitNoun,
  });

  // H2 (cowork QA, round-2 corrected): rate coverage (cobertura/esterilización/
  // microchip) is computed ONLY at province grain (repository "V1 LIMITATION").
  // BELOW province (department/locality framing) it paints nothing, so show the
  // honest "la cobertura se calcula solo a nivel provincia" empty state. Gate on
  // being BELOW province grain (`level !== "province"`), NOT on a province being
  // selected — round-1 fired even AT province grain. This is a MAP concern about
  // the BASE choropleth (captionLayer), so it reads the base's dataType directly
  // (the ranking layer may now differ from the base under a rankBy preset).
  const rateProvinceOnlyEmpty = captionLayer?.dataType === "rate" && level !== "province";
  // Honesty (panorama QA 2026-07-14): ANY active layer whose last fetch was the
  // server's budget/failure fallback — the map overlay + a live notice must say
  // "no pudimos calcular a tiempo", never let a timeout read as "sin datos".
  const degradedLayerLabels = PANORAMA_LAYERS.filter(
    (l) => states[l.id]?.active && states[l.id]?.degraded,
  ).map((l) => l.label);

  // Visual review 2026-07-23 (#1) — full story in all-suppressed-notice.tsx.
  const allSuppressedNotice = useMemo(
    () => buildAllSuppressedNotice({ captionLayer, states, activeLayers, kpis: kpis.kpis }),
    [captionLayer, states, activeLayers, kpis],
  );

  // Hover sync map↔row: the highlighted unit key mirrors between the panel and
  // the map (feature-state highlight). Row click opens the DetailDrawer.
  const [highlightedUnitKey, setHighlightedUnitKey] = useState<string | null>(null);

  // task #55 — "Informe de situación": the generation stamp is captured ONLY when
  // the operator triggers the print (starts null so SSR + first client render
  // match — no timestamp hydration mismatch on the always-mounted print node).
  const [informeGeneratedAt, setInformeGeneratedAt] = useState<Date | null>(null);

  // A2: ONE decision shared by the click and the preview hint (see its jsdoc).
  // useCallback: feeds the memoized preview object below (P4 memo hygiene).
  const drillTargetFor = useCallback(
    (k: string) => resolveRowDrillTarget(k, { province: effectiveScopeProvince, level }),
    [effectiveScopeProvince, level],
  );
  const onRankedSelect = useCallback(
    (key: string) => {
      const drillTarget = resolveRowDrillTarget(key, { province: effectiveScopeProvince, level });
      // The camera follows on its own (commitScopeDrill → autozoom effect).
      if (drillTarget) return commitScopeDrill(drillTarget, null);
      if (!rankingLayer || !rankedActiveLayer) return;
      const feature = findRankedFeature(rankedActiveLayer.features, key);
      if (!feature) return;
      onFeatureClick(rankingLayer.id, feature.properties as Record<string, unknown>);
    },
    [
      rankingLayer,
      rankedActiveLayer,
      onFeatureClick,
      effectiveScopeProvince,
      level,
      commitScopeDrill,
    ],
  );

  // V2 — the SERIALIZABLE scope every export now carries. The two halves meet
  // here and nowhere else: `scopeAuthority` (who is asking — server-resolved,
  // the console cannot know it) folded together with the live ViewState and the
  // rendered grain (`level`, which is derived at runtime and therefore absent
  // from the ViewState). Null when the page did not supply an authority, which
  // leaves every export exactly as it was before V2.
  // Deliberately excludes `generatedAt`: this identifies the VIEW, and each
  // export stamps its own cut instant where it needs one.
  const viewScope = useMemo(
    () =>
      scopeAuthority
        ? makeViewScopeDescriptor({ authority: scopeAuthority, view: viewState, grain: level })
        : null,
    [scopeAuthority, viewState, level],
  );

  // Live-QA regression (2026-07-11): the masthead scope pill read the SERVER
  // `scopeLabel` prop, so a shallow client drill (which never re-renders the
  // server shell) left it stuck on "Nacional · todas las provincias". Derive the
  // pill label from the SAME client scope state the KPIs/map read (see
  // scope-truth.ts) — this is the OPERATOR-aware label.
  const liveScopeLabel = useMemo(
    () =>
      deriveLiveScopeLabel({
        province: effectiveScopeProvince,
        locality: effectiveScopeLocality,
        serverScopeLabel: scopeLabel,
        allowedProvinces,
        localities: scopeData.localities,
      }),
    [
      effectiveScopeProvince,
      effectiveScopeLocality,
      allowedProvinces,
      scopeData.localities,
      scopeLabel,
    ],
  );

  // panorama-ia-v2 §3.6: metadata for the map's "Exportar PNG" footer
  // (auditable provenance). Scope + period in plain es-AR; suppressed-cell
  // count summed across the active layers (audit trail). V2 adds the view
  // digest, which ties the PNG to the descriptor the CSV/informe print in full.
  //
  // QA 2026-08-01 (govt sanitary-authority walkthrough): `buildViewMeta` knows
  // only whether the VIEW is drilled, so with no drill its scope label is
  // "Nacional" — for EVERY operator, including one bounded to "CABA · 5
  // localidades". Resolve the operator-aware label ONCE, here, so every artifact
  // downstream (dock caption, dock meta, exported PNG footer, printed informe)
  // cites one derivation instead of re-copying the cascade.
  const viewMeta = useMemo(() => {
    const view = buildViewMeta({
      province: effectiveScopeProvince,
      locality: effectiveScopeLocality,
      since,
      until,
      periodParam,
      states,
      asOf,
    });
    return {
      asOf,
      viewScope,
      // L-7: the one-way dropCubeStamp latch — present only while the board is
      // still the SSR cube-served seed, so exports state the cube's stamp
      // instead of claiming today/live over up-to-26h-old data.
      cubeBuiltAt: seedCubeBuiltAt,
      ...view,
      scopeLabel: resolveScopeLabel(liveScopeLabel, view.scopeLabel),
    };
  }, [
    effectiveScopeProvince,
    effectiveScopeLocality,
    since,
    until,
    states,
    asOf,
    periodParam,
    viewScope,
    liveScopeLabel,
    seedCubeBuiltAt,
  ]);

  // Registros (dock) — the accessible table of what the map paints: the map is
  // the least accessible surface, so mirror it into a real table. Flatten every
  // The AGGREGATE layers (choropleth fills + graduated per-unit circles;
  // reference/points layers are individual entities, not per-unit values) —
  // the ones that tabulate. Derived once and reused by every map-table memo.
  const activeAggregateLayers = useMemo(
    () => activeLayers.filter((l) => l.geomType === "choropleth" || l.renderMode === "graduated"),
    [activeLayers],
  );

  // UX audit 2026-07-26 (finding 2): the layers that WOULD tabulate but are
  // currently in the near-zoom POINTS band, so they emit individual records
  // instead of per-unit cells and contribute zero rows above. Registros used to
  // report that as "sin datos por unidad" — a claim about the world made from a
  // fact about the camera. The CABA inset drill lands at z=11, which is exactly
  // this band, so the flagship demo path hit it: KPI 39, map bubbles, ranking
  // "20 comunas SÍ reportaron", table "sin datos". Named here, spoken by
  // MapDataTable.
  const pointModeLayerLabels = useMemo(
    () =>
      activeLayers
        .filter((l) => l.renderMode === "points" && AGGREGATED_POINT_IDS.has(l.id as LayerId))
        .map((l) => l.label),
    [activeLayers],
  );

  // Row/summary construction lives in panorama-map-table.ts (pure, unit-tested);
  // the console only memoizes it against the view data.
  const mapTableRows = useMemo<MapTableRow[]>(
    () => buildMapTableRows(activeAggregateLayers),
    [activeAggregateLayers],
  );

  const mapTableSuppressedUnits = useMemo(
    () => sumSuppressedTableUnits(activeLayers, states),
    [activeLayers, states],
  );

  // K4 (honest exports): labels of table-contributing layers capped at the
  // server row limit — the CSV builder appends a truncation comment for each.
  const mapTableTruncatedLayers = useMemo(
    () =>
      activeAggregateLayers.filter((l) => states[l.id as LayerId]?.truncated).map((l) => l.label),
    [activeAggregateLayers, states],
  );

  const dockRecordSummary = useMemo(() => summarizeDockRecords(activeLayers), [activeLayers]);
  // The dock badge counts the ROWS OF THE PANE IT LABELS. It used to show the
  // event total, putting "Registros 0" on a tab whose table listed 72 rows
  // (P4-U1). The event total is still stated, labelled, in the line below.
  // One expression, so badge and table cannot drift.
  const dockBadgeCount = mapTableRows.length;
  const mapTableCaption = buildMapTableCaption(viewMeta.scopeLabel, viewMeta.periodLabel);
  // v2C dock bar "Exportar CSV": the SAME in-memory CSV artifact the Registros
  // pane's download link builds (one builder, two affordances).
  const dockCsvHref = useMapTableCsvHref(mapTableRows, mapTableTruncatedLayers, viewScope);

  // v2C: the old FilterChips row (Alcance/Período/Al) is retired — the scope
  // pill + period segmented in the floating top-right cluster ARE the visible
  // conditions now, and the masthead fresh chip carries the data cutoff.

  const onScrub = useCallback((next: Date | null) => setAsOf(next), []);

  // "Copiar vista" fidelity: mirror the map camera (zoom + center) into the URL
  // on every settle via a shallow History replace — the SAME machinery the
  // layer/period/scope params ride — so a copied link reproduces the exact
  // frame. Skips the write when the rounded value is unchanged (a pure re-render
  // or a settle that lands on the same rounded camera never churns the URL).
  const onCameraChange = useCallback((camera: MapCamera) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const before = params.toString();
    encodeCameraToParams(params, camera);
    const after = params.toString();
    if (after !== before) replaceMapStateUrl(`${window.location.pathname}?${after}`);
  }, []);

  // "Copiar vista" fidelity: mirror the scrub position into the URL at day
  // precision (live edge → drop the param). The first run is guarded so a
  // restored `asOf` is not clobbered before the scrubber has seeked to it (the
  // scrubber briefly emits null at the live edge on mount, then seeks).
  const asOfUrlSyncReadyRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!asOfUrlSyncReadyRef.current) {
      asOfUrlSyncReadyRef.current = true;
      // Do not delete a URL-restored asOf on the mount pass; only start syncing
      // once the console actually holds a scrub position.
      if (asOf === null) return;
    }
    const params = new URLSearchParams(window.location.search);
    const before = params.toString();
    encodeAsOfToParams(params, asOf);
    const after = params.toString();
    if (after !== before) {
      replaceMapStateUrl(`${window.location.pathname}${after ? `?${after}` : ""}`);
    }
  }, [asOf]);

  // task #77: flip the replay basis (valid ↔ transaction). The as-of feature cache
  // holds features resolved under the PREVIOUS basis, so clear it; the as-of effect
  // (which now depends on timeBasis) refetches the active temporal layers under the
  // new basis when a scrub is active. No-op visually while parked at live.
  const onBasisChange = useCallback((next: TimeBasis) => {
    if (next === timeBasisRef.current) return;
    timeBasisRef.current = next;
    asOfDataRef.current.clear();
    setTimeBasis(next);
  }, []);

  // map-QOL selective refresh (freshness chip's "Actualizar"): refetch the
  // KPIs + every ACTIVE layer with plain client fetches. No reload, no router,
  // the map stays mounted — caches are simply overwritten with fresh data.
  const [refreshing, setRefreshing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies(kpiFetchQsRef.current): stable ref from usePanoramaKpis, read live at call time — not reactive.
  const onRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    const params = new URLSearchParams(window.location.search);
    const activeIds = PANORAMA_LAYERS.filter((l) => statesRef.current[l.id]?.active).map(
      (l) => l.id,
    );
    setStates((s) => {
      const next = { ...s };
      for (const id of activeIds) next[id] = { ...next[id], loading: true };
      return next;
    });
    // Round-2 review #3: include the ACTIVE as-of cutoff (kpiFetchQsRef carries it)
    // so "Actualizar" during a scrub refetches the AS-OF strip, not a live one over
    // a historical map. Falls back to the plain scope key when parked at live.
    const kpiRefreshQs = kpiFetchQsRef.current;
    const kpiFetch = fetch(`/api/panorama/kpis${kpiRefreshQs ? `?${kpiRefreshQs}` : ""}`, {
      headers: { accept: "application/json" },
      signal: signalFor("kpis"),
    })
      .then((r) => (r.ok ? (r.json() as Promise<PanoramaKpis>) : null))
      .then((body) => {
        if (body) {
          setKpis(body);
          setKpisStale(false);
        } else {
          setKpisStale(true);
        }
      })
      .catch((err) => {
        // Superseded fetch (keyed abort) — a newer KPI request replaces this one.
        if (isAbortError(err)) return;
        // Keep the last-known KPIs on a transient failure, but surface it —
        // this used to be a silent no-op (error-path audit 2026-07-04, E5).
        console.error("[PanoramaConsole] selective KPI refresh failed", err);
        setKpisStale(true);
      });
    void Promise.all([
      kpiFetch,
      // preserveOnError: a REFRESH must never deactivate an already-active layer
      // just because its refetch failed under load — that would empty `layers=`
      // in the URL and lose the operator's selection (staging QA 2026-07-08 #2).
      fetchLayersInto(activeIds, levelRef.current, params, { preserveOnError: true }),
    ]).finally(() => setRefreshing(false));
  }, [refreshing, fetchLayersInto, signalFor, setKpis, setKpisStale]);

  // A1 PR-7: autozoom — derive the current jurisdiction selection from
  // searchParams (set by JurisdictionSwitcher via a full document navigation).
  // The province code is an ISO 3166-2:AR string (e.g. "AR-X"); the locality
  // is identified by its slug. The locality centroid comes from the server-
  // preloaded localityCentroids map (keyed by slug), so no client-side DB
  // call is needed.
  // Effective division province: an explicit picker selection wins; otherwise
  // fall back to the operator's implicit single-province scope so their
  // administrative divisions (barrios/departamentos) load + render on mount
  // (PO validation 2026-07-07: a jurisdiction-scoped govt operator never picks
  // a province, so this stayed null and no outlines ever appeared). The map's
  // autozoom is UNAFFECTED — the A1 autozoom effect early-returns at mount
  // (the map is not yet loaded) and never re-fires for a constant value, so the
  // server-computed jurisdiction bbox (initialBounds) keeps the initial frame.
  // Embedded-drill: the map's scope reads the CLIENT-committed effective scope
  // (a shallow drill isn't visible to useSearchParams in production), falling
  // back to the operator's implicit single-province scope.
  const selectedProvinceCode = effectiveScopeProvince ?? initialDivisionProvince ?? null;
  // Mirror selectedProvinceCode: an explicit locality drill wins; otherwise the
  // operator's implicit single-locality scope, so its centroid drives the mount
  // autozoom (selectedLocalityCenter below) for a jurisdiction-scoped operator.
  const selectedLocalitySlug = effectiveScopeLocality ?? initialDivisionLocality ?? null;
  // Click-to-drill (task #55) gating:
  //  - a province drill is offered only to operators NOT pinned to a jurisdiction
  //    (admin/universal, initialDivisionProvince null) — a scoped govt operator
  //    cannot cross into another province;
  //  - "← Volver" is offered only when the province came from an EXPLICIT pick
  //    (an effective `province` scope), never for the implicit jurisdiction scope.
  const canDrillProvince = initialDivisionProvince == null;
  const canReturnNational = effectiveScopeProvince != null;
  // P4c (design §5.5): the admin wheel-hierarchy takeover is GONE — every
  // operator gets the same cooperative wheel-zoom (scroll = camera) and drills
  // by CLICK (click-drill / switcher / "← Volver", gated on canDrillProvince).
  // Locality centroid for autozoom — from the live scope-data (refreshed on an
  // embedded drill), so a locality picked after a province drill flies correctly.
  const selectedLocalityCenter: [number, number] | null =
    selectedLocalitySlug !== null ? (scopeData.centroids[selectedLocalitySlug] ?? null) : null;

  // ARCHETYPE A: on-canvas aggregation-level badge copy. Announces what a map
  // mark aggregates NOW — "Provincias" at the national rollup, the division noun
  // ("Departamentos/partidos", "Comunas" for CABA) when drilled into a province,
  // or "Localidades" at locality level without a province scope. HONEST to a
  // layer that draws a finer grain than the shared `level`: when zoonosis (a
  // national-department-grain layer) is active at the national rollup, the badge
  // names the divergence ("Provincias · Zoonosis: departamentos") instead of
  // claiming "Provincias" while the map paints departments. Grain is decided by
  // the domain helper (isNationalDepartmentGrain), never re-derived here.
  const aggregationLabel = aggregationBadgeLabel({
    level,
    selectedProvinceCode,
    activeLayerIds: activeLayers.map((l) => l.id as LayerId),
  });

  // Finding #3 (honest disclosure): the map auto-disaggregates to a FINER grain
  // (department/locality) than the KPI scope on plain zoom, while the KPI chips
  // keep summarizing the SCOPE TOTAL (render-only disaggregation — the scope is
  // unchanged by design). A national/province KPI over a department map READS as
  // incoherent, so we surface a one-line clarifier. Excluded when the KPIs are
  // already at the shown grain: an explicit locality drill (effectiveScopeLocality)
  // or an operator bounded to a single locality (initialDivisionLocality) means the
  // chips and the map are the same geography — no clarifier needed.
  const kpiScopeCoarserThanMap =
    level === "locality" && !effectiveScopeLocality && initialDivisionLocality == null;

  // Scope-change announcement (WCAG 4.1.3 Status Messages): the scope pill is
  // the sole keyboard path to change jurisdiction, and a commit was previously
  // SILENT to a screen reader (the visible pill text updated, the map re-framed,
  // but nothing lived in an aria-live region). Mirror the kpisStale/
  // scaleAnchoredToAsOf polite notices: on every scope change (skipping the
  // mount pass), publish the new scope into a visually-hidden live region so AT
  // hears "Alcance: Córdoba" / "Alcance: Argentina" after a commit.
  const [scopeAnnouncement, setScopeAnnouncement] = useState("");
  const scopeAnnounceMountRef = useRef(true);
  useEffect(() => {
    if (scopeAnnounceMountRef.current) {
      scopeAnnounceMountRef.current = false;
      return;
    }
    setScopeAnnouncement(`Alcance: ${liveScopeLabel || "Argentina"}`);
  }, [liveScopeLabel]);

  // trust/safety invariant (2026-07-10): the KPI fan-out resolved to the honest
  // degraded payload (no real numbers). Every CONCLUSION surface fed by the KPI
  // strip (reading, metrics column) must REPLACE its reassuring copy with an
  // explicit "no pudimos calcular" state — a degraded view must never read as
  // "all good". Pending (still streaming) is a separate, non-degraded state.
  //
  // Belt-and-suspenders (PO instrumented-review finding #1, 2026-07-10): treat
  // an EMPTY strip as degraded even when the `degraded` flag is absent. The real
  // fan-out returns 8 tiles on success and throws (→ degradedPanoramaKpis, flag
  // set) on failure, so `kpis: []` while NOT pending only ever means "no real
  // numbers". Without this, any empty strip that slipped through without the
  // flag (an older payload, a 503 body, a fixture) would fall through to
  // buildPanoramaReading([]) → "Sin variación destacable…" — a reassuring
  // all-clear on a failed load, the single most dangerous defect in a
  // surveillance tool (empty ≠ all-clear).
  const kpisDegraded = (kpis.degraded === true || kpis.kpis.length === 0) && !kpisPending;

  // panorama-vista-redesign Phase 4 (design Decision 4): temporal gating is
  // sourced EXCLUSIVELY from isTemporalLayer() over the ACTIVE layer set —
  // no scrubber-local temporal set (the regression the design flags). Adding
  // a temporal layer flips this true and self-enables the scrubber.
  // P2: this aggregate now reads the capability gate's `allowedControls.scrubber`
  // (identical value: isTemporalLayer over the active set) — one source of truth.
  const temporalAvailable = capabilities.allowedControls.scrubber;

  // trust/safety (2026-07-10): the scrubber reproduces only TEMPORAL layers;
  // current-state layers are dimmed (never reconstructed as-of-t). When the
  // PRIMARY/base (caption) layer is current-state — e.g. cobertura in the
  // brotes-activos vista, whose caption reads "estado actual" — the scrubber's
  // dated "Situación al …" framing overreaches: the headline metric cannot vary
  // with the fecha de corte. Surface the base measure so the scrubber can state
  // that honestly instead of fabricating a dated situation over it. Undefined
  // when the base is temporal (no disclaimer needed) or absent.
  const currentStateBaseLabel =
    captionLayer != null && !isTemporalLayer(captionLayer.id)
      ? captionLayer.caption.measure
      : undefined;

  // QA fix (finding 1): the active layer set losing its last temporal layer
  // must park the scrubber back at live — otherwise `scrubbing` stays true
  // (asOf non-null) and the map keeps every non-temporal layer DIMMED while
  // the scrubber itself already shows "No disponible en esta vista". The
  // scrubber's own onChange never re-fires here (its derived `asOf` value
  // hasn't changed), so this console must clear its own state directly.
  useEffect(() => {
    if (!temporalAvailable && asOf !== null) {
      setAsOf(null);
      setScrubResetToken((v) => v + 1);
    }
  }, [temporalAvailable, asOf]);

  // Park an active temporal frame back at live when the dock is collapsed.
  // The rule, and why the tab half of it was retired, lives with the helper:
  // panorama-console-helpers.ts -> shouldParkAtLive.
  useEffect(() => {
    if (shouldParkAtLive({ dockOpen, dockTab, asOf })) {
      setAsOf(null);
      setScrubResetToken((v) => v + 1);
    }
  }, [dockOpen, dockTab, asOf]);

  // Round-2 review #3 follow-up: the scrubber's DISPLAY axis clamps to the live
  // last-event watermark (kpis.dataAsOf). But an AS-OF KPI refetch returns an
  // EARLIER dataAsOf (the scrubbed frame's last event), which would shrink the axis
  // mid-scrub and snap the thumb back to live — silently cancelling the scrub. Hold
  // the LIVE watermark (captured only while parked at live) and feed THAT to the
  // scrubber during a scrub, so the axis stays anchored and the scrub sticks.
  const liveWatermarkRef = useRef<string | null>(null);
  if (asOf === null && !kpisPending && !kpisStale) {
    liveWatermarkRef.current = kpis.dataAsOf ?? null;
  }
  const scrubberWatermark = scrubbing
    ? liveWatermarkRef.current
      ? new Date(liveWatermarkRef.current)
      : null
    : kpisPending || kpisStale
      ? null
      : kpis.dataAsOf
        ? new Date(kpis.dataAsOf)
        : null;

  // ARCHETYPE A: the time scrubber is DOCKED to the map card's bottom edge (see
  // SituationalMap `bottomDock`) instead of floating as a separate block below
  // the map. Its logic/props are UNCHANGED — this is a layout move only.
  const scrubberDock = (
    <>
      <PanoramaBoardNotices staleFrame={staleFrame} droppedLayerIds={droppedLayerIds} />
      <TimeScrubberDynamic
        since={since}
        until={until}
        onChange={onScrub}
        basis={timeBasis}
        onBasisChange={onBasisChange}
        temporalAvailable={temporalAvailable}
        currentStateBaseLabel={currentStateBaseLabel}
        // Cowork QA ronda 3 §2 (C9, P3.6): the Simple/Detalle toggle is removed
        // from "Reproducción temporal" for consistency with the rail panels —
        // omitting onScrubDetailChange hides the toggle, and scrubDetail={true}
        // renders the full detail (date ticks + bitemporal "Base" selector) by
        // default. The date-tick / basis content is additive, so nothing is lost.
        scrubDetail={true}
        onPlayingChange={setScrubberPlaying}
        onDraggingChange={setScrubDragging}
        resetToken={scrubResetToken}
        initialAsOf={initialAsOf}
        // SUGGESTION 9: while a scope/period refetch is in flight the last-known
        // kpis.dataAsOf belongs to the PREVIOUS scope — showing its time would
        // print a stale watermark. Drop to null (scrubber falls back to the
        // generic "Al último evento") until the new cutoff lands.
        watermark={scrubberWatermark}
        histogramBins={signalHistogramBins ?? aggregateHistogramBins}
        // política → resultado: rule-change markers (scope-enforced fetch above)
        // + the card's single link out — admin surface only (see `pathname`).
        ruleChangeMarkers={ruleChangeMarkers}
        ruleChangeDetailHref={pathname?.startsWith("/admin") ? "/admin/inteligencia" : undefined}
        // Cowork QA ronda 3 §5: keep "Ahora" an always-available escape hatch while
        // a temporal frame is active, so a stuck delta is never uncleanable.
        temporalActive={scrubbing}
      />
    </>
  );

  // --- v2C floating dock panes ----------------------------------------------
  // Registros: the accessible per-unit projection of what the map paints (the
  // MapDataTable "Ver como tabla" surface, promoted from a rail toggle into the
  // dock's primary records tab — its k-anon "Protegido (k<5)" cells unchanged).
  const dockMeta = `${viewMeta.scopeLabel} · ${viewMeta.periodLabel} · ${capasCountLabel(
    activeLayers.length,
  )}`;
  // H5 (cowork QA): REFERENCE layers (decomisos, refugios) are drawn on the map
  // but are NOT tabulated in Registros (they carry no per-unit aggregate row). An
  // operator auditing "qué venimos haciendo" saw the bubbles on the map but zero
  // rows in the list with no explanation. Name the map-only reference layers in a
  // one-line disclosure above the table so the absence is honest, not a bug.
  // Memoized: PanoramaDockRegistros is memo()-wrapped (P4) and fresh arrays
  // every render would defeat it.
  const referenceLayerLabels = useMemo(
    () => activeLayers.filter((l) => l.dataType === "reference").map((l) => l.label),
    [activeLayers],
  );
  // Cowork QA ronda 3 §3: name the "Valor" column after the metric it shows.
  const mapTableMetrics = useMemo(
    () =>
      activeAggregateLayers.map((l) => ({
        label: l.label,
        dataType: l.dataType,
        level: l.level,
      })),
    [activeAggregateLayers],
  );
  // Cowork QA ronda 3 §3: a rate layer drilled below province shows a per-unit
  // COUNT (not the %) — surface that caveat once so "conteo" is not mistaken for a
  // percentage (the % is a province-only figure in v1).
  const localityRateInView = activeAggregateLayers.some(
    (l) => l.dataType === "rate" && l.level === "locality",
  );
  const dockRegistros = (
    <PanoramaDockRegistros
      summary={dockRecordSummary}
      referenceLayerLabels={referenceLayerLabels}
      localityRateInView={localityRateInView}
      rows={mapTableRows}
      caption={mapTableCaption}
      metrics={mapTableMetrics}
      truncatedLayers={mapTableTruncatedLayers}
      pointModeLayerLabels={pointModeLayerLabels}
      suppressedUnits={mapTableSuppressedUnits}
      viewScope={viewScope}
    />
  );
  // viz-suite Wave 1 — the CalendarHeatmap's per-day series. Source-of-truth
  // mirror of the TimeScrubber histogram: the points path (client timestamps)
  // shadows the aggregate path (server ?histogram=1), EXACTLY like
  // signalHistogramBins ?? aggregateHistogramBins — one series feeds both views,
  // so they never diverge (W1 #8). Empty array → the calendar narrates its own
  // empty/non-temporal state.
  // EMPTY_DAILY_COUNTS + useCallback: CalendarHeatmap is memo()-wrapped (P4);
  // a fresh [] fallback or inline onDayClick arrow would defeat it every render.
  const scopeDailyCounts = pointsDailyCounts ?? aggregateDailyCounts ?? EMPTY_DAILY_COUNTS;
  const onCalendarDayClick = useCallback(
    (date: string) => commitPeriod("custom", date, date),
    [commitPeriod],
  );
  const calendarMethodNote = `Total del alcance por día · ${
    timeBasis === "transaction"
      ? "por fecha de registro (lo que el Estado conocía)"
      : "por fecha de ocurrencia"
  }`;
  // Ranking one-list consolidation (PO: "consistente a morir"): the accessible,
  // header-ed PanoramaDataTable is now the DEFAULT (and only) rendering — the
  // headerless RankedUnitsPanel + its "Ver tabla completa" toggle are retired. The
  // table carries the map linkage (highlightedKey/onHover) the list used to own,
  // so hover-sync survives; the k-anon suppressed-count line stays beneath it.
  // Stable identity for the memo()-wrapped PanoramaDataTable (P4).
  const rankingPreview = useMemo(
    () => ({
      measureLabel: rankingMeasureLabel,
      drills: (key: string) => drillTargetFor(key) !== null,
    }),
    [rankingMeasureLabel, drillTargetFor],
  );
  const dockRanking =
    effectiveRankingKind !== null && rankingLayer !== null ? (
      <div className="space-y-2">
        <PanoramaDataTable
          rows={rankedRows}
          kind={effectiveRankingKind}
          measureLabel={rankingMeasureLabel}
          onSelect={onRankedSelect}
          highlightedKey={highlightedUnitKey}
          onHover={setHighlightedUnitKey}
          preview={rankingPreview}
          dataUnavailable={rankingDataUnavailable}
          // C4: measurable vs suppressed vs blind — see PanoramaDataTable.
          measuredUnits={rankingAllInScope.length}
          suppressedUnits={dockSuppressedCount}
          censoredAtMax={rankingLayer?.censoredAtMax}
          // The table re-sorts what it is handed, so it needs the polarity too —
          // passing it only to rankWorstUnits leaves the on-screen order wrong.
          higherIsBetter={rankingLayer?.higherIsBetter}
          scopeFallback={rankingSmallScope}
          unitNoun={rankingUnitNoun}
          // Finding 4: the rate→count coercion below province grain turns this
          // into a VOLUME order. "Peores 10 · cobertura antirrábica (conteo)"
          // crowned Córdoba · Capital (147 vaccinations) the worst department.
          orderedByVolume={rankLocalityRateCount}
        />
        {/* RA-7 F6 — DECLARE THE UNIVERSE. ONE layer's count (the ranked base),
            not the view's; unnamed, the board's smallest protected-cell figure
            read as a contradiction of the legend pill's view-wide total. */}
        {dockSuppressedCount > 0 && (
          <p className="flex items-center gap-2 text-xs text-ln-op-mute">
            <span className="rounded-full border border-ln-op-line px-2 py-0.5 font-medium">
              Protegido (k&lt;5)
            </span>
            {dockSuppressedCount}{" "}
            {dockSuppressedCount === 1 ? "unidad suprimida" : "unidades suprimidas"} por k-anonimato
            en {rankingLayer.label}
          </p>
        )}
        <p className="text-xs leading-snug text-ln-op-faint">
          Pasá el mouse por una fila para ubicarla en el mapa.
        </p>
      </div>
    ) : (
      <p className="text-xs leading-snug text-ln-op-mute">
        Sin ranking para las capas activas en este alcance.
      </p>
    );
  // The calendar heatmap sits ABOVE the ranking as its own <section>, so a later
  // regroup into a "Tendencias" dock family (organizing principle, PO 2026-07-12)
  // is a move, not a rewrite. It always renders — its own empty/non-temporal
  // state narrates why when there is nothing to show. Day-cell click filters the
  // map to that single day through the EXISTING period-change path (commitPeriod
  // custom window), never a new state axis.
  // C3: each Estadísticas widget lives in its own bounded, collapsible section
  // (LnCard-like) with a clear header — instead of the old space-only stack where
  // one widget's edge blurred into the next. Collapse is component-local
  // (PanoramaStatSection); the dock's URL/view state has no per-widget slot.
  const dockStats = (
    <div className="space-y-3">
      <PanoramaStatSection title="Actividad por día">
        <CalendarHeatmap
          data={scopeDailyCounts}
          since={captionPeriod.from}
          until={captionPeriod.to}
          methodNote={calendarMethodNote}
          hideHeading
          emptyMessage={calendarEmptyMessage({
            hasTemporalLayer: activeTemporalKey !== "",
            suppressed: aggregateHistogramSuppressed,
          })}
          onDayClick={onCalendarDayClick}
        />
      </PanoramaStatSection>
      {/* P2 (PO 2026-08-04): "la tarjeta no va" when no data justifies it — the
          whole SECTION is dropped, not just emptied. `rankingStructureHidden`
          is false for a k-anon SUPPRESSED ranking, so the suppression notice
          inside can never vanish silently (P2-1's uncrossable limit). */}
      {!rankingStructureHidden && (
        <PanoramaStatSection title="Ranking de unidades" subtitle={dockRankingSubtitle}>
          {dockRanking}
        </PanoramaStatSection>
      )}
    </div>
  );

  // Dock redesign (PO ask #3): the map's full scale legends — previously
  // rendered inside LegendPill's expanded panel — now live in the dock's
  // Referencias tab. Same props MapLegends always took; only the mount point
  // moved, so the province ramp / division fill / graduated / bivariate
  // legends still stay in lockstep with what the map paints.
  const dockReferencias = (
    <MapLegendsDynamic
      layers={mapLayers}
      divisionLegend={divisionLegend}
      graduatedScale={graduatedScale}
      provinceSeqLegend={provinceSeqLegend}
    />
  );

  // v2C legend pill — the compact strip's data. The ramp mirrors what the map
  // ACTUALLY paints: the lifted province classed scale for the caption layer
  // when present (scrub-locked parity), else the division-fill classed colors;
  // no classed fill → no ramp cells (label + dots + k-anon pill only). One dot
  // per active POINT layer, in its registry color.
  const legendRampColors = useMemo<readonly string[] | null>(() => {
    // H10 (cowork QA): in bivariate mode the map paints a 3×3 matrix, NOT a
    // sequential ramp — but the collapsed pill still had a caption/division ramp
    // to show and rendered it, mislabeling the encoding. Suppress the ramp here so
    // the pill shows the honest bivariate hint (LegendPill `bivariate`) instead.
    if (bivariateActive) return null;
    if (captionLayer && provinceSeqLegend[captionLayer.id]) {
      return provinceSeqLegend[captionLayer.id].colors;
    }
    if (divisionLegend && divisionLegend.colors.length > 0) return divisionLegend.colors;
    return null;
  }, [captionLayer, provinceSeqLegend, divisionLegend, bivariateActive]);
  // PO 2026-08-01 — "los círculos no son consistentes con lo mostrado en el
  // mapa". This read `activeLayers` (what the operator REQUESTED) where every
  // other legend surface reads `mapLayers` (what the canvas PAINTS). Under the
  // bivariate encoding the two differ by exactly one layer: mapLayers drops the
  // signal because it is folded into the 3×3 matrix, so on riesgo-ppp the strip
  // showed an orange "Mordeduras / antirrábica" dot over a map with not one
  // circle on it. Same rule as RA-7 F9/F10 — a legend may not name a mark the
  // frame does not paint — and per-cápita gets fixed for free (mapLayers carries
  // the "por 10.000 hab." label the marks were re-encoded into).
  const legendLayerDots = useMemo(
    () =>
      mapLayers
        .filter((l) => l.geomType === "point")
        .map((l) => ({ color: l.color, label: l.label })),
    [mapLayers],
  );

  // Round-3 QA fix 6 — collapsed-ramp endpoint labels (panorama-labels.ts).
  const legendRampEndpoints = useMemo(
    () =>
      legendRampEndpointLabels({
        bivariateActive,
        captionLayer,
        liftedBreaks: captionLayer ? (provinceSeqLegend[captionLayer.id]?.breaks ?? null) : null,
        divisionLegend,
        provinceExtent: captionLayer ? (provinceSeqLegend[captionLayer.id]?.extent ?? null) : null,
        // TRI-STATE — never coerce. undefined means "this layer has a meta, not
        // a polarity", and polarityMarks() prints no words for it. `=== true`
        // collapsed that into false and the five coverage vistas labelled their
        // PALEST swatch "mejor". Guarded in panorama-labels.test.ts.
        higherIsBetter: captionLayer?.higherIsBetter,
      }),
    [captionLayer, provinceSeqLegend, divisionLegend, bivariateActive],
  );

  // A2 (cowork demo 2026-07-17): the pill TITLE must name the layer that painted
  // the ramp above, NOT `captionLayer` (the first active non-reference layer =
  // the signal overlay in a custom vista). Mirror legendRampColors' source
  // precedence so title and scale always agree — signal-titled cobertura counts
  // ("Zoonosis / señales · 16 … 676") were a label≠scale lie.
  const legendRampLabel = useMemo(
    () =>
      legendRampTitle({
        bivariateActive,
        captionLabel: captionLayer?.label ?? null,
        captionPaintsProvinceRamp: Boolean(captionLayer && provinceSeqLegend[captionLayer.id]),
        divisionRampLabel:
          divisionLegend && divisionLegend.colors.length > 0 ? divisionLegend.label : null,
      }),
    [bivariateActive, captionLayer, provinceSeqLegend, divisionLegend],
  );

  // Round-3 QA fix 6: graduated/points encodings rendered NO collapsed scale at
  // all (just a color dot) — the biggest gap the QA doc named. A tiny
  // small●–large● hint using the SAME bins the map's bubbles use
  // (graduated-scale.ts), so the pill states the value range a bubble size
  // spans without opening the full "Eventos por unidad" legend block.
  const legendGraduatedHint = useMemo<{
    small: GraduatedBin;
    large: GraduatedBin;
    color: string | null;
  } | null>(() => {
    if (bivariateActive || !graduatedScale || graduatedScale.bins.length === 0) return null;
    // PAINTED, not merely active (the legendLayerDots rule): `activeLayers` here
    // was the same wrong array, only currently shadowed by the bivariateActive
    // guard above. Reading mapLayers removes the latent case entirely.
    const grad = mapLayers.filter((l) => l.renderMode === "graduated");
    if (grad.length === 0) return null;
    return {
      small: graduatedScale.bins[0],
      large: graduatedScale.bins[graduatedScale.bins.length - 1],
      // Cite the bubble fill only when one layer owns it (see MapLegends).
      color: grad.length === 1 ? grad[0].color : null,
    };
  }, [mapLayers, graduatedScale, bivariateActive]);

  // task #63: bivariate encoding toggle — offered ONLY on "Señales de brote" at
  // province framing (both inputs active). A map ENCODING switch (how the two
  // layers are drawn), not a data toggle. ARCHETYPE A: relocated from above the
  // map into the monitoring rail so the geography leads the fold. The segment
  // list, the active value and the honest refusal copy are a pure projection —
  // see panorama-map-modes.ts (task #24 fase 1, C2 language contract).
  const mapModeModel = buildMapModeControlModel({
    mapModes: capabilities.mapModes,
    activeLayers,
    level,
    scrubbing,
    bivariateEligible,
    bivariateActive,
    bivariateMode,
    bivariateDegenerate,
    bivariateDegenerateReason,
    bivariatePair,
    percapitaActive,
    percapitaMode,
    percapitaEligible,
    percapitaLayersEligible,
    percapitaHasCensus: percapitaCensusMeta !== null,
  });
  const bivariateControl = (
    <ModeSwitcher
      options={mapModeModel.options}
      value={mapModeModel.value}
      onChange={(id) => {
        setBivariateMode(id === "bivariate");
        setPercapitaMode(id === "percapita");
      }}
      heading="Modo del mapa"
      sub={mapModeModel.sub}
      note={mapModeModel.note}
    />
  );

  // task #38 v3 rail — the active vista name (shown once) + the Filtro badge.
  const vistaName = activeVistaName(activePresetId);
  const activeLayerIds = PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id);
  const filtroBadge = countFiltroModifiers({
    activeLayerIds,
    presetId: activePresetId,
    baseLayerId: captionLayer?.id ?? null,
    activePeriod: periodParam,
    verifiedOnly,
  });
  const timelineActive = dockOpen && dockTab === "timeline";

  // task #55 — "Informe de situación": the print-ready operator briefing. A PURE
  // projection of the CURRENT view (same `(view, data) → render` discipline as
  // the map + strip + ranking) — no new fetch, every number already computed and
  // privacy-suppressed by the console above. The plain-language pieces reuse the
  // existing helpers: explainViewState for the one-line summary, captionFor for
  // the map caption, and the KPI ⓘ definitions for the method footnotes. Honesty
  // invariants live inside buildInformeModel. E1 adds the view's own URL.
  const informeCaption = bivariateActive
    ? bivariateCaptionText(bivariatePair)
    : captionLayer
      ? percapitaActive && percapitaCensusMeta
        ? `${captionFor(captionLayer, level, captionPeriod, { perCapita: true, presetId: periodParam })} ${percapitaFooterLabel(percapitaCensusMeta)}.`
        : captionFor(captionLayer, level, captionPeriod, { presetId: periodParam })
      : null;
  const informeModel = useMemo(
    () =>
      buildInformeModel({
        scopeLabel: viewMeta.scopeLabel,
        periodLabel: viewMeta.periodLabel,
        asOf,
        cubeBuiltAt: viewMeta.cubeBuiltAt,
        generatedAt: informeGeneratedAt,
        viewUrl: typeof window === "undefined" ? null : window.location.href,
        isDemo: demoNotice != null,
        viewSummary: explainViewState(viewState, {
          provinceLabel: (code) =>
            allowedProvinces?.find((p) => p.code === code)?.name ??
            provinceByCode(code)?.name ??
            code,
          localityLabel: (_province, locality) =>
            scopeData.localities.find((l) => l.slug === locality)?.name ?? locality,
          // Finding #1: the printed informe scope line stays honest too — the govt
          // jurisdiction override / the admin department-grain qualifier.
          boundedScopeLabel: boundedJurisdiction ? (scopeLabel ?? undefined) : undefined,
          renderLevel: level,
        }),
        kpis: readingKpis,
        kpisDegraded,
        // P2: the printed informe drops the ranking SECTION entirely when the
        // structure is empty-by-absence — a briefing with a headed table and no
        // rows is the paper version of the skeleton P2 forbids. `suppressed`
        // and `data` both keep the section (the suppression note is mandatory).
        ranking:
          effectiveRankingKind !== null && rankingLayer !== null && !rankingStructureHidden
            ? {
                rows: rankedRows,
                kind: effectiveRankingKind,
                measureLabel: rankingMeasureLabel,
                smallScope: rankingSmallScope,
                unitNoun: rankingUnitNoun,
                suppressedCount: dockSuppressedCount,
                unavailable: rankingDataUnavailable,
                // Finding 4 — the printed informe and the dock ranking are one
                // projection; both drop "Peores" when the order is by volume.
                orderedByVolume: rankLocalityRateCount,
              }
            : null,
        caption: informeCaption,
        activeLayerLabels: activeLayers.map((l) => l.label),
        suppressedTotal: viewMeta.suppressedCount,
        // V2: the briefing is the artifact with room for the FULL descriptor —
        // the PNG carries only its digest, the CSV a header block.
        viewScope,
      }),
    [
      viewMeta,
      viewScope,
      asOf,
      informeGeneratedAt,
      demoNotice,
      viewState,
      allowedProvinces,
      scopeData.localities,
      readingKpis,
      kpisDegraded,
      effectiveRankingKind,
      rankingLayer,
      rankedRows,
      rankingMeasureLabel,
      rankingSmallScope,
      rankingUnitNoun,
      dockSuppressedCount,
      rankingDataUnavailable,
      rankingStructureHidden,
      rankLocalityRateCount,
      informeCaption,
      activeLayers,
      boundedJurisdiction,
      scopeLabel,
      level,
    ],
  );

  // Stamp the generation time at click, then defer window.print() so the click
  // handler returns before the (synchronous) print dialog — the INP mitigation
  // the deferPrint helper exists for. The always-mounted informe node (rendered
  // below, display:none on screen) is revealed by its own `@media print` sheet.
  const handlePrintInforme = useCallback(() => {
    setInformeGeneratedAt(new Date());
    deferPrint();
  }, []);

  // The 7 rail items, top-to-bottom (spec item 1). Panels open the ONE uniform
  // RailPanel; actions fire immediately.
  const railItems: RailItem[] = [
    {
      id: "vista",
      icon: "vista",
      label: "Vista",
      kind: "panel",
      // panorama QA root-cause #2: no Simple/Detalle toggle — always full detail.
      // (The preset description/question line stays OUT regardless: PO
      // screenshot fix 2026-07-09 — "feat(panorama): simplify header, vista
      // cards, and simple-mode capas" — deleted it from both the parent
      // headline and the per-card body; it must never render again, per
      // PanoramaConsole.test.tsx "PO screenshot fix (2026-07-08)".)
      detail: true,
      render: () => (
        <div className="space-y-2">
          <PresetPanel
            presets={PANORAMA_PRESETS}
            activePresetId={activePresetId}
            onPreset={(id) => {
              onPreset(id);
              setRailOpen(null);
            }}
            layout="list"
            labelledBy="panorama-vista-label"
          />
          <p id="panorama-vista-label" className="sr-only">
            Vista
          </p>
          {/* D1 metric selector: only a metric-selector vista (cumplimiento)
              offers it. Switching metric keeps the active preset id and swaps
              base/metrics/URL layers through the same applyPreset commit. */}
          {activePreset?.metricOptions ? (
            <ComplianceMetricSelector
              options={activePreset.metricOptions}
              activeMetric={activeMetricOption?.metric ?? activePreset.metricOptions[0].metric}
              onSelect={(metric) => {
                applyPreset(activePreset.id, "push", { metric });
                setRailOpen(null);
              }}
            />
          ) : null}
        </div>
      ),
    },
    {
      // H11 (cowork QA): this funnel opened a LAYER selector (capas on/off, opacity,
      // verified-only) — NOT attribute filters. The "Filtro" name + funnel icon
      // promised severity/status filtering that does not exist (deferred to #44), so
      // rename to the honest "Capas" with a layers icon. `filtro` id/state names are
      // internal (English) and unchanged.
      id: "filtro",
      icon: "capas",
      label: "Capas del mapa",
      kind: "panel",
      badge: filtroBadge,
      // Item 3: the badge counts MODIFIERS over the vista, not layers — name that
      // so the bare number stops reading as a layer count.
      badgeLabel: filtroBadgeAriaLabel(filtroBadge),
      // Cowork QA ronda 3 §2 (C9, P3.6): the Simple/Detalle toggle was removed
      // from Vista/Período/Exportar/Acerca but still lingered here and on the
      // scrubber — an inconsistent control (same label, different behavior per
      // panel). The PO's preference is fewer toggles / show detail, so Capas now
      // always renders full detail (per-layer measure, counts, opacity, verified)
      // with no toggle — matching the other rail panels.
      detail: true,
      render: () => (
        <div className="space-y-2">
          {/* Item 3: the panel header surfaces BOTH facts, each labelled — the
              real active-layer count AND the modifiers-over-the-vista count — so
              the tab badge's bare number is never read as a layer count. */}
          <p className="text-xs text-ln-op-mute">
            {describeCapasMeta({
              activeLayerCount: activeLayers.length,
              modifierCount: filtroBadge,
            })}
          </p>
          <FiltroPanel
            states={states}
            onToggle={onToggle}
            detail={true}
            presetId={activePresetId}
            scrubbing={scrubbing}
            opacities={opacities}
            onOpacity={onOpacity}
            verifiedOnly={verifiedOnly}
            onToggleVerified={onToggleVerified}
            lodRollupHints={lodRollupHints}
            presetRelevantLayerIds={presetRelevantLayerIds}
          />
        </div>
      ),
    },
    {
      id: "periodo",
      icon: "periodo",
      label: "Período",
      kind: "panel",
      // panorama QA root-cause #3a: no Simple/Detalle toggle — always show
      // every period option (incl. Personalizado).
      detail: true,
      render: () => (
        <PeriodPanel
          activePeriod={periodParam}
          detail={true}
          from={fromParam ?? null}
          to={toParam ?? null}
          onPeriodChange={commitPeriod}
          // T2.6: an all-current-state board ignores the período — the panel
          // says so instead of showing a selected window (ONE clock per screen,
          // same rule buildViewMeta and the view card already read).
          currentStateOnly={layerIdsAreAllCurrentState(activeLayerIdList)}
        />
      ),
    },
    {
      id: "timeline",
      icon: "linea-tiempo",
      label: "Línea de tiempo",
      kind: "action",
      active: timelineActive,
      onClick: () => {
        if (timelineActive) {
          setDockOpen(false);
        } else {
          setDockTab("timeline");
          setDockOpen(true);
        }
      },
    },
    {
      id: "exportar",
      icon: "exportar",
      label: "Exportar",
      kind: "panel",
      // panorama QA root-cause #5: no Simple/Detalle toggle — always show every
      // action, each with its clarification note directly below its button.
      detail: true,
      render: () => (
        <div className="space-y-3">
          {/* P5: what the shared link reproduces, in words (explainViewState). */}
          <p className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-2.5 py-2 text-xs leading-snug text-ln-op-ink-2">
            {viewExplanation}
          </p>
          <div className="space-y-1">
            <button
              type="button"
              onClick={copyView}
              className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ln-op-ink hover:bg-ln-op-stripe"
            >
              <Icon name="enlace" size="sm" decorative /> Copiar vista
              {copied && <span className="text-xs text-ln-op-ok">· copiada</span>}
            </button>
            <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
              Copia un enlace con la vista, el alcance y el período actuales.
            </p>
          </div>
          {/* "Citar esta vista" v1 — ONE terse action: pin + copy. It does NOT
              open the print dialog itself: the live→pinned flip refetches the
              as-of frame asynchronously, and printing in the same click would
              put live-path numbers under a "Situación al" header. The note
              routes the operator to "Informe de situación" below for the
              printed artifact (which now carries the provenance disclosure). */}
          <div className="space-y-1">
            <OpButton
              variant="ghost"
              size="sm"
              block
              onClick={citeView}
              className="justify-start gap-2"
            >
              <Icon name="enlace" size="sm" decorative /> Citar esta vista
              {cited && <span className="text-xs font-normal text-ln-op-ok">· enlace copiado</span>}
            </OpButton>
            <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
              Fija el corte temporal de la cita en el enlace y lo copia: al reabrirlo se reproduce
              el registro a esa fecha. Para el artefacto impreso, generá el «Informe de situación»
              (lleva la constancia de la cita al pie).
            </p>
          </div>
          {/* "Vistas guardadas" is a POPOVER with its own open state: mounted here
              AND in the ContextBar it would be two instances of one control. It
              lives in the bar; the rail stays a complete index by saying so. */}
          <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
            Las vistas guardadas — tableros con nombre para volver a ellos rápido — están en la
            barra de contexto, arriba del mapa.
          </p>
          {/* C5: the three data/capture exports consolidated here (was: CSV in the
              dock bar, PNG + informe here) — one place, each with an honest note
              of exactly what it captures. The dock bar no longer carries its own
              scattered "Exportar CSV". */}
          <div className="space-y-0.5 border-t border-ln-op-line-2 pt-2">
            <p className="px-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-ln-op-faint">
              Descargas
            </p>
          </div>
          <div className="space-y-1">
            {dockCsvHref !== null ? (
              <a
                href={dockCsvHref}
                download="panorama-mapa.csv"
                // Cowork B7: the download fired in silence. Confirm it with the
                // repo's standard sonner toast (Toaster is mounted in the root
                // layout), so the operator knows the export started.
                onClick={() => toast.success("Descarga iniciada: panorama-mapa.csv")}
                className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ln-op-ink hover:bg-ln-op-stripe"
              >
                <Icon name="descargar" size="sm" decorative /> Exportar CSV
              </a>
            ) : (
              <span className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ln-op-faint">
                <Icon name="descargar" size="sm" decorative /> Exportar CSV
              </span>
            )}
            <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
              {dockCsvHref !== null
                ? "Descarga la tabla de datos por unidad (la misma de Registros) en CSV."
                : "No hay datos por unidad para exportar en esta vista."}
            </p>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => exportPngFnRef.current?.()}
              className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ln-op-ink hover:bg-ln-op-stripe"
            >
              <Icon name="exportar-imagen" size="sm" decorative /> Exportar PNG
            </button>
            <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
              Captura el mapa como imagen, con una nota de método al pie.
            </p>
          </div>
          <div className="space-y-1">
            <button
              type="button"
              onClick={handlePrintInforme}
              className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-sm text-ln-op-ink hover:bg-ln-op-stripe"
            >
              <Icon name="nota" size="sm" decorative /> Informe de situación
            </button>
            <p className="px-2.5 text-xs leading-snug text-ln-op-mute">
              Genera un informe imprimible de la vista actual (indicadores, ranking y método) para
              imprimir o guardar como PDF.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "actualizar",
      icon: "actualizar",
      label: refreshing ? "Actualizando…" : "Actualizar",
      kind: "action",
      disabled: refreshing || kpisPending,
      onClick: onRefresh,
    },
    {
      id: "acerca",
      icon: "acerca",
      label: "Acerca",
      kind: "panel",
      // panorama QA root-cause #6: no Simple/Detalle toggle — always full detail.
      detail: true,
      render: () => (
        <div className="space-y-2 text-sm text-ln-op-mute">
          <p className="max-w-prose">
            Mapa situacional por capas sobre el registro de eventos. Las superficies de detalle
            (mortalidad, vigilancia, pérdidas) viven como capas de esta misma vista.
          </p>
          {demoNotice}
          {aboutSlot}
          <PanoramaKpiFooter
            kpis={kpis}
            pending={kpisPending}
            cubeBuiltAt={seedCubeBuiltAt}
            truncatedLayers={mapTableTruncatedLayers}
          />
        </div>
      ),
    },
  ];

  // ── ContextBar (2026-08-01) ───────────────────────────────────────────────
  // The sticky one-line answer to "¿qué estoy mirando y de qué período?". It
  // COMPOSES; it never forks — each segment's body is the rail item's OWN
  // `render()` closure (see context-bar-model.ts), so there is one definition
  // and, because `panelOpen` is one state with an anchor, one live instance
  // whichever trigger opened it.
  const contextSegments = buildContextSegments({
    railItems,
    periodLabel: viewMeta.periodLabel,
    activeLayerCount: activeLayers.length,
    modifierCount: filtroBadge,
  });

  // The scope segment — relocated from the top-left cluster, not rewritten (see
  // ScopeDisclosure.tsx: same disclosure, same testid, same closed-by-default
  // panel, PO 2026-07-29). It reads the shared `panelOpen` state.
  const scopeDisclosure =
    scopeLabel !== undefined || allowedProvinces !== undefined || filtersSlot !== undefined ? (
      <ScopeDisclosure
        // scope-truth.ts is the ONE cascade. `viewMeta.scopeLabel` is its output,
        // and it is what the Registros caption, the dock meta, the PNG footer and
        // the informe already cite — the pill joins them instead of hand-copying
        // `liveScopeLabel || "Nacional"` a fifth time.
        scopeLabel={viewMeta.scopeLabel}
        open={barOpen === "alcance"}
        onOpenChange={(next) => {
          // Guarded: a scope commit fires this with `false`, and it must not
          // reach in and close a rail panel it never owned.
          if (next) setBarOpen("alcance");
          else if (barOpen === "alcance") setBarOpen(null);
        }}
        closeSignal={`${effectiveScopeProvince ?? ""}|${effectiveScopeLocality ?? ""}`}
        allowedProvinces={allowedProvinces}
        localities={scopeData.localities}
        selectedProvince={effectiveScopeProvince}
        selectedLocality={effectiveScopeLocality}
        onScopeCommit={onSwitcherScopeCommit}
        filtersSlot={filtersSlot}
      />
    ) : null;

  return (
    // `panorama-console-root`: print hook. Under print media the informe's sheet
    // hides every sibling of the briefing here — `visibility: hidden` left the
    // map and masthead reserving their flex boxes, which pushed the informe down
    // and off the page (PRN-3).
    <div className="panorama-console-root flex min-h-0 flex-1 flex-col">
      {/* task #55 — the print-only "Informe de situación". Mounted ONLY once the
          operator generates it (handlePrintInforme sets the stamp, then defers
          window.print() via setTimeout(0) — React commits this node before the
          timer fires). Keeping it unmounted until then avoids duplicating the
          KPI/ranking labels in the DOM (a11y-tree + test-query pollution). It is
          display:none on screen; its own `@media print` sheet hides the live
          console and reveals only this briefing when printing. */}
      {informeGeneratedAt !== null && <PanoramaInformeSituacion model={informeModel} />}
      {/* v2C masthead — the ONLY fixed row of the console (spec: everything else
          floats over the map). Title + "Acerca" popover on the left; fresh chip
          + Actualizar on the right. The SCOPE pill moved into the floating
          top-right cluster over the map (it is the keyboard path to the
          jurisdiction menu). Rendered only when the caller passes `scopeLabel`
          (the pages always do; unit/embedding callers that omit it keep no
          masthead). */}
      {!presentationMode && scopeLabel !== undefined && (
        <header className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ln-op-line bg-ln-op-card px-4 py-1.5">
          {/* Finding #1: the title must reflect the REAL projection geography. A
              bounded (govt) operator is NOT national — name their jurisdiction
              (the honest server scopeLabel) instead of "Nacional". Admin/universal
              keeps "Nacional". Display-only; the data scope is server-enforced. */}
          <h2 className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-ink-2">
            {boundedJurisdiction
              ? `Centro de Situación · ${scopeLabel}`
              : "Centro de Situación Nacional"}
          </h2>
          {/* task #38 v3: "Acerca de esta vista" (methodology + demo + KPI footer)
              and "Actualizar" moved into the floating rail (Acerca / Actualizar
              icons). The masthead keeps only the identity line + the honesty
              signals (demo pill + data-freshness chip). */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* Compact always-visible demo pill (the full disclosure lives in the
                "Acerca" popover) — the honesty signal never scrolls away because
                nothing scrolls, but it must also never be hidden behind a click. */}
            {demoNotice != null && (
              <span
                className="rounded-full border border-ln-op-warn-bd bg-ln-op-warn-bg px-2 py-0.5 text-xs font-medium text-ln-op-ink-2"
                title="El dataset cargado es sintético (densidad ponderada por Censo 2022); no representa casos reales."
              >
                Datos de demostración
              </span>
            )}
            {/* H7 (cowork QA): this chip is the LAST EVENT in the active alcance,
                not a data-freshness watermark — it legitimately changes when the
                scope changes (a smaller alcance has an older last event). Labeled
                "Último evento en el alcance" so it never reads as "Salta tiene datos
                más viejos".
                T4.7 (2026-08-01): rendered ungated, `kpis.dataAsOf` still held the
                PREVIOUS scope's last event while a scope/period refetch was in
                flight — the chip's own title promises "el alcance seleccionado",
                so showing the OLD alcance's stamp during that window is a lie of
                omission. Gate like the scrubber watermark (~3673): hide while a
                fetch owns the strip (kpisPending) or a scope change is in flight
                (kpisScopeChanging, from use-panorama-kpis). */}
            {kpis.dataAsOf && !kpisPending && !kpisScopeChanging && (
              <span
                suppressHydrationWarning
                title="Fecha y hora del evento más reciente dentro del alcance seleccionado (no es la frescura general de los datos). No cambia al mover la línea de tiempo."
                className="rounded-full border border-ln-op-line bg-ln-op-card px-2.5 py-0.5 text-xs tabular-nums text-ln-op-mute"
              >
                Último evento en el alcance:{" "}
                {new Date(kpis.dataAsOf).toLocaleString("es-AR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                  timeZone: AR_TIME_ZONE,
                })}
              </span>
            )}
          </div>
        </header>
      )}
      {/* ABOVE the map region on purpose, not floating over it: the one line a
          decision maker must never hunt for must also not cover the territory it
          describes. As a flex SIBLING of the map container it leaves every
          absolute overlay coordinate (rail, KPI cluster, legend, dock) untouched
          — MapLibre sizes once at mount and never re-layouts when a panel opens
          (spec no-negociable #4). */}
      {!presentationMode && (
        <ContextBar
          segments={contextSegments}
          open={barOpen}
          onOpenChange={setBarOpen}
          leading={scopeDisclosure}
          onCopyView={copyView}
          copied={copied}
          savedViews={<SavedViewsPopover />}
        />
      )}
      {/* v2C body: ONE map region — the map fills everything below the masthead
          and every other control floats over it as an absolute overlay
          (`relative` here is their positioning ancestor). Expanding the dock,
          opening menus or switching views never re-layouts MapLibre (spec
          no-negociable #4). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MapErrorBoundary key={mapReloadKey} onReset={() => setMapReloadKey((k) => k + 1)}>
          <SituationalMapDynamic
            layers={mapLayers}
            label={mapLabel}
            fill
            aggregationLabel={aggregationLabel}
            // task #38 v3: the console owns all chrome now (the floating vertical
            // rail + the top-left scope pill / KPI cluster). The map renders no
            // legacy toolbar and no top-right briefing card; it only hands its
            // map-coupled exportPng up for the "Exportar" rail panel.
            overlayChrome
            registerExportPng={registerExportPng}
            onDivisionLegendChange={setDivisionLegend}
            onGraduatedScaleChange={setGraduatedScale}
            onProvinceSeqLegendChange={setProvinceSeqLegend}
            onFeatureClick={onFeatureClick}
            onProvinceDrill={canDrillProvince ? onProvinceDrill : undefined}
            onReturnNational={canReturnNational ? onReturnNational : undefined}
            initialBounds={initialBounds}
            boundedJurisdiction={boundedJurisdiction}
            frameProvinceOnLoad={frameProvinceOnLoad}
            rateProvinceOnlyEmpty={rateProvinceOnlyEmpty}
            layerDegraded={degradedLayerLabels.length > 0}
            detailKAnonSuppressed={dockSuppressedCount > 0}
            allSuppressedNotice={allSuppressedNotice}
            selectedProvinceCode={selectedProvinceCode}
            selectedLocalityCenter={selectedLocalityCenter}
            frame={presetFrame}
            onZoom={onMapZoom}
            initialCamera={initialCamera}
            onCameraChange={onCameraChange}
            highlightedUnitKey={highlightedUnitKey}
            onUnitHover={setHighlightedUnitKey}
            viewMeta={viewMeta}
          />
        </MapErrorBoundary>
        {/* H12: loading skeleton over the map — a shimmer + honest cue while the
            first bubbles fetch, so a direct-URL entry never reads as a blank map.
            pointer-events-none so it never blocks the map underneath; cleared the
            instant features paint. */}
        {showMapSkeleton && (
          <div
            aria-busy="true"
            aria-live="polite"
            className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-ln-op-card/45 backdrop-blur-[1px]"
          >
            <span className="animate-pulse rounded-full border border-ln-op-line bg-ln-op-card/95 px-4 py-1.5 text-sm font-medium text-ln-op-mute shadow-sm">
              Cargando el mapa…
            </span>
          </div>
        )}
        {/* P5 presentation mode (#32 gift): the dock is chrome — hidden. */}
        {!presentationMode && (
          <PanoramaDock
            open={dockOpen}
            onOpenChange={setDockOpen}
            tab={dockTab}
            onTabChange={setDockTab}
            recordCount={dockBadgeCount}
            meta={dockMeta}
            // C5: CSV export moved into the consolidated "Exportar" rail section
            // (with PNG + informe) — the dock bar no longer carries its own button.
            registros={dockRegistros}
            stats={dockStats}
            referencias={dockReferencias}
            timeline={scrubberDock}
            timelinePlaying={scrubberPlaying}
            // Q6/P3.3: the full warning renders inside `scrubberDock`
            // (PanoramaBoardNotices), reachable only on the Línea de tiempo
            // tab — surface its existence on the bar the rest of the time.
            hasUnknownLayerNotice={droppedLayerIds.length > 0}
          />
        )}
        {/* task #38 v3 top-LEFT cluster: the floating scope pill (THE keyboard
            path to the jurisdiction menu — NOT in the rail, per spec), the vista
            name stated ONCE (de-dup), then the KPI cards, stale notice and the
            bivariate encoding toggle. The rail owns the right edge. Absolute —
            never re-layouts the map. Narrows below 2xl so 1366 releases the map
            center. */}
        {/* P5 presentation mode (#32 gift): the whole top-left cluster is chrome. */}
        {!presentationMode && (
          <div className="absolute left-3.5 top-3.5 z-10 w-64 max-w-[calc(100%-1.75rem)] 2xl:w-72">
            {/* #53 QOL — ONE consolidated card (scope → vista → indicadores →
                modo): the old stack was 4-5 independently-shadowed floating
                surfaces competing over the map. The container is now the single
                elevated surface; everything inside sits flat (borders, no own
                shadows). Hierarchy reads top-down: WHERE (alcance) → WHAT
                question (vista) → the NUMBERS → HOW the map paints (modo). */}
            <div className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card p-2.5 shadow-lg">
              {/* WCAG 4.1.3: polite live region announcing the committed scope — the
                scope pill's one keyboard commit path was otherwise silent to AT. */}
              <p aria-live="polite" className="sr-only" data-testid="panorama-scope-live">
                {scopeAnnouncement}
              </p>
              {/* The scope pill MOVED (2026-08-01) into the sticky ContextBar
                  above the map — see ScopeDisclosure.tsx. Leaving a copy here
                  would have added a place to hunt, not removed one. */}
              {/* #53 QOL — the vista, named ONCE (the standalone shadowed pill is
                  gone; the dock meta / caption serve other surfaces). */}
              {vistaName && (
                <p className="text-xs text-ln-op-mute">
                  Vista · <span className="font-semibold text-ln-op-ink-2">{vistaName}</span>
                </p>
              )}
              {/* The trimmed view sentence that lived here (2026-07-21, re-trimmed
                  2026-07-26) is GONE as of 2026-08-01 — the last survivor of the
                  "state the view four times" era. The ContextBar above the map
                  states scope, period and layer count once; this line restated
                  the period and the layers beside truncated KPI numbers. */}
              {/* Board-state notices (T1.6 restored / T2.7 period reset / #53
                  personalizada) — ConsoleNoticeStack caps the stack at one
                  visible notice with a "+N avisos" expander (WP2). */}
              <ConsoleNoticeStack
                restored={restoredBoardNotice}
                onDismissRestored={() => setRestoredBoardNotice(false)}
                periodResetLabel={periodResetNotice}
                onDismissPeriodReset={() => setPeriodResetNotice(null)}
                personalizadaLabel={
                  personalizadaFrom !== null && activePresetId === null
                    ? (getPreset(personalizadaFrom)?.label ?? personalizadaFrom)
                    : null
                }
                onVolver={() => {
                  if (personalizadaFrom !== null) {
                    // F2: return to the metric the operator LEFT, not the default.
                    applyPreset(
                      personalizadaFrom,
                      "replace",
                      personalizadaMetric !== null ? { metric: personalizadaMetric } : undefined,
                    );
                  }
                }}
                onDismissPersonalizada={() => setPersonalizadaFrom(null)}
              />
              <KpiChips
                kpis={kpis}
                metricIds={metricIds}
                presetId={activePresetId}
                // C2a: manual mode (no preset) shows only KPIs whose subject
                // layer is painted; the rest hide behind "Ver todos". Preset
                // mode ignores this (metricIds drives the curated set).
                activeLayerIds={activeLayerIdList}
                pending={kpisPending}
                // T2.1: during a time scrub the held numbers are the previous
                // frame's — stamp the strip with the target day being computed.
                pendingAsOfLabel={asOf ? formatAsOfDayLong(asOf) : null}
                // Q13: a scope/period drill makes the held numbers wrong for the
                // new jurisdiction — blank (aria-busy) instead of holding them.
                scopeChanging={kpisScopeChanging}
                degraded={kpisDegraded}
                // P2.4 (C2): while the scrubber is off the live edge, emphasize the
                // "estado actual" tag on stock KPIs so their frozen big number reads
                // as intentional, not stuck. Temporal KPIs (no currentState) untouched.
                temporalFrameActive={scrubbing}
              />
              {/* Finding #3: the KPIs summarize the SCOPE TOTAL, but the map has
                  disaggregated to a finer grain — say so, so a national/province
                  number over a department map never reads as incoherent. Matches
                  the on-map aggregation badge so label = number = map. */}
              {kpiScopeCoarserThanMap && (
                <p className="text-xs leading-snug text-ln-op-faint">
                  Indicadores: total del alcance ({liveScopeLabel || "Argentina"}). El mapa muestra
                  el detalle por {aggregationLabel.toLowerCase()}.
                </p>
              )}
              {kpisStale && (
                // error-path audit 2026-07-04 finding E5: the KPI refetch failed and
                // the cards show the last-known numbers, not live ones — say so.
                <output
                  aria-live="polite"
                  className="block rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-xs text-ln-op-warn"
                >
                  No pudimos actualizar los indicadores. Mostrando los últimos valores conocidos.
                </output>
              )}
              {/* task #63 encoding, #24 switcher: the "Modo" map control. */}
              {bivariateControl}
            </div>
          </div>
        )}
        {/* task #38 v3 — the vertical modifier rail (right edge of the map). */}
        {!presentationMode && (
          <PanoramaRail items={railItems} open={railOpen} onOpenChange={setRailOpen} />
        )}
        {/* v2C single-line legend pill (bottom-left, above the dock bar): base
            label + classed ramp + per-layer dots + the ALWAYS-VISIBLE k-anon
            pill. Expands upward into caption + honesty notices + the one-line
            auto-reading; the full MapLegends reading itself now lives in the
            dock's Referencias tab (dock redesign, PO ask), not in this panel. */}
        <div
          className={`absolute left-3.5 z-10 max-w-[calc(100%-1.75rem)] ${
            // P5 presentation mode: the dock bar is hidden, so the legend pill
            // drops to the map edge instead of floating above a bar that isn't there.
            presentationMode ? "bottom-3.5" : "bottom-16"
          }`}
        >
          {/* C1 — the perennial "¿qué estoy viendo y de dónde son estos datos?"
              answer USED to float here as its own ViewCaption strip (line-clamped
              behind a "Ver más"). PO decision (panorama polish 2026-07-21): folded
              into the "Vista · X" header over the map instead (fully visible, no
              clamp) — decluttering this map-edge surface; the legend pill still
              owns the encoding detail below it. */}
          <LegendPill
            baseLabel={legendRampLabel}
            rampColors={legendRampColors}
            rampEndpoints={legendRampEndpoints}
            bivariate={bivariateActive}
            // The ACTIVE pair's axes, never a literal (bivariate.ts).
            bivariateAxes={bivariateAxesLabel(bivariatePair)}
            graduatedHint={legendGraduatedHint}
            layerDots={legendLayerDots}
            // Same atoms + same inputs MapLegends gets (mapLayers + the lifted
            // divisionLegend), so the strip and the Referencias tab can never
            // disagree about the hatch. Not `suppressedCount` — see LegendPill.
            suppressedInFrame={frameHasSuppressedMark(mapLayers, divisionLegend)}
          >
            <div className="space-y-2.5">
              {/* k-anon disclosure — the full per-layer suppression counts. */}
              <PanoramaSuppressionNotice states={states} />
              {/* Honesty (panorama QA 2026-07-14): a budget-degraded layer says so. */}
              {degradedLayerLabels.length > 0 && (
                <output
                  aria-live="polite"
                  className="block rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-xs text-ln-op-warn"
                >
                  No pudimos calcular a tiempo: {degradedLayerLabels.join(", ")}. Tocá Actualizar
                  para reintentar.
                </output>
              )}
              {/* panorama-ia-v2 §2.4: plain-language caption — what a map mark
                  means at the active VISTA + derived level. Under the bivariate
                  encoding it explains the 3×3 matrix + tercile method instead. */}
              <LegendCaptionBlock
                bivariate={bivariateActive}
                bivariatePair={bivariatePair}
                bivariateCaption={bivariateCaptionText(bivariatePair)}
                paintsHatch={frameHasSuppressedMark(mapLayers, divisionLegend)}
                captionProps={{
                  layer: captionLayer,
                  level,
                  period: captionPeriod,
                  perCapita: percapitaActive,
                  presetId: periodParam,
                }}
                perCapitaFooter={
                  percapitaActive && percapitaCensusMeta
                    ? percapitaFooterLabel(percapitaCensusMeta)
                    : null
                }
              />
              {/* WARNING 6: honest note when the color scale is anchored to a
                  shared link's day. Shown whenever anchored — P1.1: on entry too. */}
              {scaleAnchoredToAsOf && (
                <p className="text-xs leading-snug text-ln-op-mute" aria-live="polite">
                  Escala de color anclada a este día (se abrió desde un enlace con fecha). Volvé al
                  último evento para fijarla al borde en vivo.
                </p>
              )}
              {/* The full scale legends (province ramp / division fill / graduated
                  circles / bivariate 3×3) moved into the dock's Referencias tab
                  (dock redesign, PO ask) — LegendPill keeps the glance-decode
                  only; the full reading now lives one tab away, not one more
                  click down inside this same disclosure. */}
              {/* panorama-event-points: honest points-mode disclosure. P4b: shown
                  while some active layer is in its NEAR band (declaration-driven). */}
              {activePointsLayerIds !== "" && Object.keys(pointsInfo).length > 0 && (
                <output
                  aria-live="polite"
                  className="block space-y-1 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-xs text-ln-op-ink-2"
                >
                  {Object.entries(pointsInfo).map(([id, info]) => (
                    <p key={id}>{pointsDisclosureLine(id as LayerId, info)}</p>
                  ))}
                </output>
              )}
              {/* One-line auto-reading (narration LAST — monitoring order). */}
              <PanoramaReading
                kpis={readingKpis}
                stale={kpisStale}
                pending={kpisPending}
                degraded={kpisDegraded}
              />
            </div>
          </LegendPill>
        </div>
      </div>
      <DetailDrawer selected={selected} periodLabel={viewMeta.periodLabel} onClose={closeDrawer} />
    </div>
  );
}
