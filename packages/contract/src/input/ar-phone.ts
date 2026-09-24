// Argentine phone-number heuristics — a SOFT HINT, never a refusal.
//
// The regex recognises the most common written forms in Argentina:
//   +54 9 11 1234-5678 | +5491112345678 | 011 15-1234-5678 | 11 1234-5678
//
// IT IS NOT VALIDATION AND MUST NEVER BECOME IT. `update-profile.ts` decided
// this and said why: "Phone fields no longer enforce AR format server-side — the
// client form surfaces a soft warning instead. Older landlines, satellite
// phones, and foreign numbers all save without error." A schema that rejected
// what this returns false for would refuse a person in Salta with a landline,
// which is why this file exports a PREDICATE and no zod schema uses it.
//
// WHY IT MOVED HERE FROM `lib/reference/ar-phone.ts` (WU-R, 2026-08-29)
// ---------------------------------------------------------------------------
// The native "editar mis datos" form needs the same nudge the web's does, and
// `lib/` is not reachable from `apps/mobile`. The alternative was a second copy
// of the regex in the app — two opinions about what an Argentine phone number
// looks like, drifting the first time either was tuned, on the field a rescuer
// dials when they find somebody's dog. That is precisely the drift this package
// exists to prevent, so the definition moved and `lib/reference/ar-phone.ts` now
// re-exports it: one regex, two clients, no third place to edit.
//
// ZERO DEPENDENCIES. It imports nothing, zod included — the package's purity
// fence permits zod and this does not need it.

export const AR_PHONE_RE =
  /^(\+?54\s?9?\s?\d{2,4}[\s-]?\d{4}[\s-]?\d{4}|0\d{2,4}\s?(?:15[\s-]?)?\d{4}[\s-]?\d{4}|\d{2,4}[\s-]?\d{4}[\s-]?\d{4})$/;

/**
 * `true` when the value looks like an Argentine number — or is EMPTY.
 *
 * The empty case answers `true` on purpose, and it is the one behaviour a reader
 * is likely to "fix": an empty optional field is not a badly-formatted number,
 * it is an unanswered question, and a form that warned about it would nag every
 * person who left the vet's phone blank.
 */
export function looksLikeArPhone(value: string): boolean {
  const trimmed = value.replace(/\s/g, " ").trim();
  return trimmed === "" || AR_PHONE_RE.test(trimmed);
}
