"use client";

// use-vista-metric-projection — which metrics the active vista PROJECTS,
// extracted MECHANICALLY from PanoramaConsole.tsx (file-size split,
// behavior-preserving): the D1 metric-option derivation plus the curated
// metric ids and the KPI subset every conclusion surface (metrics column,
// reading, informe) must share.

import { useMemo } from "react";

import type { LayerPanelState } from "@/components/panorama/LayerPanel";
import { selectMetricKpis } from "@/components/panorama/PanoramaMetricsColumn";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { deriveActiveComplianceMetric } from "@/src/modules/panorama/domain/derive-preset";
import { PANORAMA_LAYERS } from "@/src/modules/panorama/domain/layers";
import { partitionKpiIdsByRelevance } from "@/src/modules/panorama/domain/metric-relevance";
import {
  type PresetId,
  getPreset,
  presetLayerIdsWithBase,
} from "@/src/modules/panorama/domain/presets";
import type { LayerId } from "@/src/modules/panorama/domain/types";

type UseVistaMetricProjectionInput = {
  /** The derived active preset id (derivePreset), or null in manual mode. */
  activePresetId: PresetId | null;
  /** Per-layer panel state — only `.active` is read. */
  states: Record<LayerId, LayerPanelState>;
  /** Active layers in render order — only `.id` is read (C2a relevance). */
  activeLayers: ReadonlyArray<{ id: string }>;
  /** The KPI strip payload feeding the conclusion surfaces. */
  kpis: PanoramaKpis;
};

export function useVistaMetricProjection({
  activePresetId,
  states,
  activeLayers,
  kpis,
}: UseVistaMetricProjectionInput) {
  // panorama-vista-redesign Phase 1 (design Decision 1): Vista panel (VISTA
  // label + active question line + PresetPanel row tabs) → 2-col body
  // (map column: map + honesty lines + scrubber | metrics column: ~342px
  // right rail). Supersedes the Fase 1 flat reflow.
  const activePreset = activePresetId !== null ? getPreset(activePresetId) : null;

  // D1 metric selector: which metric OPTION of the derived preset the current
  // layer set corresponds to (non-null exactly when the active preset declares
  // metricOptions — the default set matches the first option by contract).
  // Derived, never stored: switching metric flips the layers and this follows,
  // the same discipline as activePresetId itself.
  const activeMetricOption = useMemo(() => {
    if (activePresetId === null) return null;
    const preset = getPreset(activePresetId);
    if (!preset?.metricOptions) return null;
    const metric = deriveActiveComplianceMetric(
      PANORAMA_LAYERS.filter((l) => states[l.id]?.active).map((l) => l.id),
      preset,
    );
    return preset.metricOptions.find((o) => o.metric === metric) ?? null;
  }, [activePresetId, states]);

  // panorama-vista-redesign Phase 3 (design Decision 3): the active preset's
  // curated metric ids, in display order. Null (manual/advanced mode, no
  // active preset) → PanoramaMetricsColumn shows every KPI, nothing hidden.
  // D1: under a metric-selector preset the active OPTION's curated column wins
  // (each absorbed vista's metrics ported into its option).
  const metricIds = activeMetricOption?.metrics ?? activePreset?.metrics ?? null;

  // C2a: the active layer ids, for the manual-mode KPI relevance partition
  // (KpiChips hides indicators whose subject layer is not on the map).
  const activeLayerIdList = useMemo<LayerId[]>(
    () => activeLayers.map((l) => l.id as LayerId),
    [activeLayers],
  );

  // QA fix (finding 5): feed PanoramaReading the SAME preset-subset the
  // metrics column shows — previously the reading headlined off the FULL
  // kpis.kpis array while the column right below it only showed the active
  // preset's curated metrics, so the one-line sentence could reference a KPI
  // the operator can't see anywhere on screen. selectMetricKpis is the exact
  // filter PanoramaMetricsColumn uses; buildPanoramaReading only looks at
  // known ids + deltas (reading.ts qualify()), so narrowing the input array
  // just narrows which deltas are eligible to headline — it never breaks the
  // sentence construction.
  // Relevance gating (review finding 5): C2a hid off-map KPIs in the KpiChips
  // overlay ONLY — the one-line reading (PanoramaReading) and the printable
  // Informe still headlined off the FULL set in manual mode, so both could
  // surface a metric absent from the active layers (the exact "projection lie"
  // C2a fixed for the chips). In MANUAL mode (no preset), narrow the reading +
  // Informe input to the KPIs whose subject layer is on the map — the SAME
  // partition KpiChips applies. Preset mode is immune (metricIds already curates
  // a coherent set) and must not be re-filtered, so the gate is scoped to
  // metricIds === null.
  const readingKpis = useMemo(() => {
    const selected = selectMetricKpis(kpis, metricIds);
    if (metricIds !== null) return selected;
    return partitionKpiIdsByRelevance(selected, activeLayerIdList).relevant;
  }, [kpis, metricIds, activeLayerIdList]);

  // WP2 progressive disclosure: the layer set the active vista actually uses —
  // under a metric-selector vista the ACTIVE option's base substitutes the
  // preset default (the same base-substitution contract applyPreset commits).
  // Null in manual mode (no vista → the layers panel shows everything).
  const presetRelevantLayerIds = useMemo<ReadonlySet<LayerId> | null>(() => {
    if (!activePreset) return null;
    return new Set(
      presetLayerIdsWithBase(activePreset, activeMetricOption?.base ?? activePreset.base),
    );
  }, [activePreset, activeMetricOption]);

  return {
    activePreset,
    activeMetricOption,
    metricIds,
    activeLayerIdList,
    readingKpis,
    presetRelevantLayerIds,
  };
}
