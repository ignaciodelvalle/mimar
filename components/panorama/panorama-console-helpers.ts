// PanoramaConsole — module-level helpers, types, and constants.
//
// Extracted mechanically from PanoramaConsole.tsx (file-size split, behavior-
// preserving): everything here is standalone (no closure over component
// state) and unchanged, only moved. PanoramaConsole.tsx re-exports `SeededLayer`
// so external imports keep working unchanged.

import type { ReactNode } from "react";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import type { LocalityCentroids } from "@/lib/infra/ar-localidades";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";
import { replaceMapStateUrl } from "@/lib/ui/map-layer-nav";
import type { ViewScopeAuthority } from "@/lib/ui/view-scope-descriptor";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { periodDaysPhrase } from "@/src/modules/panorama/domain/caption";
import {
  CHOROPLETH_LAYERS,
  PANORAMA_LAYERS,
  getLayer,
  isAggregatedPointLayer,
} from "@/src/modules/panorama/domain/layers";
import {
  type PanoramaPreset,
  type PresetId,
  getPreset,
} from "@/src/modules/panorama/domain/presets";
import { formatAsOfDayLong } from "@/src/modules/panorama/domain/time-scrub";
import type {
  AggregationLevel,
  FeatureCollection,
  LayerId,
} from "@/src/modules/panorama/domain/types";
import { layerIdsAreAllCurrentState } from "@/src/modules/panorama/domain/view-state-caption";

export const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

// panorama-redesign Fase 1: trailing debounce for the preset-commit layer
// fetch. Rapid preset clicks coalesce into ONE fetch burst (the last click);
// the state flips + shallow URL push stay synchronous for instant feedback.
export const PRESET_FETCH_DEBOUNCE_MS = 200;

/** True when the error is a fetch cancellation (superseded request, NOT a
 * failure). Every catch on an abort-wrapped path MUST early-return on this —
 * running the failure branch would deactivate the layer on every superseded
 * fetch (design-mandated correctness rule, panorama-redesign Fase 1). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export const initialState = (): Record<LayerId, LayerPanelState> => {
  const out = {} as Record<LayerId, LayerPanelState>;
  for (const l of PANORAMA_LAYERS) {
    out[l.id] = {
      active: false,
      loading: false,
      count: 0,
      suppressedCount: 0,
      noLocalityCount: 0,
      truncated: false,
    };
  }
  return out;
};

export type ApiResponse = {
  features: FeatureCollection;
  truncated: boolean;
  suppressedCount: number;
  noLocalityCount: number;
  level?: AggregationLevel;
  // panorama-event-points Slice 1: present only on a server-authorized points
  // response ("points"); undefined/absent on the aggregated path.
  mode?: "points" | "aggregated";
  sinUbicacionCount?: number;
  /** Honesty (panorama QA 2026-07-14): the server returned its budget/failure
   *  fallback — an empty that must never read as a real "sin datos". */
  degraded?: boolean;
  /**
   * task panorama-bivariate-2026-07-21: province-grain, k=5-suppressed fallback
   * for the bivariate "riesgo de brotes" join's signal axis. Present only on the
   * zoonosis response at `level=province` (the national overview); undefined
   * everywhere else. See `LayerFeaturesResult.bivariateSignal` server-side jsdoc.
   */
  bivariateSignal?: FeatureCollection;
};

// The two choropleth layer ids — the only layers the aggregation level affects.
export const CHOROPLETH_IDS = new Set<LayerId>(CHOROPLETH_LAYERS.map((l) => l.id));

/**
 * A layer envelope the SERVER seeded for the first-visit fast path (perf plan
 * commit 1.2). Matches the exact per-layer shape the console stores: the
 * FeatureCollection plus the k-anon disclosure counts. On a truly-first visit
 * the page resolves the role-default preset, fetches ALL its layers (cached),
 * and hands them down here so the console paints on first render with ZERO
 * client fetches — instead of the client clearing caches and re-fetching.
 */
export type SeededLayer = {
  id: LayerId;
  features: FeatureCollection;
  truncated: boolean;
  suppressedCount: number;
  noLocalityCount: number;
};

/**
 * True when a layer's features at `level` live in the PROVINCE cache
 * (provinceDataRef) rather than the locality cache (dataRef). Mirrors the
 * LEVEL half of the cache routing `activeLayers` uses to READ features
 * (choropleth OR aggregated-point layer, at province level). P4b added a second
 * read route — the NATIONAL LOD band — which this seed predicate deliberately
 * ignores: at mount the scope-aware `mapZoom` init keeps the band at `drilled`
 * for a seeded locality view, so seed placement still equals read placement
 * (the C2 level-invariant); post-mount band flips are covered by the
 * national-band cache-warm effect, never by the seed.
 */
export function seededLayerUsesProvinceCache(id: LayerId, level: AggregationLevel): boolean {
  return (CHOROPLETH_IDS.has(id) || isAggregatedPointLayer(id)) && level === "province";
}

// panorama-event-points: per-layer es-AR copy for the honest points-mode
// disclosure. perdidas/mordeduras plot REAL coordinates; denuncias plots the
// coarse LOCALITY CENTROID (never the exact report coordinate).
export function pointsDisclosureLine(
  id: LayerId,
  info: { count: number; truncated: boolean; sinUbicacion: number },
): string {
  const n = info.count.toLocaleString("es-AR");
  const head =
    id === "mordeduras"
      ? `Mordeduras con ubicación real, jurisdicción (${n}).`
      : id === "denuncias"
        ? `Denuncias por localidad, ubicación aproximada (${n}).`
        : `Avistajes con ubicación real (${n}).`;
  const noun = id === "mordeduras" ? "mordeduras" : id === "denuncias" ? "denuncias" : "avistajes";
  const cap = info.truncated ? ` Mostrando los ${n} más recientes.` : "";
  const residual =
    info.sinUbicacion > 0
      ? ` ${info.sinUbicacion.toLocaleString("es-AR")} ${noun} sin ubicación exacta.`
      : "";
  return `${head}${cap}${residual}`;
}

// ---------------------------------------------------------------------------
// map-QOL URL-as-state helpers
// ---------------------------------------------------------------------------

// Params that change WHAT data the server would compute (scope + period).
// The cache-invalidation and KPI-refetch effects key on THIS subset only, so
// the client-only board params (layers/level/preset) written by the shallow
// URL sync never wipe the layer caches or refetch KPIs.
export const SCOPE_PERIOD_KEYS = ["period", "from", "to", "province", "locality"] as const;

export const BOARD_STORAGE_KEY = "panorama:board:v1";

export type SavedBoard = {
  layers: string;
  level: AggregationLevel;
  preset: string | null;
  period: string | null;
  /** P5: the encoding selection (`?encoding=`); optional — older boards lack it. */
  encoding?: string | null;
  /**
   * panorama-vista-redesign Phase 5 (design Decision 5): CapasBox / TimeScrubber
   * Simple-Detalle prefs. OPTIONAL — folded into the EXISTING `panorama:board:v1`
   * key with NO version bump. A pre-redesign v1 entry lacks these fields
   * entirely; `undefined` reads as Simple (false), never a crash.
   */
  capasDetail?: boolean;
  scrubDetail?: boolean;
};

/** The scope+period subset of a query string, in stable key order. */
export function scopePeriodQsOf(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of SCOPE_PERIOD_KEYS) {
    const value = params.get(key);
    if (value !== null) out.set(key, value);
  }
  return out.toString();
}

/**
 * Parses the `layers` URL param into validated layer ids.
 * Returns null when the param is absent (no explicit board in the URL);
 * an empty array is a valid, explicit "all layers off" board.
 */
export function parseLayersParam(raw: string | null): LayerId[] | null {
  if (raw === null) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LayerId => Boolean(getLayer(s as LayerId)));
}

/**
 * The layer ids a `?layers=` param named that DON'T exist in the registry.
 *
 * `parseLayersParam` drops them silently, which is the right rendering choice
 * (an unknown id cannot be drawn) but the wrong HONESTY choice under Panorama's
 * "compartir vista" identity: a link written before a layer was renamed reopens
 * missing that layer, showing a smaller board with no hint that anything was
 * lost. The operator reads a complete-looking view that isn't the one shared.
 *
 * Returns the unknown ids so a caller can SAY so. Empty array = nothing lost.
 */
export function unknownLayerIds(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !getLayer(s as LayerId));
}

/**
 * Canonical `layers` param value for a set of active ids: registry order,
 * comma-joined. Both onPreset and the URL-sync effect emit this form so the
 * URL is stable regardless of activation order.
 */
export function canonicalLayersKey(ids: readonly LayerId[]): string {
  return PANORAMA_LAYERS.filter((l) => ids.includes(l.id))
    .map((l) => l.id)
    .join(",");
}

/**
 * Persists the board (layers/level/preset/period) for the bare-URL restore.
 * `prefs` stamps the CURRENT capasDetail/scrubDetail — they are UI-only state,
 * never URL params, so the caller passes the live values (panorama-vista-
 * redesign Phase 5, design Decision 5).
 */
export function saveBoard(
  params: URLSearchParams,
  prefs: { capasDetail: boolean; scrubDetail: boolean },
): void {
  try {
    const board: SavedBoard = {
      layers: params.get("layers") ?? "",
      level: params.get("level") === "locality" ? "locality" : "province",
      preset: params.get("preset"),
      period: params.get("period"),
      encoding: params.get("encoding"),
      capasDetail: prefs.capasDetail,
      scrubDetail: prefs.scrubDetail,
    };
    window.localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(board));
  } catch {
    // Storage unavailable (private mode, quota) — the board just isn't remembered.
  }
}

/**
 * perf plan 1.3 — client-safe placeholder for the streaming KPI strip. Shares
 * the degraded payload SHAPE (empty tiles, no denominator/freshness) but a
 * distinct "Cargando indicadores…" caption so the pending state is honest. Kept
 * local (not imported from get-panorama-kpis) so this client bundle never pulls
 * that server module's DB fetcher graph.
 */
export function loadingPanoramaKpis(): PanoramaKpis {
  return {
    kpis: [],
    recalculatedFor: "Cargando indicadores…",
    dataAsOf: null,
    coverageDenominator: null,
  };
}

export type PanoramaConsoleProps = {
  /** Default-on layer id (perdidas) — its features come pre-resolved from the server. */
  defaultLayerId: LayerId;
  /** Server-rendered features for the default layer. */
  defaultFeatures: FeatureCollection;
  /** Envelope for the default layer (truncated/suppressed). */
  defaultTruncated?: boolean;
  defaultSuppressedCount?: number;
  defaultNoLocalityCount?: number;
  /**
   * Server-rendered headline KPIs (recalculated for the active scope+period).
   * Optional since perf plan 1.3: a streaming page omits this and passes
   * `kpisPromise` instead (the KPI fan-out no longer blocks SSR). Non-streaming
   * callers (tests, awaited paths) still pass the resolved value — when present
   * it seeds the strip on first render exactly as before.
   */
  initialKpis?: PanoramaKpis;
  /**
   * perf plan 1.3 — non-blocking KPIs. The page creates the KPI loader promise
   * and streams it UN-awaited over RSC (React 19 / Next 15) so the shell + map
   * paint while the (cold) ~12-query fan-out is still resolving. The console
   * resolves it in a mount effect into `kpis` state, rendering a "Cargando
   * indicadores…" pending state until it lands. Absent → today's awaited
   * `initialKpis` behavior (backward compatible). The page attaches
   * `.catch(() => degradedPanoramaKpis())` before passing it, so a degraded DB
   * still resolves to an honest empty strip instead of rejecting.
   */
  kpisPromise?: Promise<PanoramaKpis>;
  /**
   * Pre-zoomed bounding box for the map's initial viewport.
   * Govt operators receive their jurisdiction bbox (server-computed); admin
   * leaves this undefined to keep the national/data-extent view.
   */
  initialBounds?: [[number, number], [number, number]];
  /**
   * Centroid map (slug → [lng, lat]) for the selected province's localities.
   * Passed to SituationalMap so it can autozoom when a locality is selected
   * from the JurisdictionSwitcher (A1 PR-7). Keyed by locality slug.
   */
  localityCentroids?: LocalityCentroids;
  /**
   * Aggregation axis the server seeded the default layer at, and the axis the
   * console starts on when the URL doesn't pin one. Scoped views (a province
   * or locality selected) seed at "locality" so the map opens at the finest
   * granularity the data supports (QA 2026-07-03: polygons/points at locality
   * granularity add reference and show the data's real resolution); the
   * national view stays at "province" (fast rollup, readable overview).
   * MUST match the level the page passed to getLayerFeatures for the seed.
   */
  initialLevel?: AggregationLevel;
  /**
   * panorama-redesign Fase 1 (RSC slot): the scope/period filters
   * (JurisdictionSwitcher + PeriodPicker) rendered by the SERVER shell.
   * PanoramaShell keeps ownership of that JSX (server/client boundary
   * intact); the console only decides WHERE it appears — inside the
   * "Alcance y período" disclosure in the side column.
   */
  filtersSlot?: ReactNode;
  /**
   * The ISO 3166-2:AR code of the province the operator is IMPLICITLY scoped to
   * (single-province govt case), when no province is explicitly selected in the
   * JurisdictionSwitcher. A jurisdiction-scoped operator (e.g. CABA) never picks
   * a province in the picker — their scope is inherited from the session — so
   * `?province` stays absent and the always-visible administrative divisions
   * (barrios/departamentos) would never render. This makes the console activate
   * the division rendering for that effective province exactly as an explicit
   * selection would: same lazy fetch, same outline/fill/k-anon semantics.
   * PRESENTATION-ONLY — the data scope is unchanged (already enforced by the
   * scoped loaders server-side). Undefined for multi-province or admin/national
   * scope (those keep today's behavior: provinces basemap until an explicit pick).
   */
  initialDivisionProvince?: string | null;
  /**
   * The locality SLUG the operator is IMPLICITLY scoped to (single-locality govt
   * case — e.g. a CABA-barrio operator), when no locality is explicitly selected.
   * Mirrors `initialDivisionProvince`: folded into the DERIVED scope so
   * `selectedLocalityCenter` resolves and the map autozooms to the locality on
   * load, and the level opens at "locality". PRESENTATION-ONLY — the data scope
   * is unchanged (already enforced server-side by the scoped loaders). Undefined
   * for whole-province, multi-locality, or admin/national scope.
   */
  initialDivisionLocality?: string | null;
  /**
   * Preset auto-activated on a TRULY-FIRST visit (bare URL, no saved board, no
   * explicit ?preset/?period). Role-aware default: the server passes the vista
   * that matches the operator's urgent question — a jurisdiction (govt) operator
   * opens on local syndromic surveillance ("sintomas"), an admin keeps the
   * national overview default. Falls back to DEFAULT_PANORAMA_PRESET_ID when the
   * page doesn't specify one. Presentation-only — the URL ?preset contract still
   * wins (this only applies when no explicit board is present).
   */
  defaultPresetId?: PresetId;
  /**
   * perf plan commit 1.2 — first-visit fast path. On a TRULY-first visit the
   * server resolves the role-default preset and seeds ALL its layers (via the
   * cached loader) at the preset's level + period. `seededPresetId` is that
   * preset — the role default on a first visit, OR the `?preset=<id>` a deep-link
   * named (so it may differ from `defaultPresetId`); `seededLayers` carries the
   * per-layer envelopes. When present the console seeds its caches + states from these,
   * paints on first render, and the mount's preset activation PRESERVES the
   * seeded caches (zero client fetches). Absent → today's behavior (perdidas
   * seed + client-side preset activation that fetches, now cache-warmed).
   */
  seededPresetId?: PresetId;
  seededLayers?: SeededLayer[];
  /**
   * Human scope label for the masthead pill, e.g. "Nacional · todas las
   * provincias" or a jurisdiction name. This is the SERVER default (national /
   * the operator's implicit scope); an embedded client drill re-labels the pill
   * live from the drilled province/locality (see `liveScopeLabel`), so the pill
   * tracks the shallow commit instead of staying stuck on the SSR value. When
   * undefined the console renders no masthead header (tests / embedding callers).
   */
  scopeLabel?: string;
  /**
   * panorama embedded-drill: provinces the viewer may filter to (admin: all;
   * govt: its own). When present, the console renders the JurisdictionSwitcher
   * CLIENT-SIDE and drives an embedded scope drill (shallow History commit +
   * client refetch, no reload). Absent → the console relies on the
   * server-rendered `filtersSlot` switcher (tests / other callers), unchanged.
   */
  allowedProvinces?: Array<{ code: string; name: string }>;
  /**
   * Localities of the INITIALLY-selected province (JurisdictionSwitcher
   * dropdown). Seeds the console's live scope-data state; an embedded drill
   * refreshes it from /api/panorama/scope for the newly-drilled province.
   */
  localities?: Array<{ slug: string; name: string }>;
  /**
   * v2C fixed console (RSC slot): the methodology / "acerca de estas métricas"
   * block PanoramaShell used to render BELOW the console. The page no longer
   * scrolls, so it now lives inside the masthead's "Acerca de esta vista"
   * popover. The server shell keeps ownership of the JSX.
   */
  aboutSlot?: ReactNode;
  /**
   * v2C fixed console (RSC slot): the "Datos de demostración" disclosure,
   * relocated from below the console into the masthead's "Acerca" popover
   * (with a compact always-visible pill beside the fresh chip). null/absent →
   * no demo notice (D3 suppression handled by the shell).
   */
  demoNotice?: ReactNode;
  /**
   * Q12: TRUE only for an operator whose HOME is a bounded jurisdiction (a govt
   * actor with assigned jurisdictions). Drives the map's reset-view control:
   * a bounded operator returns to "mi jurisdicción"; an admin/universal actor
   * returns to "Vista nacional". Distinct from `initialBounds` because a DRILLED
   * admin also receives `initialBounds` (the drilled province bbox) yet has no
   * personal jurisdiction, so keying the label on `initialBounds` mislabels the
   * control for admin. Undefined/false → admin/universal (national reset copy).
   */
  boundedJurisdiction?: boolean;
  /**
   * Cursor I2 — the aggregate cube's build timestamp when the SEEDED view is
   * served from the cube (admin, cubeable choropleth, fresh). Rendered by the
   * "Acerca" footer as the honest "Datos precalculados al …" caption.
   * Null/undefined → live-served (or points-only) seed; the caption reads
   * "Datos en vivo". Reflects the FIRST-render (seeded) source; it is a
   * freshness annotation, not a per-toggle live signal.
   */
  cubeBuiltAt?: Date | string | null;
  /**
   * V2 — the asker's jurisdictional standing, resolved SERVER-SIDE (the console
   * never sees the session's assignments and must not guess them). Feeds the
   * `authority` half of the ViewScopeDescriptor every export now carries.
   *
   * `mandate` is the raw assignment list; `effective` is the same list after the
   * page's own `narrowGovtScope` resolution — the two are separate fields
   * because a whole-province mandate drilled to one locality has the SAME LENGTH
   * as its mandate and a strictly finer grain (lib/ui/view-scope-descriptor.ts).
   * Omitted → exports fall back to their pre-V2 prose-only provenance.
   */
  scopeAuthority?: ViewScopeAuthority;
};

/**
 * A2 (map plan) — does a click on a ranking row DRILL into that unit, or open
 * its detail readout?
 *
 * MIRROR of the map's choropleth click contract (SituationalMap.tsx ~2538): at
 * national scope a province drills; once the console is already scoped, the map
 * pins a readout instead of drilling, so the row opens the detail to match.
 * A locality row deliberately never drills.
 *
 * Pure, and shared by BOTH the click handler and the hover preview's closing
 * hint — that coupling is the point. While these were two expressions, the
 * preview promised "Clic para entrar" on rows the click then opened a drawer
 * for, because aggregated-point layers carry the province as a NAME while the
 * drill guard only read `provinceCode`. Ranking keys arrive in both shapes, so
 * this resolves either to a province code.
 *
 * @returns the province code to drill into, or null when the row should open
 *          its detail instead.
 */
export function resolveRowDrillTarget(
  key: string,
  scope: { province: string | null; level: AggregationLevel },
): string | null {
  if (scope.province != null || scope.level !== "province") return null;
  return provinceByCode(key)?.code ?? provinceByName(key)?.code ?? null;
}

/**
 * Find the map feature a ranking row names.
 *
 * Mirrors rankWorstUnits' identify() key precedence: choropleth features key
 * off provinceCode/locality/province, NOT place/name, so matching only
 * place/name left every ranked-row click a no-op for the cobertura (rate)
 * layer (2026-07-10 fix).
 */
export function findRankedFeature(
  features: FeatureCollection,
  key: string,
): FeatureCollection["features"][number] | undefined {
  return features.features.find((f) => {
    const p = f.properties as Record<string, unknown>;
    return (
      p.provinceCode === key ||
      p.place === key ||
      p.name === key ||
      p.locality === key ||
      p.province === key
    );
  });
}

/**
 * Provenance metadata for the map's export footer and dock caption: WHERE, WHEN
 * and how much was k-anon suppressed. Pure — the console memoizes the call.
 */
/**
 * The state patch for a layer whose refetch has just come back — the ONE rule
 * for "what does this layer now claim", shared by every re-fetch call site.
 *
 * RA-7 F4 (2026-07-31) — WHY THIS IS A FUNCTION. `fetchChoroplethAt` resolves to
 * `null` on any !res.ok (503, budget fallback, gateway timeout) and the level-
 * change and verified-toggle handlers each merged that null into the envelope
 * inline, with `?? 0` / `?? false` / `=== true`. A failure therefore published
 * suppressedCount 0, noLocalityCount 0, truncated false and — the lie that
 * mattered — `degraded: false`. Since the failed fetch also wrote nothing into
 * the level cache, the canvas repainted EMPTY under a not-degraded flag, and
 * `emptyOverlayMessage` fell past its `layerDegraded` branch to "Sin datos para
 * esta capa …": the exact string LayerPanelState.degraded's own docblock forbids
 * for a timeout. A funcionario reads "no hay casos en mi provincia" where the
 * truth is "no pudimos calcular". Zeroing suppressedCount was its own small lie
 * — a privacy claim derived from a response that never arrived.
 *
 * A failure keeps the last-known envelope and DECLARES itself; only a real body
 * may restate the counts. Same shape as the M1/M2 honesty fixes on the fetch
 * paths in PanoramaConsole, now expressed once instead of per call site.
 */
export function layerFetchPatch(body: ApiResponse | null): Partial<LayerPanelState> {
  if (body === null) return { loading: false, degraded: true };
  return {
    loading: false,
    count: body.features.features.length,
    suppressedCount: body.suppressedCount,
    noLocalityCount: body.noLocalityCount ?? 0,
    truncated: body.truncated,
    degraded: body.degraded === true,
  };
}

/** One layer's contribution to a privacy-treatment total. */
export type SuppressionContribution = { label: string; value: number };

/**
 * THE view-wide k-anon figure: how many cells the server withheld across the
 * layers this board is currently showing, with the per-layer breakdown.
 *
 * RA-7 F6 (2026-07-31) — WHY THIS IS ONE FUNCTION AND NOT FOUR EXPRESSIONS.
 * The console used to answer "cuántas celdas están protegidas" in four places,
 * all of which could be on screen at once:
 *
 *   1. the legend pill's disclosure — Σ over ACTIVE, NON-LOADING layers;
 *   2. the exported PNG footer + the printed informe — Σ over ACTIVE layers,
 *      loading or not (`buildViewMeta`'s own reduce, a second derivation of the
 *      SAME claim that drifted from #1 for the whole duration of any refetch:
 *      the pill dropped a refetching layer's contribution, the footer kept its
 *      last-known one, and the two numbers disagreed on screen);
 *   3. the Registros caption — cells FLAGGED `suppressed` in the plotted
 *      features of the summable count layers only;
 *   4. the ranking line — ONE layer's count (the ranked base layer).
 *
 * #3 and #4 are legitimately different universes and keep their own numbers —
 * but they now SAY which universe they measure, at their call sites, because a
 * smaller number with no stated scope reads as a contradiction, not as a
 * narrower claim. #1 and #2 are the SAME claim ("this view") and had no business
 * being computed twice; they both read this function now.
 *
 * LOADING IS EXCLUDED, deliberately. A layer mid-refetch still carries the
 * PREVIOUS scope's suppressedCount, and attributing it to the scope now on
 * screen is a stale claim about privacy — the one class of number that must not
 * be approximated. It resolves as soon as the fetch lands.
 */
/**
 * What the "Actividad por día" calendar says when its track is empty.
 *
 * THREE DIFFERENT STATEMENTS, and they must not be collapsed into one. The
 * histogram endpoint suppresses per-day counts when the resolved scope is a
 * SINGLE administrative unit and the window total is under ANONYMITY_K, and it
 * declares that with `suppressed: true` rather than a silent empty array —
 * exactly so this surface can tell "protected" apart from "nothing happened"
 * (migration of that guard: 4c8fe3b1). Rendering the absence copy over a
 * suppressed window republishes, as a sentence, the claim the hatching exists
 * to withhold: it tells an operator a jurisdiction had no bites, no losses, no
 * symptoms, which is a statement about that jurisdiction and is false.
 *
 * "No temporal layer" outranks suppression: with nothing plotted there is no
 * protected window yet, so the actionable instruction wins.
 *
 * The suppressed wording reuses the map's own vocabulary — the choropleth's
 * all-suppressed notice says "protegido por privacidad (k<5)" for the same
 * treatment (components/panorama/all-suppressed-notice.tsx). One treatment,
 * one phrase.
 */
export function calendarEmptyMessage(input: {
  /** At least one layer with a temporal dimension is active. */
  hasTemporalLayer: boolean;
  /** The histogram endpoint declared this window k-anon suppressed. */
  suppressed: boolean;
}): string {
  if (!input.hasTemporalLayer) {
    return "Activá una capa con dimensión temporal (denuncias, mordeduras, pérdidas, síntomas o zoonosis) para ver la actividad por día.";
  }
  if (input.suppressed) {
    return "Actividad por día protegida por privacidad (k<5): el alcance es una sola unidad y el total del período no llega al umbral. No significa que no haya eventos.";
  }
  return "Sin eventos registrados en este período y alcance.";
}

export function activeSuppressedCells(states: Record<LayerId, LayerPanelState>): {
  total: number;
  breakdown: SuppressionContribution[];
} {
  const breakdown: SuppressionContribution[] = [];
  let total = 0;
  for (const layer of PANORAMA_LAYERS) {
    const s = states[layer.id];
    if (!s?.active || s.loading) continue;
    const value = s.suppressedCount ?? 0;
    if (value <= 0) continue;
    total += value;
    breakdown.push({ label: layer.label, value });
  }
  return { total, breakdown };
}

/** Same shape as `activeSuppressedCells`, for the "sin localidad" disclosure
 *  that shares the pill row with it (same active/non-loading rule). */
export function activeNoLocalityRecords(states: Record<LayerId, LayerPanelState>): {
  total: number;
  breakdown: SuppressionContribution[];
} {
  const breakdown: SuppressionContribution[] = [];
  let total = 0;
  for (const layer of PANORAMA_LAYERS) {
    const s = states[layer.id];
    if (!s?.active || s.loading) continue;
    const value = s.noLocalityCount ?? 0;
    if (value <= 0) continue;
    total += value;
    breakdown.push({ label: layer.label, value });
  }
  return { total, breakdown };
}

export function buildViewMeta(input: {
  province: string | null;
  locality: string | null;
  since: Date;
  until: Date;
  /** Active period preset id, so a fixed-start window (ytd) names its frame. */
  periodParam: string;
  states: Record<LayerId, LayerPanelState>;
  /** The as-of cut, when the operator is looking at a past frame. */
  asOf: Date | null;
}): { scopeLabel: string; periodLabel: string; suppressedCount: number } {
  const scopeLabel = input.locality
    ? "Localidad seleccionada"
    : input.province
      ? "Provincia seleccionada"
      : "Nacional";
  const days = Math.max(
    1,
    Math.round((input.until.getTime() - input.since.getTime()) / 86_400_000),
  );
  // ONE clock per screen (P1-F4). The view card already refused to stamp a
  // period over numbers that ignore it; the dock did not, so the same figures
  // carried "Estado actual" in one corner and "últimos 90 días" in another. The
  // rule is now derived in ONE place (layerIdsAreAllCurrentState) and read by
  // both — two derivations is how they came apart.
  const activeLayerIds = PANORAMA_LAYERS.filter((l) => input.states[l.id]?.active).map((l) => l.id);
  const base = layerIdsAreAllCurrentState(activeLayerIds)
    ? "estado actual"
    : // #14 (2026-07-23): year-shaped day counts read as years ("últimos 3 años").
      periodDaysPhrase(days, input.periodParam);
  // The dock never declared the as-of cut, so a past frame was indistinguishable
  // from the live one in the corner that names the window.
  // T2.4: UTC day formatter — the scrub axis is UTC day markers, and the old
  // AR-timezone formatDate rendered the PREVIOUS calendar day here while the
  // dock showed the right one (URL 2026-05-08 → "al 7 de mayo").
  const periodLabel = input.asOf === null ? base : `${base} · al ${formatAsOfDayLong(input.asOf)}`;
  // RA-7 F6: cite the ONE view-wide figure, never a second reduce of the same
  // claim. This feeds the PNG footer and the printed informe; the legend pill
  // reads the identical function, so the two cannot disagree by construction.
  const suppressedCount = activeSuppressedCells(input.states).total;
  return { scopeLabel, periodLabel, suppressedCount };
}

/**
 * es-AR plural noun for the ranked units at the active grain — the word the
 * small-scope ranking heading uses ("5 comunas"). Mirrors the on-canvas
 * aggregationLabel: CABA's departments are "comunas", any other province's are
 * "departamentos", and a national view ranks whole "jurisdicciones".
 */
export function rankingUnitNounFor(level: AggregationLevel, province: string | null): string {
  if (level === "province") return "jurisdicciones";
  if (province === "AR-C") return "comunas";
  return province ? "departamentos" : "localidades";
}

/** Singular forms of the ranked-unit nouns (es-AR — never a bare s-strip for
 *  "jurisdicciones"). Unknown nouns fall back to dropping a trailing "s". */
const UNIT_NOUN_SINGULAR: Record<string, string> = {
  jurisdicciones: "jurisdicción",
  comunas: "comuna",
  departamentos: "departamento",
  localidades: "localidad",
};

/**
 * T5.2 — the small-scope ranking heading, shared by PanoramaDataTable and the
 * printed informe (two hand-rolled copies had the same bug). The old shape was
 * `Tus ${n} ${pluralNoun}`: at n=1 it read "TUS 1 DEPARTAMENTOS" — a number-
 * agreement error under a possessive the professional register never needed.
 * Now: "1 departamento · métrica" / "24 departamentos · métrica".
 */
export function smallScopeRankingHeading(
  count: number,
  unitNoun: string,
  measureLabel: string,
): string {
  const noun =
    count === 1 ? (UNIT_NOUN_SINGULAR[unitNoun] ?? unitNoun.replace(/s$/, "")) : unitNoun;
  return `${count} ${noun} · ${measureLabel}`;
}

/**
 * The console-side effect surface `initBoardOnMount` drives. Every field is a
 * stable console callback/ref, so the mount effect that calls the helper stays
 * a thin adapter — the BRANCHING (URL board vs deep-link vs saved board vs
 * first visit) lives here, testable and out of PanoramaConsole.tsx (file-size
 * split, behavior-preserving move of the map-QOL mount effect).
 */
export type BoardMountIO = {
  hasSeed: boolean;
  seededPresetId: PresetId | undefined;
  defaultPresetId: PresetId;
  levelRef: { current: AggregationLevel };
  /** The scope+period qs a restore already handled (skips one invalidation run). */
  presetCommittedQsRef: { current: string | null };
  /** Seed the Simple/Detalle UI prefs from the saved board (strict-coerced). */
  seedDetailPrefs: (capasDetail: boolean, scrubDetail: boolean) => void;
  missingFromCache: (ids: LayerId[], lvl: AggregationLevel) => LayerId[];
  fetchLayersInto: (
    ids: LayerId[],
    lvl: AggregationLevel,
    baseParams: URLSearchParams,
    opts?: { preserveOnError?: boolean; coalesce?: boolean },
  ) => Promise<void>;
  /** Apply a `?preset=` deep-link's camera framing (yank-guard at the caller). */
  emitSeededPresetFrame: (preset: PanoramaPreset) => void;
  applyPreset: (id: PresetId, commit: "replace", opts?: { preserveSeededCaches?: boolean }) => void;
  setBivariateMode: (v: boolean) => void;
  setPercapitaMode: (v: boolean) => void;
  /** Drop every period-sensitive cache (restored period ≠ server-rendered one). */
  clearPeriodSensitiveCaches: () => void;
  setCommittedPeriod: (period: string) => void;
  setLevel: (lvl: AggregationLevel) => void;
  setStates: (
    updater: (s: Record<LayerId, LayerPanelState>) => Record<LayerId, LayerPanelState>,
  ) => void;
  /**
   * T1.6 honesty: fired when the SAVED-BOARD restore branch actually commits —
   * a genuinely bare URL (typed/bookmarked) whose board came from localStorage,
   * not from the link. The console surfaces a one-line "Continuando tu vista
   * anterior." so the silent rewrite is never silent. Menu clicks never reach
   * this branch (their href pins the canonical vista — T1.5).
   */
  onSavedBoardRestored: () => void;
};

/**
 * map-QOL mount init (runs once): resolve the initial board.
 * (a) URL carries `layers` → fetch whatever the server didn't seed.
 * (b) Bare URL + a saved board in localStorage → subtle one-time restore via
 *     shallow replaceState + client fetch (no redirect, no reload). The URL
 *     stays the source of truth; localStorage is only the memory of it.
 * (c) TRULY-FIRST visit (bare URL, no saved board) → default-activate the
 *     flagship compliance preset (design-QA 2026-07-04 highest-leverage nit):
 *     the first screen must answer "¿dónde estamos mal?" — question-framed
 *     preset + national frame + matching auto-reading — instead of an orphan
 *     perdidas layer with a generic fallback sentence. Committed via
 *     replaceState (the operator didn't navigate; no history entry).
 */
export function initBoardOnMount(io: BoardMountIO): void {
  const current = new URLSearchParams(window.location.search);
  const urlLayerIds = parseLayersParam(current.get("layers"));

  // panorama-vista-redesign Phase 5 (design Decision 5): capasDetail/
  // scrubDetail are UI-only prefs (never URL params) — read the saved board
  // ONCE here and seed both toggles regardless of which restore branch below
  // runs. A pre-redesign v1 entry (or unreadable storage) tolerantly reads
  // as Simple (false) for both — no crash, no JSON.parse failure surfaced.
  let saved: SavedBoard | null = null;
  try {
    const raw = window.localStorage.getItem(BOARD_STORAGE_KEY);
    saved = raw !== null ? (JSON.parse(raw) as SavedBoard) : null;
  } catch {
    // Storage unreadable — treat as a first visit: default-activate below.
    saved = null;
  }
  if (saved !== null) {
    // QA fix: coerce STRICTLY — a corrupt or pre-redesign non-boolean value
    // (e.g. a stray string) must read as Simple (false), not as any
    // truthy value. `?? false` only guards `undefined`; `=== true` also
    // guards against a corrupt stored value passing through.
    io.seedDetailPrefs(saved.capasDetail === true, saved.scrubDetail === true);
  }

  if (urlLayerIds !== null) {
    const missing = io.missingFromCache(urlLayerIds, io.levelRef.current);
    // Q10: initial-load path — coalesce identical in-flight GETs across a
    // StrictMode dev-remount (the fresh instance's abort registry cannot
    // supersede the first's in-flight fetch).
    if (missing.length > 0)
      void io.fetchLayersInto(missing, io.levelRef.current, current, { coalesce: true });
    return;
  }

  // Bare URL — offer the saved board, if any. Explicit period/preset params
  // mean the operator navigated here on purpose: don't override the board.
  if (current.get("period") !== null || current.get("preset") !== null) {
    // P4c (task_ccc31326): a `?preset=` deep-link's board is server-seeded, so
    // applyPreset (the only other framing site) never runs — apply the seeded
    // preset's camera FRAMING here or a national-framed vista lands unframed
    // (reads as blank when the base layer is sparse). setPresetFrame fires
    // before the map's async load; SituationalMap BUFFERS a pre-load frame and
    // applies it in its load handler (camera-pin and province-drill win there).
    // Skip when the link pins its own camera (?z — parseCameraFromParams needs
    // z+lat+lng, so z-null ⇒ no pinned camera).
    if (io.hasSeed && io.seededPresetId != null && current.get("z") === null) {
      const seededPreset = getPreset(io.seededPresetId);
      if (seededPreset) io.emitSeededPresetFrame(seededPreset);
    }
    return;
  }
  if (saved === null) {
    // (c) No explicit board, no saved board — first visit: land on the
    // role-aware question-framed preset (govt → local surveillance, admin →
    // national default) instead of the orphan default layer. When the SERVER
    // seeded that preset's layers + KPIs (perf plan 1.2), PRESERVE the seeded
    // caches so this commit fires zero fetches; otherwise (no seed) fall back
    // to the fetch-on-mount path (the client re-fetches, now cache-warmed).
    const preserve = io.hasSeed && io.seededPresetId === io.defaultPresetId;
    io.applyPreset(
      io.defaultPresetId,
      "replace",
      preserve ? { preserveSeededCaches: true } : undefined,
    );
    return;
  }
  const savedIds = parseLayersParam(saved.layers || null);
  // A saved board with an explicit empty layer set is a deliberate
  // "all off" board — respect it; only the truly-absent case defaults.
  if (savedIds === null || savedIds.length === 0) return;
  restoreSavedBoard(io, saved, savedIds, current);
}

/** The saved-board restore half of initBoardOnMount (branch b) — split out to
 *  keep each function under the complexity budget; same code, only moved. */
function restoreSavedBoard(
  io: BoardMountIO,
  saved: SavedBoard,
  savedIds: LayerId[],
  current: URLSearchParams,
): void {
  const nextParams = new URLSearchParams(window.location.search);
  nextParams.set("layers", canonicalLayersKey(savedIds));
  const savedLevel: AggregationLevel = saved.level === "locality" ? "locality" : "province";
  if (savedLevel === "locality") nextParams.set("level", "locality");
  // D1: a saved board may carry a RETIRED preset id. `saved.layers` is the
  // ground truth (no re-derivation), but the URL write must use the RESOLVED
  // canonical id so restored URLs self-heal instead of re-propagating aliases.
  const savedPreset = saved.preset !== null ? getPreset(saved.preset) : undefined;
  if (savedPreset) {
    nextParams.set("preset", savedPreset.id);
  }
  if (saved.period !== null) nextParams.set("period", saved.period);
  // P5: restore the encoding selection with the board (tolerant — older boards
  // lack the field; only known selectable values apply).
  if (saved.encoding === "bivariate") {
    nextParams.set("encoding", "bivariate");
    io.setBivariateMode(true);
  } else if (saved.encoding === "percapita") {
    nextParams.set("encoding", "percapita");
    io.setPercapitaMode(true);
  }

  // The restored period differs from the server-rendered one → the seeded
  // default features are stale for the new window: drop every cache and
  // refetch the whole board. Same-period restores only fill the gaps.
  const periodChanged = saved.period !== null && saved.period !== current.get("period");
  if (periodChanged) io.clearPeriodSensitiveCaches();
  io.presetCommittedQsRef.current = scopePeriodQsOf(nextParams);
  replaceMapStateUrl(`${window.location.pathname}?${nextParams.toString()}`);
  // W2 fix: mirror the restored period into committedPeriod so the chrome tracks
  // the shallow-committed window (useSearchParams stays on the bare URL).
  if (saved.period !== null) io.setCommittedPeriod(saved.period);
  io.setLevel(savedLevel);
  io.levelRef.current = savedLevel;
  // `activePresetId` is DERIVED (task #66 / WS-4): flipping the layer states to
  // the saved set (below) re-derives it. A saved board persists `layers` and
  // `preset` together (saveBoard), so the derived value matches `saved.preset`.
  io.setStates((s) => {
    const next = { ...s };
    for (const l of PANORAMA_LAYERS) {
      if (savedIds.includes(l.id)) {
        if (!next[l.id].active) {
          next[l.id] = {
            active: true,
            loading: true,
            count: 0,
            suppressedCount: 0,
            truncated: false,
          };
        }
      } else if (next[l.id].active) {
        next[l.id] = { ...next[l.id], active: false, compatibilityHint: undefined };
      }
    }
    return next;
  });
  const toFetch = periodChanged ? savedIds : io.missingFromCache(savedIds, savedLevel);
  // Q10: initial board-restore path — coalesce identical in-flight GETs across
  // a StrictMode dev-remount.
  if (toFetch.length > 0)
    void io.fetchLayersInto(toFetch, savedLevel, nextParams, { coalesce: true });
  // T1.6: the board on screen came from localStorage, not from the URL — say so.
  io.onSavedBoardRestored();
}

/**
 * Should an active temporal frame (`asOf`) be parked back at live?
 *
 * The scrubber lives in the dock's "Línea de tiempo" pane. The original rule
 * cleared the frame whenever that pane was hidden — collapsed OR another tab —
 * so a historical frame could never sit on screen unannounced.
 *
 * PO decision 2026-07-26 retires the TAB half. The frame is no longer silent:
 * the vista caption states the corte and current-state KPI tiles carry an
 * "ESTADO ACTUAL · NO VARÍA CON LA FECHA" badge, both OUTSIDE the dock and both
 * surviving a tab change. Meanwhile the guard was destroying the instrument's
 * central use — reproduce a past moment, then cross it against the ranking or
 * the records table. Clicking "Registros" to see what composed a frame threw
 * the frame away.
 *
 * The COLLAPSED half stays: with the dock shut there is no scrubber on screen,
 * so the operator has no control to move or reset the frame with.
 *
 * Extracted so the RULE is testable on its own rather than buried in an effect.
 */
export function shouldParkAtLive(input: {
  dockOpen: boolean;
  dockTab: string;
  /** The active as-of instant, or null when the board is live. */
  asOf: Date | string | null;
}): boolean {
  return input.asOf !== null && !input.dockOpen;
}

/**
 * Whether a layer fetch's resolution has been OVERRIDDEN by the operator — and
 * the state it must land as when it has. `null` means "land your patch".
 *
 * THE OPERATOR'S DEACTIVATION OUTRANKS A FETCH THAT WAS IN FLIGHT WHEN THEY
 * CLICKED. Measured 2026-09-01, after a gate's two `test:verified` runs
 * answered differently over one tree: every caller marks a layer
 * active+loading BEFORE fetching, so on the happy path this returns null and
 * the success arm lands its patch verbatim — but `applyPreset`'s 200ms
 * debounced burst (and real network latency in production) leaves a window
 * where the operator unchecks the layer first, and the success arms used to
 * write `active: true` unconditionally. The checkbox silently re-checked
 * itself, and when it was the last temporal layer the scrubber gate
 * re-enabled against an explicit choice. Deactivation deliberately aborts
 * neither the debounce timer nor the fetch — the data stays useful in the
 * refs for an instant re-toggle — so the arbitration happens at LANDING time,
 * here, once, for all three success arms in PanoramaConsole.
 */
export function fetchLandingOverridden(
  current: LayerPanelState | undefined,
): LayerPanelState | null {
  if (current?.active === true) return null;
  return {
    ...(current ?? { count: 0, suppressedCount: 0, truncated: false }),
    active: false,
    loading: false,
  };
}

/**
 * F2 hint recomputation after `id` becomes active, over the new active set.
 * Extracted from PanoramaConsole's onToggle (2026-09-01, paying the file-size
 * debt down instead of feeding it): pure over its inputs, `computeHints`
 * threaded in because the hint rules live with the console's own catalog.
 */
export function applyHintsAfterActivate(
  s: Record<LayerId, LayerPanelState>,
  nextActiveIds: LayerId[],
  id: LayerId,
  computeHints: (activeIds: LayerId[]) => Partial<Record<LayerId, Partial<LayerPanelState>>>,
): Record<LayerId, LayerPanelState> {
  const hints = computeHints(nextActiveIds);
  const next = { ...s };
  for (const [lid, patch] of Object.entries(hints) as [LayerId, Partial<LayerPanelState>][]) {
    if (lid !== id) next[lid] = { ...next[lid], ...patch };
  }
  // The newly activated layer never carries a compatibility hint.
  next[id] = { ...next[id], compatibilityHint: undefined };
  return next;
}
