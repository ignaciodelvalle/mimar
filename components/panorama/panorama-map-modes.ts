// panorama-map-modes — the pure model behind the map's "Modo" switcher.
//
// Extracted from PanoramaConsole: the segment list, the active value, and the
// honest note under it are a `(capabilities, view state) → control model`
// projection. ModeSwitcher stays dumb presentation; the console owns the state
// and only wires onChange. Keeping this pure means the refusal copy (the part
// that must never lie about WHY a mode is unavailable) is unit-testable.

import type { ModeOption } from "@/components/panorama/ModeSwitcher";
import type { ActiveLayer } from "@/components/panorama/SituationalMap";
import { BIVARIATE_MIN_UNITS, type BivariatePair } from "@/src/modules/panorama/domain/bivariate";
import type { MapMode } from "@/src/modules/panorama/domain/capabilities";
import { isPercapitaEligible } from "@/src/modules/panorama/domain/percapita";
import type { AggregationLevel, LayerId } from "@/src/modules/panorama/domain/types";

// task #24 fase 1 — the "Modo" switcher: ONE control projecting the gate's
// declarative mode list (capabilities.mapModes). The bivariate constraints
// stay console-owned (they read live caches/scrub state the domain doesn't
// hold): the join can't mix a frozen cobertura with an as-of zoonosis frame
// (live-edge only) and needs enough comparable units to classify (WARNING 7).
// #33 modes (delta/lag/as-of/heatmap) append options here, never new toggles.
// C2 language contract (2026-07-22, red-team #5): the bivariate join crosses
// LOW COVERAGE × HIGH SIGNALS — that is reporting/registration INTENSITY,
// not epidemiological risk (a province can rank "high" here purely because
// its padrón is thin, with zero actual outbreaks). "Riesgo (bivariado)" read
// as a risk verdict; every render site below now says "intensidad de
// reporte" instead, and the computation is UNCHANGED (only the label lies
// less).
const MODE_LABELS: Record<string, string> = {
  auto: "Capas",
  bivariate: "Intensidad de reporte (bivariado)",
  percapita: "Per cápita (por 10.000 hab.)",
};

export type MapModeControlModel = {
  /** The selectable segments, in display order. */
  options: ModeOption[];
  /** The ACTIVE segment id ("" while a selection is suspended). */
  value: string;
  /** The card's sub-line (what the modes answer). */
  sub: string;
  /** The live note under the segments (why a segment is disabled), or null. */
  note: string | null;
};

/**
 * Distinct es-AR copy per refusal reason: "count" → too few comparable
 * jurisdictions; "tercile" → values too alike to cut honestly; "suppressed"
 * → the cross would render almost entirely hatched (see bivariate.ts).
 */
export function bivariateRefusalNoteFor(
  reason: "count" | "tercile" | "suppressed" | null,
): string | null {
  if (reason === "count") {
    return `La intensidad de reporte combinada necesita al menos ${BIVARIATE_MIN_UNITS} jurisdicciones con datos comparables en ambas capas; en esta vista hay menos (por supresión de privacidad o falta de datos).`;
  }
  if (reason === "tercile") {
    return "Los valores de esta vista son demasiado parecidos para cortar en niveles de intensidad honestos.";
  }
  if (reason === "suppressed") {
    return "En esta vista el cruce quedaría casi todo protegido por k-anonimato: el mapa mostraría trama en vez de datos. Se muestran las capas por separado, que sí se leen.";
  }
  return null;
}

export function buildMapModeControlModel(input: {
  mapModes: readonly MapMode[];
  activeLayers: readonly ActiveLayer[];
  level: AggregationLevel;
  scrubbing: boolean;
  bivariateEligible: boolean;
  bivariateActive: boolean;
  bivariateMode: boolean;
  bivariateDegenerate: boolean;
  bivariateDegenerateReason: "count" | "tercile" | "suppressed" | null;
  bivariatePair: BivariatePair | null;
  percapitaActive: boolean;
  percapitaMode: boolean;
  percapitaEligible: boolean;
  percapitaLayersEligible: boolean;
  percapitaHasCensus: boolean;
}): MapModeControlModel {
  const {
    mapModes,
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
    percapitaHasCensus,
  } = input;

  const bivariateRefusalNote = bivariateRefusalNoteFor(bivariateDegenerateReason);

  // panorama-percapita: honest per-cápita notes.
  //  - Drilled below province while the selection is on → EXPLICIT count
  //    fallback (requirement: a note, not a silent swap).
  //  - Eligible but the payload carries no census (stale cache / unseeded
  //    table) → honest no-data note instead of an inert toggle.
  const percapitaDrillNote =
    percapitaMode && percapitaLayersEligible && level !== "province"
      ? "Per cápita se calcula por provincia — en esta vista se muestra el conteo por unidad (no hay censo departamental todavía)."
      : null;
  const percapitaNoCensusNote =
    percapitaMode && percapitaEligible && !percapitaHasCensus
      ? "Sin datos del censo para esta vista — se muestra el conteo."
      : null;
  // panorama-percapita (F3): a per-cápita-eligible layer that resolved to its
  // NEAR-band event-points mark serves REAL dots UN-enriched (get-layer-features
  // skips the census join for points-mode results), so census metadata is absent
  // for a reason that is NOT "no census data" and is NOT a department drill.
  // Explain the points view explicitly instead of the misleading no-census/drill
  // copy. Derived client-side from the SAME render mode the map paints — no new
  // prop threaded.
  const percapitaPointsNote =
    percapitaMode &&
    percapitaLayersEligible &&
    activeLayers.some((l) => isPercapitaEligible(l.id as LayerId) && l.renderMode === "points")
      ? "En la vista de puntos se muestran eventos individuales — la tasa per cápita aplica a la vista agregada por provincia."
      : null;

  const options: ModeOption[] = mapModes.map((id) => ({
    id,
    label: MODE_LABELS[id] ?? id,
    disabled: id === "bivariate" ? scrubbing || bivariateDegenerate : false,
    title:
      id === "bivariate"
        ? scrubbing
          ? "Intensidad de reporte — solo al último evento"
          : (bivariateRefusalNote ?? undefined)
        : undefined,
  }));
  // panorama-percapita: while the selection is ON but the view dropped below
  // province (a drill), the gate no longer offers "percapita" — keep the segment
  // VISIBLE but disabled so the fallback is explicit, never a silent vanish.
  if (percapitaMode && percapitaLayersEligible && !mapModes.includes("percapita")) {
    options.push({
      id: "percapita",
      label: MODE_LABELS.percapita,
      disabled: true,
      title: "Per cápita se calcula por provincia",
    });
  }
  // Department-grain per-cápita stays PHASE 2 (INDEC census import pending —
  // see percapita.ts). Its disabled "(en desarrollo)" roadmap option is HIDDEN
  // (#14, 2026-07-23): a visibly unfinished control reads as broken product;
  // the percapita drill-fallback note above already names the prerequisite.
  // The ACTIVE segment mirrors what the MAP paints: "auto" when the operator
  // hasn't selected an encoding; the encoding id while it actually renders; and
  // NO segment while the selection is suspended (mode on, mid-scrub/degenerate/
  // drilled) — the note below explains why. Preserves the pre-#24 visual semantics.
  const value = bivariateActive
    ? "bivariate"
    : percapitaActive
      ? "percapita"
      : bivariateMode || percapitaMode
        ? ""
        : "auto";

  return {
    options,
    value,
    sub: bivariateEligible
      ? (bivariatePair?.switcherSub ??
        "Cómo se pinta la vista — la intensidad de reporte cruza cobertura baja × señales altas")
      : "Cómo se pinta la vista — per cápita normaliza por población del censo",
    // Same visibility as pre-#24: the note explains the disabled segment
    // even before the operator selects it (only while an encoding is offered
    // at all — ModeSwitcher hides itself when mapModes is just ["auto"]).
    note:
      bivariateEligible && scrubbing
        ? "Intensidad de reporte — solo al último evento (la cobertura no se reconstruye en el tiempo)."
        : bivariateEligible && bivariateRefusalNote
          ? bivariateRefusalNote
          : (percapitaPointsNote ?? percapitaDrillNote ?? percapitaNoCensusNote),
  };
}
