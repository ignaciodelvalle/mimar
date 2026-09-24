// screenViewExplanation — the ON-SCREEN trim of the shared view sentence.
//
// PO observation (marked-up screenshot, /admin/panorama?preset=sintomas): four
// consecutive lines said the same thing three times —
//
//   [Nacional · todas las provincias]                        ← the scope selector
//   Vista · Síntomas / vigilancia sindrómica                 ← the vista title
//   Síntomas / vigilancia sindrómica — Argentina (todas las
//   provincias), últimos 30 días. Capas: Zoonosis / señales,
//   Síntomas / vigilancia sindrómica.                        ← this caption
//
// — while the numbers in the SAME column were truncated ("Señales de zoonosis
// (períod…", "activas hoy: 94 (rabia + mordeduras + 3…"). Repeated words were
// eating the space the data needed.
//
// WHY THIS IS NOT A FIX TO THE SHARED BUILDER: `explainViewState` feeds four
// consumers — "Copiar vista", the one-page informe, the embed a11y label, and
// this on-screen block. In the first three the redundancy is CORRECT: a sentence
// that travels alone needs its subject and its geography. Only the on-screen
// copy sits inside a container that already states both, so only the on-screen
// copy trims. The builder stays the single source of truth; this module is a
// PROJECTION of its output, never a second copy of its phrasing.
//
// The rule that decides what survives: does this string state something its
// container has not already stated? Surviving → the window, the as-of cut and
// its basis, the verified-only filter, the encoding, and any layer the vista
// title does not already name.

import { getLayer } from "@/src/modules/panorama/domain/layers";
import { getPreset } from "@/src/modules/panorama/domain/presets";
import type { PanoramaViewState } from "@/src/modules/panorama/domain/view-state";
import {
  type ExplainNames,
  explainViewState,
} from "@/src/modules/panorama/domain/view-state-caption";

/**
 * A sentinel the shared builder will echo IN PLACE OF the scope phrase.
 *
 * Every scope phrase the builder can emit is either a fixed national string or
 * one of the display names WE pass in (`provinceLabel` / `localityLabel` /
 * `boundedScopeLabel`) — and `boundedScopeLabel` wins for national scope. So
 * feeding all three the same sentinel makes the scope span, and ONLY the scope
 * span, identifiable in the output: "␟" (province/national) or "␟, ␟"
 * (locality). Everything after the last sentinel is scope-free by construction.
 *
 * This is why the trim survives the builder changing its phrasing: it never
 * re-derives what the scope reads like, it asks the builder to mark it.
 * U+241F is the printable "unit separator" glyph — it cannot occur in copy.
 */
const SCOPE_MARK = "␟";

/** The builder's own layers-clause opener — the one literal this trim shares
 *  with it, pinned by a test that compares against `explainViewState`. */
const LAYERS_CLAUSE = " Capas: ";

/** es-AR sentence case for the surviving head (the window phrase is lowercase
 *  mid-sentence in the full version: "…, últimos 30 días"). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toLocaleUpperCase("es-AR") + text.slice(1);
}

/**
 * The layers clause for the screen: the active layers MINUS any whose label is
 * the vista's own label (today exactly one vista does this — `sintomas`, whose
 * base layer is named after it; `pnpm exec tsx scripts/inventory-reachability.ts`
 * is the census).
 *
 * When something was dropped the wording changes to "Otra(s) capa(s)": a bare
 * "Capas: Zoonosis / señales." over a two-layer map would be a FALSE claim
 * about how many layers are painting. The trimmed list is honest only if it
 * announces that it is partial.
 */
function layersClause(view: PanoramaViewState): string {
  const vistaLabel = view.preset ? getPreset(view.preset)?.label : undefined;
  const labels = view.layers
    .map((id) => getLayer(id)?.label)
    .filter((l): l is string => l !== undefined);
  const kept = labels.filter((l) => l !== vistaLabel);

  if (kept.length === 0) return "";
  const partial = kept.length < labels.length;
  const head = partial ? (kept.length === 1 ? "Otra capa" : "Otras capas") : "Capas";
  return ` ${head}: ${kept.join(", ")}.`;
}

/**
 * Build the on-screen view caption: the shared sentence with the vista head and
 * the scope phrase removed (the header and the scope selector state both), and
 * the layers clause rebuilt without the layer the vista title already names.
 */
export function screenViewExplanation(view: PanoramaViewState, names?: ExplainNames): string {
  const marked = explainViewState(view, {
    ...names,
    provinceLabel: () => SCOPE_MARK,
    localityLabel: () => SCOPE_MARK,
    boundedScopeLabel: SCOPE_MARK,
  });

  // Everything up to and including the last mark is "{vista} — {alcance}".
  const lastMark = marked.lastIndexOf(SCOPE_MARK);
  // Defensive: a builder that stopped consulting the name resolvers would leave
  // no mark. Falling back to the full sentence keeps the screen honest (merely
  // redundant) instead of silently emitting a mangled one.
  if (lastMark < 0) return explainViewState(view, names);
  const body = marked.slice(lastMark + SCOPE_MARK.length).replace(/^,\s*/, "");

  const clauseAt = body.indexOf(LAYERS_CLAUSE);
  const head = clauseAt < 0 ? body : body.slice(0, clauseAt);

  return capitalize(head) + layersClause(view);
}
