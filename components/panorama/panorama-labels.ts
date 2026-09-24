// Panorama v3 — de-dup information architecture (task #38 item 5) + the Filtro
// counter semantics (item 3). PURE display helpers: no React, no DB. English
// identifiers, es-AR copy (invariant #4).
//
// DE-DUP RULE (PO-directed): "no string repeats a concept its CONTAINER already
// states." The active vista name is shown ONCE — the rail's Vista trigger, the
// KPI-cluster caption, and the Filtro panel header. The KPI cards and the Filtro
// layer rows then drop the stem the vista name already carries. Concrete PO
// example — "Pérdidas y reunificación" used to echo near-identical strings 5×
// (the vista name, KPI "Pérdidas activas", KPI "Tasa de reunificación", layer
// "Pérdidas / avistajes", layer "Reunificación").
//
// IMPORTANT — canonical labels are NOT mutated here. The KPI `label`
// (get-panorama-kpis.ts) carries DASHBOARD PARITY (it must equal the /gob tile
// wording) and is pinned by many tests; the layer `label` (layers.ts) is pinned
// by the domain suite. This module produces CHROME-ONLY short forms layered on
// top — a display transform the parity contract and the tests never see. The
// maps below are CURATED and reviewed (not algorithmic): an entry exists only
// where the vista context makes the shortened form self-sufficient. Anything not
// listed falls back to the canonical label unchanged.

import { PANORAMA_DEFAULT_PRESET } from "@/lib/analytics/analytics-period";
import { roleOf } from "@/src/modules/panorama/domain/compatibility";
import { getLayer } from "@/src/modules/panorama/domain/layers";
import { type PresetId, getPreset } from "@/src/modules/panorama/domain/presets";
import type { LayerId, PanoramaKpiId } from "@/src/modules/panorama/domain/types";
import { verifiedOnlyIsHonored } from "@/src/modules/panorama/domain/view-state-caption";

// ---------------------------------------------------------------------------
// Vista name — shown ONCE by the chrome container.
// ---------------------------------------------------------------------------

/** The active vista's display name, or null in manual/advanced mode. */
export function activeVistaName(presetId: PresetId | null): string | null {
  if (presetId === null) return null;
  return getPreset(presetId)?.label ?? null;
}

// ---------------------------------------------------------------------------
// Curated per-vista SHORT labels (the de-dup, item 5).
// ---------------------------------------------------------------------------

/**
 * KPI card short labels, keyed presetId → kpiId. Only clear wins where the vista
 * name already states the stem AND the remainder is a self-sufficient noun.
 *
 * DELIBERATELY NOT shortened (flagged as semantically risky, kept canonical):
 *  - `cumplimiento` cobertura: "Cobertura antirrábica (perros, 12m)" sits beside
 *    "Cobertura de esterilización" in the same trio, so bare "Cobertura" would be
 *    ambiguous — the vista prefix would be dropped at the cost of meaning.
 *  - `perdidas-reunificacion` reunificacion: "Tasa de reunificación" — bare
 *    "Reunificación" loses the "rate/percentage" reading; "Tasa" alone is
 *    ambiguous. Kept whole.
 */
const KPI_SHORT: Partial<Record<PresetId, Partial<Record<PanoramaKpiId, string>>>> = {
  "perdidas-reunificacion": {
    // vista states "Pérdidas" → "Pérdidas activas" becomes just "Activas".
    perdidas: "Activas",
  },
};

/**
 * Filtro layer-row short labels, keyed presetId → layerId. The Filtro groups
 * rows under the vista heading, so a row can drop the stem the heading states.
 */
const LAYER_SHORT: Partial<Record<PresetId, Partial<Record<LayerId, string>>>> = {
  sintomas: {
    // vista name IS "Síntomas / vigilancia sindrómica" → the base row is "Síntomas".
    sintomas: "Síntomas",
  },
  bienestar: {
    // vista states "Bienestar" → "Denuncias de bienestar" becomes "Denuncias".
    denuncias: "Denuncias",
  },
  "perdidas-reunificacion": {
    // vista states "Pérdidas" and "reunificación".
    perdidas: "Avistajes",
    reunificacion: "Tasa por unidad",
  },
};

/**
 * The KPI card label to SHOW: the curated short form when the active vista makes
 * the concept obvious, else the canonical label unchanged.
 */
export function shortKpiLabel(
  presetId: PresetId | null,
  kpiId: PanoramaKpiId,
  canonicalLabel: string,
): string {
  if (presetId === null) return canonicalLabel;
  return KPI_SHORT[presetId]?.[kpiId] ?? canonicalLabel;
}

/**
 * The Filtro layer-row label to SHOW under the active vista heading: the curated
 * short form when the vista states the stem, else the canonical label.
 */
export function shortLayerLabel(
  presetId: PresetId | null,
  layerId: LayerId,
  canonicalLabel: string,
): string {
  if (presetId === null) return canonicalLabel;
  return LAYER_SHORT[presetId]?.[layerId] ?? canonicalLabel;
}

// ---------------------------------------------------------------------------
// v2C legend pill — the collapsed ramp strip's TITLE.
// ---------------------------------------------------------------------------

/**
 * The metric label to show above the collapsed legend ramp (LegendPill.baseLabel).
 *
 * A2 (cowork demo 2026-07-17): in a manual/custom vista the pill was titled by
 * `captionLayer` — the FIRST active non-reference layer in catalogue order — which
 * is the SIGNAL point overlay (e.g. "Zoonosis / señales") whenever it sits before
 * the choropleth base in PANORAMA_LAYERS. But the ramp itself is painted by the
 * CHOROPLETH: the caption layer's OWN province-grain classed ramp, or — when
 * drilled — the DIVISION count ramp of the base choropleth. A signal-titled ramp
 * over cobertura counts read "Zoonosis / señales · 16 … 676" on a blue cobertura
 * gradient — a label≠scale lie the funcionario reads as "zoonosis 676" where there
 * are vaccinated dogs.
 *
 * The pill title must name the layer that PAINTED the ramp, mirroring the ramp's
 * own source precedence (legendRampColors / legendRampEndpoints):
 *   - bivariate matrix              → "Intensidad combinada" (C2, 2026-07-22:
 *                                     renamed from "Riesgo combinado" — the
 *                                     matrix crosses low coverage × high
 *                                     signals, i.e. reporting intensity, not
 *                                     measured epidemiological risk);
 *   - the caption layer's OWN ramp  → the caption label (it IS the paint);
 *   - the drilled DIVISION ramp     → the base choropleth's label, demoted to
 *                                     counts ("… (conteo)") to match the popup;
 *   - no ramp at all                → the caption label (names the point overlay).
 */
export function legendRampTitle(input: {
  bivariateActive: boolean;
  captionLabel: string | null;
  /** captionLayer paints its OWN province-grain classed ramp this frame. */
  captionPaintsProvinceRamp: boolean;
  /** The DRILLED division fill's label (base choropleth) when it paints the ramp. */
  divisionRampLabel: string | null;
}): string {
  if (input.bivariateActive) return "Intensidad combinada";
  if (input.captionLabel && input.captionPaintsProvinceRamp) return input.captionLabel;
  // The drilled division fill encodes raw COUNTS (v1) — say so, exactly as the
  // department popup does (map-popup.ts COUNT_READOUT_SUFFIX).
  if (input.divisionRampLabel) return `${input.divisionRampLabel} (conteo)`;
  return input.captionLabel ?? "Eventos por unidad";
}

/**
 * "· mejor" / "· peor" for a ramp's two ends — one vocabulary the reader learns
 * once, on every layer, in four characters. Empty when the caller declares no
 * polarity, so nothing is asserted that the layer has not said.
 */
function polarityMarks(higherIsBetter: boolean | undefined): { lo: string; hi: string } {
  if (higherIsBetter === undefined) return { lo: "", hi: "" };
  return higherIsBetter ? { lo: " · peor", hi: " · mejor" } : { lo: " · mejor", hi: " · peor" };
}

/**
 * Round-3 QA fix 6: low/high endpoint labels flanking the collapsed ramp, so
 * "what does dark mean" is answerable WITHOUT opening the pill (LegendPill.tsx
 * collapsed strip). Sequential: the classed domain's low/high breaks. Meta
 * (rate + compliance target): the target IS the anchor that makes the color
 * meaningful, so the high end names it explicitly ("70% meta") instead of a
 * bare quantile threshold. Mirrors legendRampColors' source precedence
 * (caption layer's own province ramp, else the drilled division ramp).
 * Extracted from PanoramaConsole (fase-3 split discipline) — pure, structural
 * inputs so this module stays free of the console's type graph.
 */
export function legendRampEndpointLabels(input: {
  bivariateActive: boolean;
  captionLayer: { dataType: string; complianceTarget?: number; censoredAtMax?: number } | null;
  /** The lifted classed breaks the caption layer's province fill paints, or null. */
  liftedBreaks: readonly number[] | null;
  divisionLegend: { hasRamp: boolean; min: number; max: number } | null;
  /**
   * True extremes of the PROVINCE features being painted, when the caller knows
   * them. Without this the province branch fell back to the interior class
   * breaks and published a range that was simply not the data's — Mortalidad
   * read "4 … 15" and the vet desert "67 … 79" against a real national
   * 24,6 → 80,7 (external design review P1-F3). Same defect the division branch
   * had fixed; it just never crossed over.
   */
  provinceExtent?: { min: number; max: number } | null;
  /**
   * The caption layer's declared polarity. When given, each endpoint says which
   * end is the alarm — the ramp carries that in colour (dark = alarm, PO
   * decision D4) and colour must never be the only carrier, the same WCAG 1.4.1
   * rule the tone glyphs already honour.
   *
   * The captured legend read "Acceso veterinario (actos/1.000) · 5 → 2.184"
   * with nothing to say that for THAT layer the low end is the bad news
   * (external design review P1-F1). Omit to print bare numbers.
   */
  higherIsBetter?: boolean;
}): { min: string; max: string } | null {
  const {
    bivariateActive,
    captionLayer,
    liftedBreaks,
    divisionLegend,
    provinceExtent,
    higherIsBetter,
  } = input;
  const polarity = polarityMarks(higherIsBetter);
  if (bivariateActive) return null;
  if (captionLayer && liftedBreaks) {
    if (liftedBreaks.length === 0) return null;
    const isMeta =
      captionLayer.dataType === "rate" && typeof captionLayer.complianceTarget === "number";
    const unit = captionLayer.dataType === "rate" ? "%" : "";
    // The ramp's endpoints describe the DATA, not the classifier. liftedBreaks
    // are the INTERIOR boundaries between classes, so reading the first and
    // last of them as min/max understates the real range — live 2026-07-25,
    // Mortalidad painted values from 1 to 63 under a legend reading "2 … 6",
    // and this is an EXPORTABLE surface: a PNG carrying a state seal published
    // a range off by an order of magnitude. divisionLegend already carries the
    // true extremes (the fallback branch below has always used them); the
    // classed branch was simply shadowing them.
    // Preference order, most truthful first: the division ramp's extent, then
    // the province features' extent, and only then the interior breaks — which
    // are a classifier artefact and describe the data by accident at best.
    const extent = divisionLegend?.hasRamp
      ? { min: divisionLegend.min, max: divisionLegend.max }
      : (provinceExtent ?? null);
    const lo = Math.round(extent ? extent.min : liftedBreaks[0]);
    const dataMax = extent ? extent.max : liftedBreaks[liftedBreaks.length - 1];
    const hi = isMeta ? Math.round(captionLayer.complianceTarget as number) : Math.round(dataMax);
    // A meta endpoint already states the direction ("95% meta"), so a polarity
    // word there would be noise on top of a target.
    if (isMeta) return { min: `${lo}${unit}${polarity.lo}`, max: `${hi}${unit} meta` };
    // RIGHT-CENSORED endpoint: the layer stopped measuring here, so the number
    // is a bound and must read as one. Without the "≥" the desierto legend
    // printed "90 / 90" — two identical numbers presented as a range, when the
    // truth is "everything is at or past the point where we stopped looking".
    const censor = captionLayer.censoredAtMax;
    const hiIsCensored = typeof censor === "number" && hi >= censor;
    return {
      min: `${lo}${unit}${polarity.lo}`,
      max: hiIsCensored
        ? `≥${Math.round(censor)}${unit}${polarity.hi}`
        : `${hi}${unit}${polarity.hi}`,
    };
  }
  if (divisionLegend?.hasRamp) {
    return {
      min: Math.round(divisionLegend.min).toLocaleString("es-AR"),
      max: Math.round(divisionLegend.max).toLocaleString("es-AR"),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filtro counter semantics (item 3).
// ---------------------------------------------------------------------------

/**
 * The Filtro badge count — "active map modifiers beyond the vista's defaults".
 *
 * The PO's complaint: the old badge counted only active OVERLAY layers ("el
 * contador está malito, o debería contar más que capas"). The documented rule:
 *
 *   count =  (# active OVERLAY layers: signal + reference; the base is implicit
 *             and never counted)
 *          + (# non-default FILTERS deviating from the active vista's defaults):
 *              · base layer re-based away from the vista's default base   → +1
 *              · period differs from the vista's default periodPreset      → +1
 *              · "solo firmado por matrícula" (verifiedOnly) is ON **and an
 *                active layer honours it** (verifiedOnlyIsHonored)         → +1
 *
 * DELIBERATELY EXCLUDED: the aggregation `level` — it is camera/zoom-derived
 * (hysteresis), not a deliberate operator filter, so counting it would make the
 * badge jump on pan/zoom. In manual/advanced mode (no active vista) there is no
 * "vista default" base, and the period baseline is the app default preset.
 */
export function countFiltroModifiers(input: {
  /** All currently active layer ids (base + overlays). */
  activeLayerIds: readonly LayerId[];
  /** The active vista, or null (manual/advanced mode). */
  presetId: PresetId | null;
  /** The layer currently painting the choropleth (the base), or null. */
  baseLayerId: LayerId | null;
  /** The committed period preset id (e.g. "90d"). */
  activePeriod: string;
  /** The "solo firmado por matrícula" numerator toggle. */
  verifiedOnly: boolean;
}): number {
  const overlays = input.activeLayerIds.filter((id) => {
    const layer = getLayer(id);
    if (!layer) return false;
    const role = roleOf(layer);
    return role === "signal" || role === "reference";
  }).length;

  let deviations = 0;
  const preset = input.presetId ? getPreset(input.presetId) : null;
  if (preset) {
    if (input.baseLayerId != null && input.baseLayerId !== preset.base) {
      // D1: a metric-selector option's base is a vista DEFAULT (one of the
      // curated metrics), not an operator filter deviation — only a base
      // re-based OUTSIDE the declared options counts.
      const isMetricOptionBase =
        preset.metricOptions?.some((o) => o.base === input.baseLayerId) === true;
      if (!isMetricOptionBase) deviations += 1;
    }
    if (input.activePeriod !== preset.periodPreset) deviations += 1;
  } else if (input.activePeriod !== PANORAMA_DEFAULT_PRESET) {
    deviations += 1;
  }
  // Only counted when an active layer actually honours it (review 2026-08-22,
  // M7). The toggle is sticky — it survives a base-layer change and rides in the
  // URL — so a badge that counts it regardless claims a modifier that changed
  // none of the numbers on screen. Same predicate the view caption uses, so the
  // badge and the shared-link summary can never disagree.
  if (input.verifiedOnly && verifiedOnlyIsHonored(input.activeLayerIds)) deviations += 1;

  return overlays + deviations;
}

/**
 * Item 3 — the bare Filtro/Capas badge number read as a LAYER count ("2" next to
 * "Capas del mapa" looks like "2 layers"), but it is the deliberate
 * modifiers-beyond-the-vista counter ({@link countFiltroModifiers}). These two
 * pure helpers stop the number from masquerading as a layer count by NAMING both
 * facts:
 *
 *   - {@link describeCapasMeta} — the panel-header meta line surfacing BOTH the
 *     real active-layer count AND the modifier count, each labelled.
 *   - {@link filtroBadgeAriaLabel} — the badge's accessible name / tooltip, so the
 *     bare number announces "N ajustes sobre la vista" instead of a lone integer.
 */
export function describeCapasMeta(input: {
  /** Real count of active layers on the map (base + overlays). */
  activeLayerCount: number;
  /** Modifiers beyond the vista's defaults (the badge number). */
  modifierCount: number;
}): string {
  const capas =
    input.activeLayerCount === 1 ? "1 capa activa" : `${input.activeLayerCount} capas activas`;
  const ajustes =
    input.modifierCount === 1
      ? "1 ajuste sobre la vista"
      : `${input.modifierCount} ajustes sobre la vista`;
  return `${capas} · ${ajustes}`;
}

/**
 * "N capas" / "1 capa" — the plain active-layer count, pluralized ONCE.
 *
 * Two surfaces state this number (the dock's meta line and the ContextBar's
 * Capas segment) and a third was about to. Hand-rolling the ternary at each of
 * them is how "cuántas capas hay" becomes three answers; they cite this instead.
 * Note this is NOT {@link filtroBadgeAriaLabel}'s number — that one counts
 * modifiers over the vista, which is why both are named wherever both appear.
 */
export function capasCountLabel(activeLayerCount: number): string {
  return activeLayerCount === 1 ? "1 capa" : `${activeLayerCount} capas`;
}

/** The Capas badge's accessible name / tooltip — names what the number counts. */
export function filtroBadgeAriaLabel(modifierCount: number): string {
  return modifierCount === 1
    ? "1 ajuste sobre la vista"
    : `${modifierCount} ajustes sobre la vista`;
}
