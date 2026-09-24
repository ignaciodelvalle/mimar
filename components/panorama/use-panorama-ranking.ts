"use client";

// usePanoramaRanking — the Estadísticas "Peores N" projection.
//
// Lifted out of PanoramaConsole (large-file burn-down) without a behaviour
// change: the ranking LAYER choice, the rows it orders, the honesty flags
// around emptiness / k-anonymity suppression, and the dock section's subtitle
// copy. Everything here is derived state — the hook owns no state of its own
// and performs no I/O, so the console keeps exactly the behaviour it had.
//
// The five inputs are the console values this projection reads:
//   - activePresetId  — a preset may declare a `rankBy` overlay (see below)
//   - captionLayer    — the map's BASE layer, the default thing to rank by
//   - states          — per-layer panel state (active flag + suppressedCount)
//   - mapLayers       — the layers the map actually PAINTS (already projected
//                       to per-cápita when that mode is on), so the ranking
//                       orders the same universe the fill colours
//   - rankingUnitNoun — the unit noun the current grain implies, used in copy

import { useMemo } from "react";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import type { ActiveLayer } from "@/components/panorama/SituationalMap";
import { rankingAvailability } from "@/src/modules/panorama/domain/data-availability";
import { getLayer } from "@/src/modules/panorama/domain/layers";
import { PERCAPITA_UNIT_LABEL } from "@/src/modules/panorama/domain/percapita";
import { type PresetId, getPreset } from "@/src/modules/panorama/domain/presets";
import {
  type RankedUnit,
  type RankingKind,
  rankUnitsInScope,
  rankWorstUnits,
} from "@/src/modules/panorama/domain/ranking";
import type { LayerId, PanoramaLayer } from "@/src/modules/panorama/domain/types";

export type UsePanoramaRankingParams = {
  activePresetId: PresetId | null;
  captionLayer: PanoramaLayer | null;
  states: Record<LayerId, LayerPanelState>;
  mapLayers: ActiveLayer[];
  rankingUnitNoun: string;
};

export type PanoramaRanking = {
  /** The layer the ranking orders by — the preset's `rankBy` or the base. */
  rankingLayer: PanoramaLayer | null;
  /** The PAINTED counterpart of `rankingLayer` (per-cápita aware). */
  rankedActiveLayer: ActiveLayer | undefined;
  /** A rate layer at locality grain returns counts, not percentages. */
  rankLocalityRateCount: boolean;
  effectiveRankingKind: RankingKind | null;
  rankingMeasureLabel: string;
  /** Every rankable in-scope unit, uncapped (a MEASUREMENT count). */
  rankingAllInScope: RankedUnit[];
  rankingSmallScope: boolean;
  /** What the panel renders: Worst-N, or the full small-scope ordering. */
  rankedRows: RankedUnit[];
  rankingDataUnavailable: boolean;
  dockSuppressedCount: number;
  rankingStructureHidden: boolean;
  dockRankingSubtitle: string | undefined;
};

export function usePanoramaRanking({
  activePresetId,
  captionLayer,
  states,
  mapLayers,
  rankingUnitNoun,
}: UsePanoramaRankingParams): PanoramaRanking {
  // panorama-ia-v2 §3.3 — the Estadísticas "Peores N" ranking.
  //
  // P2.5: the ranking's LAYER is the active preset's PRIMARY QUESTION metric,
  // not always the map's base. A preset declares `rankBy` when its base is a
  // backdrop and the question is about the signal overlay (brotes-activos: base
  // cobertura, but the question "¿dónde hay brotes?" ranks by the zoonosis
  // SIGNAL). Absent (or the declared layer not active) → rank by the base
  // (captionLayer), which is correct for the compliance/density presets.
  const rankingLayer = useMemo(() => {
    if (activePresetId !== null) {
      const rankBy = getPreset(activePresetId)?.rankBy;
      if (rankBy) {
        const rl = getLayer(rankBy);
        if (rl && states[rl.id]?.active) return rl;
      }
    }
    return captionLayer;
  }, [activePresetId, captionLayer, states]);

  // T4.3 (2026-08-01): the ranking must read the same values the map PAINTS,
  // not merely what it FETCHED — under per-cápita the map projects counts into
  // per-10k rates (mapLayers), while `activeLayers` still carries raw counts.
  // Ranking off `activeLayers` therefore ordered "Peores 10" by conteo while
  // the map colored by tasa: a province with a huge population could rank
  // worst by count yet paint a mild rate. Reading `mapLayers` (already the
  // legend/table/popup's shared source, see the block above) keeps the three
  // surfaces honest about which universe they order.
  const rankedActiveLayer = useMemo(
    () => (rankingLayer ? mapLayers.find((l) => l.id === rankingLayer.id) : undefined),
    [rankingLayer, mapLayers],
  );

  // Coherence with Registros (P1.1 / C2): a rate layer at LOCALITY grain returns
  // per-unit COUNTS, not percentages (repository "V1 LIMITATION") — MapDataTable
  // already coerces those to a count to avoid the "Palermo 204%" bug. The ranking
  // MUST do the same, or Estadísticas would show a bogus "%" while Registros shows
  // a count — a fresh contradiction. Coerce to density and mark the measure label.
  const rankLocalityRateCount =
    rankedActiveLayer?.dataType === "rate" && rankedActiveLayer?.level === "locality";
  const rankingKind = useMemo<RankingKind | null>(() => {
    if (!rankingLayer || rankingLayer.dataType === "reference") return null;
    return rankingLayer.dataType === "rate" ? "rate" : "density";
  }, [rankingLayer]);
  const effectiveRankingKind: RankingKind | null =
    rankingKind === null ? null : rankLocalityRateCount ? "density" : rankingKind;
  const rankingMeasureLabel = rankingLayer
    ? rankLocalityRateCount
      ? `${rankingLayer.caption.measure} (conteo)`
      : rankedActiveLayer?.perCapita
        ? `${rankingLayer.caption.measure} (${PERCAPITA_UNIT_LABEL})`
        : rankingLayer.caption.measure
    : "";

  // Worst-N and full small-scope ordering, from the SAME features. Worst-N is the
  // default (national/large scope); the small-scope fallback (P2.5) shows every
  // in-scope unit ordered by the metric when the whole scope holds fewer than a
  // full Worst-N (e.g. CABA · 5 comunas), so a jurisdiction operator sees "tus N
  // unidades, ordenadas por {métrica}" instead of the misleading "sin datos
  // suficientes" that contradicts Registros listing the same units with values.
  const RANKING_LIMIT = 10;
  const rankingWorst = useMemo<RankedUnit[]>(() => {
    if (!rankingLayer || effectiveRankingKind === null || !rankedActiveLayer) return [];
    return rankWorstUnits(rankedActiveLayer.features, {
      kind: effectiveRankingKind,
      target: rankingLayer.complianceTarget,
      // POLARITY (2026-07-26): without this the ranking sorted EVERY target-less
      // layer descending under a "Peores N" title — listing the ten BEST-served
      // jurisdictions as the worst for acceso-veterinario. rankWorstUnits has
      // always honoured the flag; this call site simply never passed it.
      higherIsBetter: rankingLayer.higherIsBetter,
      limit: RANKING_LIMIT,
    });
  }, [rankingLayer, effectiveRankingKind, rankedActiveLayer]);

  // RA-7 F5 (2026-07-31) — `limit` IS DELIBERATELY UNCAPPED. This list answers
  // "how many units did we MEASURE", and PanoramaDataTable publishes its length
  // verbatim: "Se midieron N {unidades} y ninguna quedó por debajo de la meta."
  // RANKING_LIMIT clamped it at 10, so a national frame that measured all 24
  // jurisdictions told a funcionario from any of the other 14 that we measured
  // ten — a DISPLAY cap reported as a MEASUREMENT count. Passing it explicitly
  // (not omitting it) matters: rankUnitsInScope's own default is 10.
  const rankingAllInScope = useMemo<RankedUnit[]>(() => {
    if (!rankingLayer || effectiveRankingKind === null || !rankedActiveLayer) return [];
    return rankUnitsInScope(rankedActiveLayer.features, {
      kind: effectiveRankingKind,
      target: rankingLayer.complianceTarget,
      // Same polarity declaration as the Worst-N path above — the small-scope
      // fallback orders the SAME units and must not disagree about which end is bad.
      higherIsBetter: rankingLayer.higherIsBetter,
      limit: Number.POSITIVE_INFINITY,
    });
  }, [rankingLayer, effectiveRankingKind, rankedActiveLayer]);

  // "Small scope" = every rankable (non-suppressed) unit fits under the Worst-N
  // cap. A national/large scope (≥ 10 units) keeps Worst-N framing (incl. the
  // honest "sin jurisdicciones bajo meta" all-clear for a fully-compliant view).
  const rankingSmallScope =
    rankingAllInScope.length > 0 && rankingAllInScope.length < RANKING_LIMIT;
  const rankedRows = rankingSmallScope ? rankingAllInScope : rankingWorst;

  // The ranking is layer-driven (the base layer's own fetch), NOT the KPI strip.
  // Scoped to RATE layers (cobertura): an EMPTY rate feature collection means we
  // have no jurisdictions to compare against meta, so the panel must NOT claim
  // "sin jurisdicciones bajo meta" (a reassuring all-clear) — that all-clear may
  // only show for a POPULATED layer where no unit is below meta. Density layers
  // keep their already-honest "Sin datos suficientes en este alcance." copy.
  const rankingDataUnavailable =
    effectiveRankingKind === "rate" && (rankedActiveLayer?.features.features.length ?? 0) === 0;

  // Estadísticas: the Worst-N=10 ranking (PO-ratified depth — ia-v2 §3.3, NOT
  // the prototype's top-7), hover-synced with the map and click-through to the
  // detail drawer. Ranking FOLLOWS THE SCOPE (the base layer's features are
  // already scope-resolved: drilled = the scope's localities/departments —
  // plan note: never the prototype's provinces-while-drilled). The k-anon
  // suppressed count renders as an explicit last row (privacy visible).
  const dockSuppressedCount =
    rankingLayer !== null ? (states[rankingLayer.id]?.suppressedCount ?? 0) : 0;
  // P2-1 (PO 2026-08-04) — the tri-state that replaces the single
  // `rankingDataUnavailable` boolean as the DECISION input for both surfaces
  // fed by this projection (the dock card and the printed informe).
  //
  // A boolean cannot carry the distinction P2 requires: "no data" (hide the
  // whole structure) and "data withheld by k-anonymity" (the notice is
  // MANDATORY) are opposite obligations. `rankingDataUnavailable` stays as the
  // FAILURE input the honest-empty copy still needs; the classification of the
  // emptiness now lives in one shared domain helper.
  const rankingAvailabilityState = rankingAvailability({
    rowCount: rankedRows.length,
    measuredUnits: rankingAllInScope.length,
    suppressedUnits: dockSuppressedCount,
    calculationFailed: rankingDataUnavailable,
    noRankableLayer: effectiveRankingKind === null || rankingLayer === null,
  });
  /** P2: the "Peores 10" card does not render at all when nothing justifies it. */
  const rankingStructureHidden = rankingAvailabilityState === "absent";

  // Dock redesign (PO ask, consistency + explanation): name what the ranking
  // IS — the metric + that it orders the units of the CURRENT scope — as the
  // "Ranking de unidades" section's subtitle (PanoramaStatSection's existing
  // caption slot). Absent when there is nothing active to rank (dockRanking
  // already narrates that empty state in its own body).
  const dockRankingSubtitle =
    effectiveRankingKind !== null && rankingLayer !== null
      ? // Finding 4: below province grain the measure is a COUNT, so this
        // subtitle must not promise an ordering "por cobertura" either.
        // T4.3: the old per-cápita caveat ("el mapa pinta tasas... este
        // ranking ordena por conteos") is gone — the ranking now follows
        // mapLayers, so `rankingMeasureLabel` already names the tasa when
        // that mode is on, and the two surfaces agree.
        rankLocalityRateCount
        ? `Ordena ${rankingUnitNoun} por cantidad de registros de ${rankingLayer.caption.measure} en el alcance actual.`
        : `Ordena ${rankingUnitNoun} por ${rankingMeasureLabel} en el alcance actual.`
      : undefined;

  return {
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
  };
}
