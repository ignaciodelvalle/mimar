// "Has this person typed anything?" — the question every discard guard has to
// answer before it may interrupt somebody (A2-alta-asentar-08).
//
// WHY THIS EXISTS AS ITS OWN MODULE. `useDraftDiscardGuard` shipped on
// 2026-09-07 with a single consumer. The writer screens it did not reach were
// not left out for want of a line — they were left out because nobody had
// solved THIS, and the wrong answer is worse than no guard at all:
//
// (The count that used to open this paragraph — "four of the twelve" — was
// prose nobody could reproduce, and the running log inherited it into a "9 of
// 12" that sat above a list of four exceptions. Ten modules call the guard
// today and four screens deliberately do not; `rg -l useDraftDiscardGuard` plus
// `app/alta.tsx` is the enumeration. Finding F12, review 2026-09-07.)
//
//   · `draft !== emptyDraft()` is object identity between two different
//     objects. It is `true` the instant the screen mounts, so every one of the
//     eleven asiento forms would ask "¿Salir sin guardar?" of somebody who
//     opened it, read the first field and pressed back. A guard that fires on a
//     person who typed nothing teaches them to dismiss it, and then it is not
//     there on the day they had filled in ten fields.
//   · Comparing against a freshly built `emptyDraft()` has a subtler version of
//     the same defect: that function reads the CLOCK (`occurredAt` and
//     `firstDoseDay` are today in Argentine time), so a screen open across
//     midnight would go dirty on its own with nobody touching it.
//
// THE ANSWER IS THE VALUE THIS SCREEN ACTUALLY STARTED WITH, captured once, in
// a ref. It is exact for a form seeded from the server (EditProfileScreen
// re-seeds its draft from the read, so "dirty" means "differs from what the
// server has"), exact for one seeded from a constant, and it cannot be true
// before the first edit by construction.

import { useRef } from "react";

/**
 * A flat bag of the fields a form owns. Values are primitives — every draft in
 * this app is a record of strings, enums and booleans — so a shallow comparison
 * is an exact one, and a nested object would be a silent false negative rather
 * than an approximate answer.
 */
export type DraftValues = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Same keys, same values. Key ORDER is irrelevant; a missing key is not. */
export function sameDraft(a: DraftValues, b: DraftValues): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Whether anything in `values` differs from what it was on the first render.
 *
 * The argument may be built inline (`useIsDirty({ email, note })`) — a new
 * object every render is fine and is the intended shape, because what is
 * captured is the first one and what is compared are the VALUES.
 *
 * IT NEVER GOES BACK TO CLEAN BY ACCIDENT, and it never has to: a person who
 * types a character and deletes it again has an unchanged form, and not asking
 * them is the right answer rather than a hole.
 */
export function useIsDirty(values: DraftValues): boolean {
  const initial = useRef(values);
  return !sameDraft(initial.current, values);
}
