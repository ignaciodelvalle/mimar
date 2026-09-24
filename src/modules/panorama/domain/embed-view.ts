// Frozen ViewState builder for the gob analytics map embeds (#51).
//
// The gob analytics screens render a "national-with-narrowing" choropleth:
// national by default, fenced DOWN to the operator's assignments server-side by
// /api/panorama/[layer] (an embed can never widen scope). This builder produces
// the FROZEN, NATIONAL-scope ViewState those screens hand to <PanoramaEmbed>.
//
// Why national (unscoped) and not the page's resolved jurisdiction:
//   - The route narrows govt scope from the session (narrowGovtScope), so an
//     unscoped view reproduces the page's govt-assignment posture WITHOUT the
//     embed ever widening — exactly the task #51 "route narrows for govt" rule.
//   - National scope keeps the PROVINCE aggregation axis (scopeForcesLocality =
//     false). The migrated rate choropleths (esterilizacion) emit ratePct ONLY at
//     province level; a province/locality-scoped view would flip the embed to the
//     locality count-density axis (a DIFFERENT metric — rate-by-locality is a
//     deferred v1 gap), so a rate choropleth must stay national to stay faithful.
//
// Pure — NO @/db, NO next, NO React (hexagonal domain purity, enforced by the
// biome noRestrictedImports override for src/modules/*/domain/**).

import type { LayerId } from "./types";
import { type AnalyticsPeriodPreset, type PanoramaViewState, makeViewState } from "./view-state";

/**
 * Build the frozen national-scope ViewState a gob analytics screen embeds for a
 * single map layer.
 *
 * `period` is the screen's OWN default window. The current-state choropleths
 * (esterilizacion et al.) ignore it — they are point-in-time snapshots, not
 * event-windowed — but it is carried so the embed's a11y caption
 * (`explainViewState`) states the same window the screen's PeriodPicker shows.
 */
export function gobEmbedView(layer: LayerId, period: AnalyticsPeriodPreset): PanoramaViewState {
  return makeViewState({
    scope: { kind: "national" },
    layers: [layer],
    period: { kind: "preset", preset: period },
  });
}
