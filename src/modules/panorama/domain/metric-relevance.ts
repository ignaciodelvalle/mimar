// Panorama C2a — KPI ↔ layer relevance (manual/advanced mode honesty).
//
// PROBLEM: in manual mode (no active preset) the KPI overlay shows headline
// indicators regardless of which layers are painted on the map. A KPI whose
// subject is NOT among the active layers then reads as if it described the
// map — e.g. "Cobertura antirrábica 42%" floating over a denuncias-only map.
// That is a projection lie: the number is real, but it does not describe THIS
// view. Preset mode is immune (the preset curates a coherent metric set); this
// only governs manual mode.
//
// MAPPING: every headline KPI id (get-panorama-kpis) shares its name with the
// registry layer that measures the same subject (cobertura KPI ↔ cobertura
// layer, etc.). A KPI is RELEVANT when any of its related layers is active.
// The coverage denominator is not a headline KPI (it rides the
// `coverageDenominator` footer field, outside PanoramaKpiId), so it carries no
// mapping. Cross-links are added ONLY where a genuine derived
// relationship exists (reunificación is the OUTCOME of lost episodes — the
// reunificación layer's source is derived from the same lost-episode stream),
// never as a loose thematic association.
//
// Pure module — no DB, no React, no Next. English identifiers, es-AR copy lives
// in the UI (project invariant #4).

import type { LayerId, PanoramaKpiId } from "./types";

/**
 * KPI id → the registry layer ids whose presence on the map makes that KPI
 * describe the active view. Most map 1:1 to their namesake layer; pérdidas and
 * reunificación cross-link because reunificación is the measured outcome of the
 * lost-episode stream pérdidas plots (same underlying events).
 */
export const KPI_RELATED_LAYERS: Record<PanoramaKpiId, readonly LayerId[]> = {
  cobertura: ["cobertura"],
  esterilizacion: ["esterilizacion"],
  microchip: ["microchip"],
  ppp: ["ppp"],
  perdidas: ["perdidas", "reunificacion"],
  reunificacion: ["reunificacion", "perdidas"],
  mordeduras: ["mordeduras"],
  zoonosis: ["zoonosis"],
  denuncias: ["denuncias"],
  mortalidad: ["mortalidad"],
};

/**
 * True when at least one of the KPI's related layers is active — i.e. the KPI
 * honestly describes something the operator can see painted on the map.
 */
export function isKpiRelevant(kpiId: PanoramaKpiId, activeLayerIds: readonly LayerId[]): boolean {
  const related = KPI_RELATED_LAYERS[kpiId];
  if (related === undefined || related.length === 0) return false;
  return related.some((id) => activeLayerIds.includes(id));
}

/**
 * Split an ordered KPI-id list into the ones that describe the active layers
 * and the ones that do not — preserving input order in both partitions so the
 * UI keeps the payload's display order within each group.
 */
export function partitionKpiIdsByRelevance<T extends { id: PanoramaKpiId }>(
  kpis: readonly T[],
  activeLayerIds: readonly LayerId[],
): { relevant: T[]; irrelevant: T[] } {
  const relevant: T[] = [];
  const irrelevant: T[] = [];
  for (const kpi of kpis) {
    if (isKpiRelevant(kpi.id, activeLayerIds)) relevant.push(kpi);
    else irrelevant.push(kpi);
  }
  return { relevant, irrelevant };
}
