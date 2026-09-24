// Panorama ViewState — "explain this view" (task #50 P5 gift, proof-of-value).
//
// `explainViewState(view)` turns the canonical value into one honest es-AR
// sentence describing the WHOLE view — the preset, the scope, the window, the
// scrub cut + basis, the verified filter, and the active layers. This is the
// "Copiar vista" / export description the PO wants, and it is the PROOF that the
// P1a value is complete: a ViewState is fully describable in words BECAUSE every
// surface projects from it. If a field could not be described here, it would be a
// hidden coordinate — the thing this refactor exists to abolish.
//
// Complements `captionFor` (which describes ONE layer's encoding on the map);
// this describes the whole selection. Pure — NO @/db, NO next, NO React.
//
// es-AR user copy, English identifiers (project invariant #4).

import { getLayer } from "./layers";
import { getPreset } from "./presets";
import type { AggregationLevel, LayerId } from "./types";
import type { PanoramaViewState } from "./view-state";

/**
 * The layers that actually narrow their numbers under "solo firmado por
 * matrícula". Today: cobertura, and only cobertura — the toggle is a
 * rabies-numerator narrowing, the console sends `?verified=1` for no other
 * layer, and the other layers could not honour it even if asked (a composite
 * whose rabies arm counted vet-signed doses while its other arms counted all of
 * them would be a number with no definition).
 *
 * This lives here because the two surfaces that DECLARE the toggle — this
 * caption and the Filtro badge counter (components/panorama/panorama-labels.ts)
 * — must agree on when the declaration is true. One list, two readers.
 *
 * WHY IT EXISTS (review 2026-08-22, M7): the toggle is sticky. It survives a
 * base-layer change and rides in the URL, while the checkbox itself leaves the
 * screen. Both declarations were unconditional, so the shared link's summary,
 * the embed label and the printed "Informe de situación" announced
 * "solo con firma veterinaria" next to "Capas: Índice territorial" — a
 * ministerial artefact declaring a filter that no number in it respected, with
 * no way for the reader downstream to tell.
 */
export const VERIFIED_ONLY_HONORING_LAYERS: readonly LayerId[] = ["cobertura"];

/**
 * Is the "solo firmado por matrícula" filter actually doing something to what is
 * on screen? True only when at least one active layer honours it.
 */
export function verifiedOnlyIsHonored(layers: readonly LayerId[]): boolean {
  return layers.some((id) => VERIFIED_ONLY_HONORING_LAYERS.includes(id));
}

/** Optional display-name resolvers — the console has the human province/locality
 *  names (the ViewState stores ISO codes). Absent → the code is shown as-is. */
export type ExplainNames = {
  provinceLabel?: (code: string) => string | undefined;
  localityLabel?: (province: string, locality: string) => string | undefined;
  /**
   * Honesty override for a BOUNDED operator. A govt operator with no explicit
   * drill still carries a `national` ViewState scope — but their DATA is scoped
   * to their assigned jurisdiction(s) by the loaders. Naming the nation
   * ("Argentina (todas las provincias)") would lie about the projection
   * geography. Pass the honest jurisdiction label (e.g. "Tierra del Fuego, Santa
   * Cruz, CABA") and it replaces the national phrase.
   */
  boundedScopeLabel?: string;
  /**
   * The administrative grain the MAP is currently rendering. When the scope is
   * national but the map has auto-disaggregated to department grain, the national
   * phrase is qualified ("Argentina · nivel departamento") so the footer never
   * implies a province-level "todas las provincias" over a department choropleth.
   * Ignored once `boundedScopeLabel` applies or the scope is province/locality.
   */
  renderLevel?: AggregationLevel;
};

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const PERIOD_PHRASE: Record<string, string> = {
  "7d": "últimos 7 días",
  "30d": "últimos 30 días",
  "90d": "últimos 90 días",
  ytd: "en lo que va del año",
  trailing12m: "últimos 12 meses",
  "3y": "últimos 3 años",
  "5y": "últimos 5 años",
};

/** "1 de mayo de 2026" from an ISO timestamp; the raw string if unparseable. */
function formatSpanishDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

function scopePhrase(view: PanoramaViewState, names?: ExplainNames): string {
  switch (view.scope.kind) {
    case "national":
      // A bounded operator's data is narrower than the nation — name their real
      // jurisdiction instead of claiming "todas las provincias" (Finding #1).
      if (names?.boundedScopeLabel) return names.boundedScopeLabel;
      // National scope but the map disaggregated to department grain — qualify the
      // phrase so it never contradicts the on-screen grain (Finding #1, admin).
      if (names?.renderLevel === "locality") return "Argentina · nivel departamento";
      return "Argentina (todas las provincias)";
    case "province": {
      const label = names?.provinceLabel?.(view.scope.province) ?? view.scope.province;
      return label;
    }
    case "locality": {
      const prov = names?.provinceLabel?.(view.scope.province) ?? view.scope.province;
      const loc =
        names?.localityLabel?.(view.scope.province, view.scope.locality) ?? view.scope.locality;
      return `${loc}, ${prov}`;
    }
  }
}

function periodPhrase(view: PanoramaViewState): string {
  if (view.period.kind === "custom") {
    return `del ${formatSpanishDate(view.period.from)} al ${formatSpanishDate(view.period.to)}`;
  }
  return PERIOD_PHRASE[view.period.preset] ?? view.period.preset;
}

/** The active-layer labels in activation order (unknown ids skipped). */
function layerLabels(view: PanoramaViewState): string[] {
  return view.layers.map((id) => getLayer(id)?.label).filter((l): l is string => l !== undefined);
}

/**
 * True when EVERY active layer is a current-state snapshot (`temporal: false`).
 *
 * Those layers ignore `view.period` outright — their window is fixed inside the
 * metric (rabies coverage is always trailing-12m) and the picker's selection
 * never reaches the query. Echoing "últimos 3 años" beside them declares a
 * window that is not true of a single number on screen. This caption used to do
 * exactly that, deliberately: embed-view.ts documented that the period is
 * carried "so the caption states the same window the screen's PeriodPicker
 * shows" — while admitting in the same breath that the choropleths ignore it.
 * QA (Cowork, ronda 5, 2026-07-16) filed the contradiction as CRÍTICO: the
 * footer read "CABA · últimos 3 años (1095 días)" over a metric labelled
 * "(perros, 12m) · ESTADO ACTUAL". PO call: the caption tells the truth about
 * the DATA; matching the picker is not a reason to misdescribe a number.
 *
 * A MIXED view keeps the period — it is true of at least one active layer, and
 * dropping it would hide a filter that really is doing something. An empty view
 * keeps it too: there is no number for it to misdescribe.
 */
/**
 * True when every active layer is a current-state layer, so a period label
 * would describe a window none of the numbers on screen respect.
 *
 * Exported and keyed on IDS because there are TWO clocks on the console — this
 * caption and the dock's `buildViewMeta` — and only this one had the rule. The
 * card said "Estado actual" while the dock stamped "últimos 90 días" over the
 * same numbers (external design review P1-F4). Two derivations of one rule is
 * how they came apart; one derivation is how they stay together.
 */
export function layerIdsAreAllCurrentState(ids: readonly LayerId[]): boolean {
  const layers = ids.map((id) => getLayer(id)).filter((l) => l !== undefined);
  return layers.length > 0 && layers.every((l) => l.temporal === false);
}

function allLayersAreCurrentState(view: PanoramaViewState): boolean {
  return layerIdsAreAllCurrentState(view.layers);
}

/**
 * Build the one-line es-AR description of the whole view. Structure:
 *
 *   "{Preset label o 'Vista personalizada'} — {scope}, {período}[, al {fecha}
 *    (tiempo de {validez|transacción})][, solo con firma veterinaria].
 *    Capas: {labels}."
 *
 * Every ViewState field that changes what the operator sees appears here — since
 * P5 that includes an explicit encoding selection (it round-trips the URL). The
 * remaining ephemerals (basis default, representation=dock tab) do not, because
 * they do not change the DATA in view — only how the current surface presents it.
 */
export function explainViewState(view: PanoramaViewState, names?: ExplainNames): string {
  const preset = view.preset ? getPreset(view.preset) : undefined;
  const head = preset?.label ?? "Vista personalizada";

  // "estado actual" is the same phrase captionFor already uses for a `current`
  // window (caption.ts windowPhrase) — the two caption paths now agree.
  const when = allLayersAreCurrentState(view) ? "estado actual" : periodPhrase(view);
  const parts: string[] = [`${scopePhrase(view, names)}, ${when}`];

  if (view.asOf !== null) {
    const basisPhrase = view.basis === "transaction" ? "transacción" : "validez";
    parts.push(`al ${formatSpanishDate(view.asOf)} (tiempo de ${basisPhrase})`);
  }

  // Declared only when an active layer honours it — see
  // VERIFIED_ONLY_HONORING_LAYERS. A sticky toggle that narrows nothing on
  // screen must not be announced as if it did.
  if (view.verifiedOnly && verifiedOnlyIsHonored(view.layers)) {
    parts.push("solo con firma veterinaria");
  }

  // P5: encoding became a shareable coordinate (?encoding= round-trips), so an
  // explicit selection is part of what the link reproduces — say it.
  if (view.encoding === "bivariate") {
    parts.push("riesgo combinado (bivariado)");
  }

  const labels = layerLabels(view);
  const layersClause = labels.length > 0 ? ` Capas: ${labels.join(", ")}.` : "";

  return `${head} — ${parts.join(", ")}.${layersClause}`;
}
