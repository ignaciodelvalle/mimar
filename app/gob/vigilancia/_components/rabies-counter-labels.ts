// The es-AR copy for the TWO rabies counters /gob/vigilancia publishes on the
// same screen, kept together (and pure) so they can be read — and tested —
// against each other instead of drifting apart in two distant JSX blocks.
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS MODULE EXISTS TO PREVENT (demo review 2026-08-01, finding #5)
// ---------------------------------------------------------------------------
// The screen showed "RÁBICAS ACTIVAS 12" with a Peligro badge and, a few tiles
// away, "vs 1 observaciones rábicas abiertas". Under a CABA scope the same pair
// read 0 and 1. Two near-identical rabies labels, two different numbers, and
// nothing on the page saying they were not the same counter — with this
// audience, rabies is THE number, so a contradiction there costs the demo.
//
// They are genuinely different populations:
//
//   CASES  — `cases` rows with case_kind='rabies_observation' AND status='open'
//            (lib/analytics/dashboards/surveillance.ts, rabiesActiveCount).
//            The unit is an EXPEDIENTE.
//   PETS   — `pets.rabies_observation_status = 'in_progress'`
//            (lib/analytics/govt-home-kpis.ts, fetchOpenRabiesObservations).
//            The unit is an ANIMAL under observation right now.
//
// So the fix is not to reconcile the numbers in the UI (they answer different
// questions and the catalog defines both) — it is to make each label name the
// thing it counts, so a reader can tell at a glance that "12 expedientes" and
// "1 mascota" are not two answers to one question. That the two drift as far
// apart as 12 vs 1 on live data is a DATA issue reported separately; this
// module's job is that the screen stops presenting them as one contradicted
// figure.
//
// English identifiers, es-AR user copy (project invariant #4).

import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { pluralizeEs } from "@/lib/utils/format";

/**
 * KPI-tile label for the CASE-record counter. Taken from the catalog rather
 * than hand-written on the screen: the catalog already says "Casos de
 * observación rábica abiertos" (it names the unit), while the tile had
 * hard-coded the vague "Rábicas activas" — which names neither the unit nor
 * the fact that it is a stock of open files.
 */
export const RABIES_CASES_KPI_LABEL = KPI_CATALOG.rabies_observation_cases_open.label;

/**
 * THE THIRD COUNTER, and why it is not on this screen (master test CIU, L-1).
 *
 * The discipline above stopped at this file's own two tiles. A THIRD rabies
 * figure lives on the /gob briefing — `open_rabies_observations`, the PETS
 * counter — and it was still labelled "Observaciones rábicas abiertas", naming
 * no unit at all. A funcionario comparing the two screens therefore met 1 here,
 * 3 there and "8 vs 1" in the escalation tile, and read them as one number
 * contradicting itself — on the figure that decides whether a biting animal has
 * to be chased down. Its catalog label now names its unit too ("Mascotas en
 * observación rábica").
 *
 * Unifying the three would be the wrong fix: they are different populations and
 * the catalog's `exclusions` has said so in full the whole time. The defect was
 * never the arithmetic — it was that the screens did not say what they counted.
 */

/**
 * The disambiguating caveat carried by the CASE counter's info popover. Points
 * at the other two rabies figures on the same screen and says what each one is
 * for, so the operator never has to guess which number a question is about.
 */
// The compliance tile's name is INTERPOLATED, not retyped. It was a literal
// until 2026-09-16, and a rename that same day left this sentence pointing at a
// tile that no longer existed. The retype fence (`check-metric-labels.ts`) scans
// {app,components}/**/*.tsx and cannot see a `.ts` file, so nothing went red —
// and the test below pinned the stale string, so it would not have noticed
// either. One line up, the same file was already doing this correctly.
export const RABIES_CASES_KPI_CAVEAT = `Cuenta EXPEDIENTES abiertos, no animales. El tile «Brecha de escalamiento» de esta misma pantalla cuenta MASCOTAS con una observación en curso hoy (otra fuente, otra población): los dos números pueden no coincidir y ninguno es el veredicto de plazo legal — ese vive en «${KPI_CATALOG.rabies_observation_compliance_10d.label}».`;

/**
 * Sub-line for the bite-escalation tile, naming the PET population so it cannot
 * be read as a second, contradictory count of the case tile above it.
 *
 * Keeps the epistemic clause the tile has always carried: an empty observation
 * queue reads as "controlado" when it may mean "sin escalar" (red-team #6).
 */
export function biteEscalationSub(openObservations: number): string {
  const noun = pluralizeEs(openObservations, "mascota");
  return `vs ${openObservations} ${noun} en observación rábica hoy — la ausencia de escalamiento no implica ausencia de riesgo`;
}
