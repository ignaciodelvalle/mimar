// The two rules a NAME has to satisfy to be a name at all.
//
// WHY THIS IS A MODULE AND NOT A LINE IN ONE SCHEMA
// ---------------------------------------------------------------------------
// It was a line in one schema. `complete-identity.ts` grew the predicate after
// the 2026-09-05 security review, and for exactly one door — signup step 2. The
// registry has four doors onto a human-readable name:
//
//   · signup step 2   → `completeIdentityInputSchema` (had the rule),
//   · alta step 1     → `registerPetInputSchema.name` (did not),
//   · Editar mascota  → `petProfileCommandInputSchema` edit_identity (did not),
//   · Mis datos       → `myProfileEditInputSchema.displayName` (did not).
//
// A rule that lives at one call site is a rule three other call sites do not
// have, and the hole is invisible: each of the three accepts a string that
// TRIMS to something non-empty, is one character long, and renders as nothing.
// So the predicate lives here and every door imports it.
//
// THE RULES, AND WHY THESE TWO
// ---------------------------------------------------------------------------
//   · NO CODE POINT THAT RENDERS AS NOTHING. That is the SUBJECT, and naming
//     the subject rather than a list of spellings is the whole lesson of this
//     module's second version — see below. It is expressed as two Unicode
//     properties, both of which are the standard's own answer to "this is not
//     visible text":
//       - `\p{C}` — the whole Other category: `Cc` (controls, newline
//         included), `Cf` (format: zero-width space, the bidi marks and
//         overrides, `U+FEFF`), plus `Cs`/`Co`/`Cn`. `"​"` is one character
//         long, SURVIVES `String.prototype.trim()` (it is `Cf`, not
//         `White_Space`, and has been since Unicode 4.0.1) and renders as
//         nothing — a pet whose credential shows a blank name, or a titular
//         whose display name is blank on the public page while every gate in
//         the product reports the identity complete. `U+202E`
//         (RIGHT-TO-LEFT OVERRIDE) is the same hole pointed the other way: it
//         reverses the rest of the line wherever it is displayed.
//       - `\p{Default_Ignorable_Code_Point}` — the property that says, in the
//         standard's own words, that a renderer should show nothing for this
//         code point. It is a SUPERSET of the `Cf` cases above and it catches
//         the four the first version missed.
//     REJECTED rather than STRIPPED, deliberately: a form that silently
//     rewrites what somebody typed is worse than one that says no, and the
//     person cannot see the difference to check it for themselves.
//   · AT LEAST ONE `\p{L}` — a name is written with letters. This is what
//     refuses `"12345"` and `"---"`, and it is also what makes the `Cn`
//     (unassigned) arm of `\p{C}` harmless in the only case it could be wrong:
//     a script so new that the runtime's tables do not know it would fail this
//     rule anyway, so the ban adds no refusal of its own.
//
// WHY THE FIRST VERSION LEAKED, AND WHY THE FIX IS A PROPERTY AND NOT FOUR
// MORE CHARACTERS
// ---------------------------------------------------------------------------
// The first version banned `\p{C}` and required `\p{L}`, and it was written
// from a LIST of the invisible characters somebody had thought of — the
// zero-width space, `U+FEFF`, the bidi overrides. Every one of them happens to
// be `Cf`, so `\p{C}` looked like it had banned the subject.
//
// It had not. The four Unicode HANGUL FILLERS — `U+3164`, `U+115F`, `U+1160`,
// `U+FFA0` — have General_Category **Lo**. They ARE `\p{L}`, they are NOT
// `\p{C}`, they are not `White_Space` so `.trim()` keeps them, and they render
// as nothing in every font. A display name of TWO U+3164 fillers — spelled out
// rather than pasted, because there is no glyph to read — therefore trims to
// length 2, SATISFIES the letter rule, and passed all five doors: a titular
// blank on their own credential, on the public `/p` page and in
// `/gob/historial`, while
// `isIdentityPending` reported the identity complete. The exact hole the rule
// was written to close, one general category over.
//
// Adding those four characters to a list would have been the same mistake a
// third time: the list would be right until Unicode assigns a fifth. What is
// added instead is the PROPERTY that describes them — a code point the standard
// itself marks as showing nothing — which is a claim about the SUBJECT and
// cannot be one member short.
//
// KNOWN CONSEQUENCE, DECIDED RATHER THAN MISSED: `Default_Ignorable_Code_Point`
// contains the VARIATION SELECTORS (`U+FE00`–`U+FE0F`), so an emoji typed in
// its emoji-presentation form — a heart followed by `U+FE0F` — is refused in a
// name where the same heart WITHOUT the selector is accepted. The registry
// prints this name on a credential; a name whose rendering depends on a code
// point the standard says
// to ignore is not one this door has to accept, and a carve-out would restore
// exactly the list-of-exceptions shape the paragraph above is about. Revisit
// with evidence that owners are being refused, not with a fifth spelling.
//
// DELIBERATELY NOT AN ALLOWLIST of letters and punctuation. `O'Connor`,
// `Ñandú-López`, `María José`, `D'Angelo`, `Pampa III` — every apostrophe,
// hyphen, space, accent, digit and particle a real Argentine name (or a real
// animal's) carries has to pass, and a list of the ones somebody thought of is
// a list that eventually refuses a real person on a national registry. These
// two rules ban what cannot be part of a name and let everything else through.

/**
 * A code point that cannot be part of a written name: the whole Unicode `Other`
 * category (controls, format, surrogates, unassigned) plus everything the
 * standard marks `Default_Ignorable_Code_Point` — which is where the four
 * Hangul fillers live, `\p{L}` and all.
 */
export const UNWRITABLE_CODE_POINT = /[\p{C}\p{Default_Ignorable_Code_Point}]/u;

/** At least one letter, in any script. */
export const HAS_A_LETTER = /\p{L}/u;

/**
 * Whether `value` can be shown to a person as a name.
 *
 * Length is NOT its business: each door bounds its own field, and the caps
 * differ (80 for a pet, 80 per identity half, 80 for a display name — but the
 * pet's is grandfathered against the stored value and the others are not).
 */
export function isWritableName(value: string): boolean {
  return !UNWRITABLE_CODE_POINT.test(value) && HAS_A_LETTER.test(value);
}
