"use client";

// KpiChips — the KPI CARDS over the map (task #38 item 4; READ-ONLY since #53).
//
// #53 Option A (PO 2026-07-14): the chips are INDICATORS, never controls —
// reading a number and changing the map are different acts, and the old
// click-to-rebase (a chip that LOOKED like a stat but silently swapped the
// choropleth base) was the single most confusing interaction in the panorama.
// All board changes now flow through Vista / Personalizar capas only. With the
// interactivity gone, the whole radio apparatus went with it: no radiogroup,
// no roving tabindex, no radio dot, no selected elevation, no province-only
// disable (there is nothing to disable) — a card is a card.
//
// Each card carries: the value + short label (de-dup, item 5), the
// period-over-period delta, and a mini-sparkline for the window-sensitive
// metrics that ship one. Hover reveals a one-line method note; the full
// methodology lives in the right rail's "Acerca" panel (#49 item 10).
//
// The cluster stays COMPACT — the map still dominates (the PO's "MÁS MAPA"
// ruling). Honesty states (degraded / pending / empty) unchanged.

import { useState } from "react";

import { AnimatedKpiValue } from "@/components/panorama/AnimatedKpiValue";
import { DeltaGlyph } from "@/components/panorama/DeltaGlyph";
import { selectMetricKpis } from "@/components/panorama/PanoramaMetricsColumn";
import { Sparkline } from "@/components/panorama/Sparkline";
import { shortKpiLabel } from "@/components/panorama/panorama-labels";
import type {
  PanoramaKpi,
  PanoramaKpis,
} from "@/src/modules/panorama/application/get-panorama-kpis";
import { partitionKpiIdsByRelevance } from "@/src/modules/panorama/domain/metric-relevance";
import type { PresetId } from "@/src/modules/panorama/domain/presets";
import type { LayerId, PanoramaKpiId } from "@/src/modules/panorama/domain/types";

/** Cap so the overlay never buries the map (presets curate 2-3). */
const MAX_CHIPS = 4;

type Props = {
  kpis: PanoramaKpis;
  /** The active preset's curated metric ids (display order); null = manual. */
  metricIds: readonly PanoramaKpiId[] | null;
  /** Active vista — drives the de-dup short labels. */
  presetId: PresetId | null;
  /**
   * C2a — the ids of the layers currently painted on the map. In MANUAL mode
   * (`metricIds` null) the overlay shows only the KPIs whose subject is among
   * these layers up-front; the rest hide behind a "Ver todos los indicadores"
   * toggle so an indicator never reads as if it described a layer that is not
   * on the map. Undefined (or in preset mode) keeps the pre-C2a behavior.
   */
  activeLayerIds?: readonly LayerId[];
  pending?: boolean;
  /**
   * Q13: TRUE while a SCOPE/PERIOD drill's KPI refetch is in flight. Distinct
   * from `pending` (the scrubber's hold-while-revalidate, which KEEPS the current
   * values because the scope is unchanged): a scope change makes the held numbers
   * belong to the PREVIOUS jurisdiction, so holding them is a flash of lies. On
   * this flag the strip BLANKS to an aria-busy placeholder until the fresh figures
   * for the new scope land — it never shows a value from the old scope.
   */
  scopeChanging?: boolean;
  degraded?: boolean;
  /**
   * Cowork QA ronda 3 §5 (C2, P2.4): true while a temporal frame is active
   * (the scrubber is off the live edge, `asOf` set). STOCK KPIs (`currentState`)
   * are "estado actual" by the HYBRID design — their big number does NOT move
   * with the scrubber, while the map + label + temporal/signal KPIs do. When a
   * temporal frame is active this EMPHASIZES the "estado actual" tag on those
   * stock cards so the not-tracking reads as intentional, never as a stuck bug.
   */
  temporalFrameActive?: boolean;
  /**
   * T2.1 — the TARGET day of the in-flight refetch (formatAsOfDayLong shape),
   * when a temporal frame drives it; null/absent for a live refetch. While
   * `pending` holds the previous values on screen, the strip stamps
   * "Actualizando al {fecha}…" so the held numbers are never presented as
   * current silently (the opacity dim alone said nothing).
   */
  pendingAsOfLabel?: string | null;
};

/** The first sentence of the KPI definition — the hover method note. */
function methodNote(kpi: PanoramaKpi): string {
  const def = kpi.info.definition ?? "";
  const stop = def.indexOf(". ");
  return stop > 0 ? def.slice(0, stop + 1) : def;
}

/** One KPI card. `dimmed` (C2a) renders the honest "no corresponde a las capas
 *  activas" treatment for a manual-mode indicator whose subject is off the map. */
function KpiCard({
  kpi,
  presetId,
  temporalFrameActive,
  dimmed = false,
}: {
  kpi: PanoramaKpi;
  presetId: PresetId | null;
  temporalFrameActive: boolean;
  dimmed?: boolean;
}) {
  // SUPRIMIDO ≠ CERO (metric-honesty audit, PO 2026-09-16). Un bucket
  // enmascarado por k-anonimato viaja como `y: 0` con el flag `suppressed`;
  // ploteado como número sería el MÍNIMO de la serie y se pegaría al piso del
  // recuadro, indistinguible de una semana en la que no pasó nada. `null`
  // rompe la línea, y la leyenda de abajo dice cuántos huecos hay: un hueco sin
  // explicación se lee como un dato que falta, no como uno protegido.
  const sparkPoints = kpi.sparkline?.map((p) => (p.suppressed ? null : p.y));
  const sparkMasked = kpi.sparkline?.filter((p) => p.suppressed).length ?? 0;

  return (
    <li
      // #49 item 1: floating chrome must read over ANY basemap — opaque fill.
      // Read-only (#53 Option A): default cursor, no hover affordance; the
      // hover title carries the method note only, promising nothing.
      className={`flex w-full flex-col gap-0.5 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-left ${
        dimmed ? "opacity-60" : ""
      }`}
      title={`${kpi.label} — ${methodNote(kpi)}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        {/* MOT-4c (motion audit Gap 5): the strip used to dim the whole list
            and let every figure snap at once — the dim says the SET is stale,
            it cannot say WHICH member moved. Eases only when the round-trip
            proof holds; see AnimatedKpiValue. */}
        <AnimatedKpiValue
          value={kpi.value}
          temporalFrameActive={temporalFrameActive}
          className="text-lg font-bold tabular-nums text-ln-op-ink"
        />
        {kpi.delta && (
          <span className="shrink-0 text-xs tabular-nums text-ln-op-faint" title={kpi.delta.label}>
            <DeltaGlyph direction={kpi.delta.direction} /> {kpi.delta.pct > 0 ? "+" : ""}
            {kpi.delta.pct.toLocaleString("es-AR")}
            {kpi.delta.unit === "pts" ? " pts" : "%"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-ln-op-mute">
          {shortKpiLabel(presetId, kpi.id, kpi.label)}
        </span>
        {sparkPoints && sparkPoints.length > 1 && (
          <Sparkline
            points={sparkPoints}
            width={64}
            height={18}
            ariaLabel={`Tendencia de ${kpi.sparklineLabel ?? shortKpiLabel(presetId, kpi.id, kpi.label)}${
              sparkMasked > 0
                ? `. ${sparkMasked} ${sparkMasked === 1 ? "período oculto" : "períodos ocultos"} por privacidad: la línea se corta, no baja a cero`
                : ""
            }`}
          />
        )}
      </div>
      {sparkMasked > 0 && (
        <span className="text-xs italic text-ln-op-faint">
          {sparkMasked} {sparkMasked === 1 ? "período oculto" : "períodos ocultos"} (privacidad)
        </span>
      )}
      {/* C2a: an indicator whose subject layer is NOT painted — say so plainly so
          the number never reads as if it described the current map. */}
      {dimmed && (
        <span className="text-xs italic text-ln-op-faint">no corresponde a las capas activas</span>
      )}
      {/* Q8 — unified temporal-basis label: EVERY chip states its basis in the
          primary card body (not just a hover/footer), so a STOCK number
          ("8 pérdidas activas") never reads on the same footing as a PERIOD
          flow ("310 eventos"). Stock → the "estado actual" tag below; flow →
          the "período" tag here. Wording, not numbers — the value is unchanged. */}
      {/* Coherence hybrid (cowork QA H1 / P2.4): a STOCK KPI does not move with
          the scrubber — say so, emphasized while a temporal frame is active. */}
      {kpi.currentState ? (
        <span
          className={`text-xs font-medium uppercase tracking-[0.06em] ${
            temporalFrameActive
              ? "w-fit rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-1.5 py-0.5 text-ln-op-warn"
              : "text-ln-op-faint"
          }`}
          title="Valor de estado actual: no cambia con la línea de tiempo (la reproducción mueve el mapa y los indicadores temporales)."
        >
          {temporalFrameActive ? "estado actual · no varía con la fecha" : "estado actual"}
        </span>
      ) : kpi.fixedWindowLabel ? (
        // #12a: a flow KPI on a FIXED window (e.g. mordeduras · 12 meses) — its
        // own label, never the generic "período" that implies the picker moves it.
        <span
          className="text-xs font-medium uppercase tracking-[0.06em] text-ln-op-faint"
          title="Valor de flujo de una ventana fija: no cambia con la línea de tiempo (a diferencia de un valor de período, que sigue el selector)."
        >
          {kpi.fixedWindowLabel}
        </span>
      ) : (
        <span
          className="text-xs font-medium uppercase tracking-[0.06em] text-ln-op-faint"
          title="Valor de flujo del período seleccionado: acumula los eventos dentro de la ventana temporal activa (a diferencia de un valor de estado actual)."
        >
          período
        </span>
      )}
      {/* Coherence hybrid (cowork QA H6): the clearly-labeled secondary figure. */}
      {kpi.secondary && (
        <span className="truncate text-xs tabular-nums text-ln-op-faint">{kpi.secondary}</span>
      )}
    </li>
  );
}

export function KpiChips({
  kpis,
  metricIds,
  presetId,
  activeLayerIds,
  pending = false,
  scopeChanging = false,
  degraded = false,
  temporalFrameActive = false,
  pendingAsOfLabel = null,
}: Props) {
  // C2a: in manual mode, irrelevant indicators start hidden behind a toggle.
  const [showAll, setShowAll] = useState(false);

  if (degraded) {
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-center text-sm text-ln-op-warn">
        No pudimos cargar los indicadores en este momento.
      </p>
    );
  }

  // Q13: a scope/period drill is recomputing the strip — the current values
  // belong to the PREVIOUS jurisdiction. Blank to an aria-busy placeholder so a
  // CABA drill never flashes the old national numbers (unlike the scrubber's
  // `pending`, which legitimately HOLDS same-scope values). Takes precedence over
  // the hold path below.
  if (scopeChanging) {
    return (
      <p
        aria-busy="true"
        className="animate-pulse rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card px-3 py-2 text-center text-sm text-ln-op-mute"
      >
        Actualizando indicadores…
      </p>
    );
  }

  const selected = selectMetricKpis(kpis, metricIds);

  // Stale-while-revalidate (PO: "los KPI aparecen y desaparecen, quedan raros"):
  // during a timeline scrub the as-of KPI refetch flips `pending` on each settle,
  // which used to REPLACE the whole strip with a "Cargando indicadores…" block —
  // the values blinked out and back on every frame. Instead we KEEP the previous
  // values on screen (the parent retains them: `setKpis` only fires on success)
  // and mark the strip busy with a subtle "actualizando" treatment. The full
  // placeholder is reserved for the genuine cold start (pending with NO prior
  // values), where there is nothing to hold.
  if (selected.length === 0) {
    if (pending) {
      return (
        <p
          aria-busy="true"
          className="animate-pulse rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card px-3 py-2 text-center text-sm text-ln-op-mute"
        >
          Cargando indicadores…
        </p>
      );
    }
    return (
      <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card px-3 py-2 text-center text-sm text-ln-op-mute">
        Métricas no disponibles para esta vista.
      </p>
    );
  }

  // We have values to show; a pending refetch just refreshes them in place.
  const refreshing = pending;
  // Subtle "updating" affordance: dim slightly + announce busy, never unmount.
  // A3 (motion review): `transition-opacity` must stay present in BOTH states —
  // it used to live only in the `refreshing` branch, so the class disappeared
  // at the exact moment the value settled and the reveal went untransitioned.
  // Only the opacity VALUE toggles now.
  const refreshingClass = refreshing ? "opacity-60" : "opacity-100";
  // T2.1 — during a time scrub the numbers on screen are the PREVIOUS frame's
  // while the refetch is in flight, and the opacity dim alone read as a style,
  // not a claim. One terse line names the day the strip is moving to, so a
  // stale figure is never presented as current silently. Scrub-only by design:
  // a live refetch (pending without a temporal target) keeps the subtle dim —
  // the Q13 contract reserves the "Actualizando indicadores…" blank for scope
  // changes.
  const refreshingNote =
    refreshing && pendingAsOfLabel ? (
      <p aria-live="polite" className="text-xs italic text-ln-op-faint">
        {`Actualizando al ${pendingAsOfLabel}…`}
      </p>
    ) : null;

  // Preset mode (metricIds set) OR no layer context: unchanged — show the curated
  // (or full) set capped at MAX_CHIPS, no relevance partition.
  const manualMode = metricIds === null && activeLayerIds !== undefined;
  if (!manualMode) {
    const shown = selected.slice(0, MAX_CHIPS);
    return (
      <>
        <ul
          aria-label="Indicadores de esta vista"
          aria-busy={refreshing}
          className={`m-0 flex list-none flex-col gap-1.5 p-0 transition-opacity ${refreshingClass}`}
        >
          {shown.map((kpi) => (
            <KpiCard
              key={kpi.id}
              kpi={kpi}
              presetId={presetId}
              temporalFrameActive={temporalFrameActive}
            />
          ))}
        </ul>
        {refreshingNote}
      </>
    );
  }

  // C2a manual mode: partition by whether the KPI's subject layer is on the map.
  const { relevant, irrelevant } = partitionKpiIdsByRelevance(selected, activeLayerIds);
  const shownRelevant = relevant.slice(0, MAX_CHIPS);

  return (
    <div
      className={`flex flex-col gap-1.5 transition-opacity ${refreshingClass}`}
      aria-busy={refreshing}
    >
      <ul
        aria-label="Indicadores de esta vista"
        className="m-0 flex list-none flex-col gap-1.5 p-0"
      >
        {shownRelevant.map((kpi) => (
          <KpiCard
            key={kpi.id}
            kpi={kpi}
            presetId={presetId}
            temporalFrameActive={temporalFrameActive}
          />
        ))}
      </ul>
      {refreshingNote}
      {shownRelevant.length === 0 && (
        <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card px-3 py-2 text-center text-xs text-ln-op-mute">
          Ningún indicador corresponde directamente a las capas activas.
        </p>
      )}
      {irrelevant.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showAll}
            aria-controls="kpi-irrelevant-list"
            onClick={() => setShowAll((v) => !v)}
            className="w-fit text-xs font-medium text-ln-op-azul hover:underline"
          >
            {showAll
              ? "Ocultar indicadores de otras capas"
              : `Ver todos los indicadores (${irrelevant.length})`}
          </button>
          {showAll && (
            <ul
              id="kpi-irrelevant-list"
              aria-label="Indicadores de otras capas"
              className="m-0 flex list-none flex-col gap-1.5 p-0"
            >
              {irrelevant.map((kpi) => (
                <KpiCard
                  key={kpi.id}
                  kpi={kpi}
                  presetId={presetId}
                  temporalFrameActive={temporalFrameActive}
                  dimmed
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
