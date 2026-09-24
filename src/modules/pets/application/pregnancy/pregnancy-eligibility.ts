// Can THIS animal open a pregnancy? — the one predicate every surface asks.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A FOURTH COPY OF THE RULE
// ---------------------------------------------------------------------------
// The rule "female, of a species this build can date, with no pregnancy already
// open" was written out three times before this file: in the writer
// (`record-pregnancy-started.ts`, which is authoritative because it refuses),
// in the web's `eventos/nuevo/embarazo` page, and in the phone's
// `record-event-view-model.ts` (`pregnancyRows`). The web needed a fourth to
// gate a menu entry, and a fourth copy of a rule that had already drifted once
// is how the drift becomes permanent. So this is the shared one, and it reads
// the writer's own table rather than restating it.
//
// IT HAD ALREADY DRIFTED. `PREGNANCY_DURATION_DAYS` was widened on 2026-09-07
// (PO decision) from {dog, cat, other} to every species in `PET_SPECIES` —
// rabbit, guinea pig and ferret all gestate and all were refused before that.
// The phone's copy tracked the change. The web page's `ALLOWED_SPECIES` literal
// did not, so until this file the web refused a pregnant rabbit the writer
// would have accepted. That literal is gone; the page calls this instead.
//
// THE NULL ARMS ARE STRICT HERE, AND THAT IS A DELIBERATE DIVERGENCE FROM THE
// PHONE rather than an oversight. `pregnancyRows` treats `sex: null` and
// `species: null` as "offer it anyway", because on the phone a `null` is what a
// DEGRADED READ leaves behind and hiding a capability behind a failed request
// is a dead end nobody can see. Every caller here is a server component holding
// the `pets` row itself: a `null` is not a read that failed, it is a column the
// owner never filled. Offering the form for it would route somebody to a page
// whose only outcome is the writer's refusal — the exact failure the phone's
// rule avoids, arrived at from the other direction. Same rule, different
// epistemics.

import { PREGNANCY_DURATION_DAYS } from "./record-pregnancy-started";

/** The pet facts the rule reads. All three are columns on `pets`. */
export type PregnancyEligibilityFacts = {
  sex: string | null;
  species: string | null;
  pregnancyStatus: string | null;
};

/**
 * Does this build know a gestation length for the species?
 *
 * Derived from the writer's table on purpose — see the header. Today every
 * member of `PET_SPECIES` has an entry (fenced by `__tests__/pregnancy-flow`),
 * so this half of the rule discriminates nothing a real row can hit. It is kept
 * because the table is what makes that true, and the day a species is added
 * without a gestation this is the check that withholds the menu entry instead
 * of routing somebody into `Invalid Date`.
 */
export function speciesCanCarryPregnancy(species: string | null): boolean {
  return species !== null && Object.hasOwn(PREGNANCY_DURATION_DAYS, species);
}

/**
 * May a pregnancy be OPENED for this animal right now?
 *
 * The three clauses are the writer's three refusals, in its order: `hembras`,
 * `Especie no soportada`, `ya tiene un embarazo en seguimiento`. A caller that
 * gets `true` and still lands on a refusal means this function and the writer
 * disagree, which is the bug this file exists to make impossible.
 */
export function canStartPregnancy(facts: PregnancyEligibilityFacts): boolean {
  return (
    facts.sex === "female" &&
    speciesCanCarryPregnancy(facts.species) &&
    facts.pregnancyStatus !== "in_progress"
  );
}
