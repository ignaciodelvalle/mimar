import { PanoramaConsole, type SeededLayer } from "@/components/panorama/PanoramaConsole";
import { PanoramaDemoDisclosure } from "@/components/panorama/PanoramaDemoDisclosure";
import type { LocalityCentroids } from "@/lib/infra/ar-localidades";
import type { ViewScopeAuthority } from "@/lib/ui/view-scope-descriptor";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import type { PresetId } from "@/src/modules/panorama/domain/presets";
import type {
  AggregationLevel,
  FeatureCollection,
  PanoramaLayer,
} from "@/src/modules/panorama/domain/types";

// ---------------------------------------------------------------------------
// PanoramaShell — server component composing the situational console chrome:
// header + scope chip + unified filters (JurisdictionSwitcher + PeriodPicker) +
// demo-data disclosure + the (client) multi-layer console (map + LayerPanel).
//
// Shared by /admin/panorama (universal scope) and /gob/panorama (jurisdiction
// scope). The default layer (perdidas) is resolved server-side; the client
// console fetches the other layers on toggle, threading the same filters.
// ---------------------------------------------------------------------------

type Props = {
  /** Human scope label, e.g. "Nacional · todas las provincias" or "Salta". */
  scopeLabel: string;
  /** The default-on layer's registry entry (perdidas). */
  layer: PanoramaLayer;
  /** Pre-scoped features for the default layer (resolved server-side). */
  features: FeatureCollection;
  /** Envelope for the default layer (surfaced in the LayerPanel). */
  truncated?: boolean;
  suppressedCount?: number;
  /** Provinces the viewer may filter to (admin: all; govt: its own). */
  allowedProvinces: Array<{ code: string; name: string }>;
  /** Localities of the selected province (for the JurisdictionSwitcher). */
  localities: Array<{ slug: string; name: string }>;
  /**
   * Centroid map (slug → [lng, lat]) for the selected province's localities.
   * Used by SituationalMap to autozoom when a locality is picked (A1 PR-7).
   * Empty object when no province is selected.
   */
  localityCentroids?: LocalityCentroids;
  /**
   * Headline KPIs recalculated for the active scope+period. Optional since perf
   * plan 1.3: a page may instead stream `kpisPromise` (un-awaited) so the shell
   * paints before the KPI fan-out resolves. Pass exactly one.
   */
  kpis?: PanoramaKpis;
  /**
   * perf plan 1.3 — un-awaited KPI loader promise streamed to the console over
   * RSC. Forwarded verbatim to PanoramaConsole, which resolves it client-side
   * and shows a "Cargando indicadores…" pending strip meanwhile.
   */
  kpisPromise?: Promise<PanoramaKpis>;
  /**
   * Pre-zoomed bounding box for the map's initial viewport.
   * Govt operators receive their jurisdiction bbox (server-computed); admin
   * leaves this undefined to keep the national/data-extent view.
   */
  initialBounds?: [[number, number], [number, number]];
  /**
   * Suppress PanoramaShell's own "Datos de demostración" notice when a GLOBAL
   * demo banner already covers the page (e.g. /admin with NEXT_PUBLIC_DEMO_MODE=
   * true) — avoids stacking two identical disclosures (D3).
   */
  suppressDemoDisclosure?: boolean;
  /**
   * Aggregation axis the page resolved the default layer's seed at — must
   * match the level passed to getLayerFeatures. Scoped views pass "locality"
   * so the console opens at the finest granularity (QA 2026-07-03).
   */
  initialLevel?: AggregationLevel;
  /**
   * ISO 3166-2:AR code of the province the operator is IMPLICITLY scoped to
   * (single-province govt case) when no province is explicitly selected. Lets
   * the console render that province's administrative divisions on mount for a
   * jurisdiction-scoped operator who never touches the province picker (PO
   * validation 2026-07-07). Undefined for multi-province / admin national scope.
   * Presentation-only: the data scope is unchanged (enforced server-side).
   */
  initialDivisionProvince?: string | null;
  /**
   * Locality SLUG the operator is IMPLICITLY scoped to (single-locality govt
   * case). Forwarded to PanoramaConsole so the map autozooms to the locality on
   * mount and the level opens at "locality". Presentation-only; undefined for
   * whole-province / multi-locality / admin scope.
   */
  initialDivisionLocality?: string | null;
  /**
   * Role-aware default vista auto-activated on a first visit (bare URL). The
   * page resolves it from the operator's role: a jurisdiction (govt) operator
   * opens on local syndromic surveillance; admin keeps the national default.
   * Omitted → PanoramaConsole falls back to DEFAULT_PANORAMA_PRESET_ID.
   * Presentation-only; the URL ?preset contract still wins.
   */
  defaultPresetId?: PresetId;
  /**
   * perf plan commit 1.2 — first-visit fast path. On a TRULY-first visit the
   * page resolves the role-default preset and seeds ALL its layers (cached) at
   * the preset's level + period; these props carry that seed to the console so
   * the map paints on first render with zero client fetches. Absent on
   * non-first visits (the page keeps seeding perdidas). `seededPresetId` is the
   * seeded preset — the role default on a first visit, or the `?preset=<id>` a
   * deep-link named (so it may differ from `defaultPresetId`).
   */
  seededPresetId?: PresetId;
  seededLayers?: SeededLayer[];
  /**
   * Q12: TRUE only for a bounded-jurisdiction govt operator. Forwarded to
   * PanoramaConsole → SituationalMap so the reset-view control reads "Volver a
   * mi jurisdicción" ONLY for that operator; admin/universal (including a drilled
   * admin, who receives `initialBounds` but has no personal jurisdiction) reads
   * "Vista nacional". Defaults to false.
   */
  boundedJurisdiction?: boolean;
  /**
   * Cursor I2 — the aggregate cube's build timestamp when the seeded view is
   * served from the cube (admin, cubeable choropleth, fresh). Forwarded to the
   * console's "Acerca" footer as the honest "Datos precalculados al …" caption.
   * Null/undefined → the view was live-served (or points-only) and the caption
   * says "Datos en vivo" (never fabricate a freshness the cube can't back).
   */
  cubeBuiltAt?: Date | string | null;
  /**
   * V2 — the asker's jurisdictional standing (role + mandate + effective view +
   * admin drill), resolved server-side by the page. Forwarded verbatim to the
   * console, which folds it together with the live ViewState into the
   * ViewScopeDescriptor every export carries. Omitted → pre-V2 prose provenance.
   */
  scopeAuthority?: ViewScopeAuthority;
};

export function PanoramaShell({
  scopeLabel,
  layer,
  features,
  truncated = false,
  suppressedCount = 0,
  allowedProvinces,
  localities,
  localityCentroids = {},
  kpis,
  kpisPromise,
  initialBounds,
  suppressDemoDisclosure = false,
  initialLevel = "province",
  initialDivisionProvince,
  initialDivisionLocality,
  defaultPresetId,
  seededPresetId,
  seededLayers,
  boundedJurisdiction = false,
  cubeBuiltAt = null,
  scopeAuthority,
}: Props) {
  return (
    // v2C FIXED CONSOLE (PO decision 2026-07-11): LIGHT operator theme on BOTH
    // /gob and /admin (the v1 dark "situation-room" skin is retired — ln-op-*
    // tokens resolve to their light :root defaults) AND a viewport-locked
    // layout: the page never scrolls; the map fills everything except the
    // masthead + control rows. The negative margins cancel the AppShell
    // scroll-area padding (24px horizontal, 22px vertical) so the console
    // bleeds edge-to-edge;
    // the height/width stretch pins it to exactly the content region (100%
    // resolves against the scroll area's CONTENT box, so +44px/+48px restore
    // the cancelled vertical/horizontal padding — px math lives in style=
    // because the token ratchet bans arbitrary px classes).
    // `panorama-console-shell` is the print hook: this box is `overflow-hidden`
    // with an INLINE height, so it clips the "Informe de situación" to one page
    // exactly like the operator shell above it does (PRN-3). The informe's own
    // print sheet neutralises it — see PanoramaInformeSituacion.tsx.
    <div
      className="op-fade-in panorama-console-shell -mx-6 -my-5.5 flex flex-col overflow-hidden bg-ln-op-page text-ln-op-ink"
      style={{ height: "calc(100% + 44px)", width: "calc(100% + 48px)" }}
    >
      {/* The masthead (identity line + scope pill + "Acerca" popover + fresh
          chip + Actualizar) lives INSIDE PanoramaConsole so the scope pill
          tracks the embedded client drill (live-QA regression 2026-07-11).
          The demo disclosure + methodology block ride the `demoNotice` /
          `aboutSlot` RSC slots into the masthead's "Acerca de esta vista"
          popover — the page no longer scrolls, so nothing renders below the
          console anymore. This server component keeps ownership of the JSX. */}
      <PanoramaConsole
        scopeLabel={scopeLabel}
        defaultLayerId={layer.id}
        defaultFeatures={features}
        defaultTruncated={truncated}
        defaultSuppressedCount={suppressedCount}
        initialKpis={kpis}
        kpisPromise={kpisPromise}
        initialBounds={initialBounds}
        boundedJurisdiction={boundedJurisdiction}
        localityCentroids={localityCentroids}
        initialLevel={initialLevel}
        initialDivisionProvince={initialDivisionProvince}
        initialDivisionLocality={initialDivisionLocality}
        defaultPresetId={defaultPresetId}
        seededPresetId={seededPresetId}
        seededLayers={seededLayers}
        cubeBuiltAt={cubeBuiltAt}
        scopeAuthority={scopeAuthority}
        // panorama embedded-drill: the console renders the JurisdictionSwitcher
        // CLIENT-SIDE so a province/locality pick commits the scope shallowly (no
        // reload). allowedProvinces + the initial localities are handed down; the
        // console refreshes localities/centroids from /api/panorama/scope on drill.
        allowedProvinces={allowedProvinces}
        localities={localities}
        // v2C: NO filtersSlot anymore — the console's own PeriodSegmented
        // (single-line 7/30/90/12m + «▾ más» menu, SAME URL commit semantics
        // as PeriodPicker) supersedes the rail's PeriodPicker slot. The prop
        // stays on the console for tests/embedders.
        // Demo-data disclosure — synthetic dataset (exec-gate credibility).
        // Suppressed when a global demo banner already covers the page (D3):
        // pass nothing so the console renders neither the pill nor the popover
        // paragraph.
        demoNotice={suppressDemoDisclosure ? undefined : <PanoramaDemoDisclosure />}
        // Methodology / "acerca de estas métricas" — for a government data
        // product the operator must be able to see how each indicator is
        // computed, its sources, and the privacy treatment (exec-gate E9).
        // Rendered inside the masthead's "Acerca de esta vista" popover.
        aboutSlot={
          <details className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card/40 px-3 py-2 text-sm text-ln-op-ink-2">
            <summary className="cursor-pointer select-none font-medium text-ln-op-ink">
              Acerca de estas métricas
            </summary>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed">
              <li>
                <span className="font-medium text-ln-op-ink">Cálculo.</span> Los indicadores reusan
                los mismos cálculos que los dashboards de detalle (idéntico denominador): el
                Panorama no los recalcula con otra fórmula, los lee de la misma fuente.
              </li>
              <li>
                <span className="font-medium text-ln-op-ink">Fuentes.</span> Densidad poblacional
                del Censo 2022 (INDEC); jurisdicciones y centroides de localidades del padrón{" "}
                <code className="text-xs">ar_localities</code>.
              </li>
              <li>
                <span className="font-medium text-ln-op-ink">Privacidad.</span> Las denuncias de
                bienestar se ubican en el centroide de la localidad, nunca en la dirección exacta.
                Las celdas con menos de 5 casos se suprimen por k-anonimato. Cada capa se limita a
                2.000 puntos por vista.
              </li>
              <li>
                <span className="font-medium text-ln-op-ink">Reproducción temporal.</span> La línea
                de tiempo reconstruye los eventos registrados hasta la fecha elegida. Las capas de
                estado actual (cobertura, mortalidad, refugios) no se reproducen en el tiempo y se
                atenúan mientras se reproduce.
              </li>
            </ul>
          </details>
        }
      />
    </div>
  );
}
