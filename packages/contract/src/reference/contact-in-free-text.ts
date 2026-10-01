// Does a piece of owner free text carry somebody's phone or email?
//
// MOVED HERE from `src/modules/pets/domain/pet-form.ts` (owner-pet-actions,
// 2026-10-01), unchanged, so the app's "Editar datos" can refuse the same text
// the web refuses BEFORE the round trip, and the v1 schema can name the refusal
// with a code. One heuristic on both doors: two copies of a privacy guard are
// how one of them starts letting a phone number through.
//
// WHY IT EXISTS (Ley 25.326 hardening, 2026-07-04). The "otra condición" text
// can render on PUBLIC surfaces — `/p/[publicToken]` through
// `discloseConditionsPublicly`, and the Tier-2 medical view — so an owner who
// pasted a vet's number into it by accident would be publishing it. The save
// path rejects the text instead, regardless of the current disclose flag, which
// the owner can flip later without re-editing the text.
//
// Conservative on purpose: a date ("01/02/2020" splits on "/") or a dosage
// ("cada 12 horas") stays well under the nine-digit floor, while an Argentine
// number has ten.

// Email: anything shaped like local@domain.tld.
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
// Phone candidate: a run of digits with common separators. Flagged only when
// the run contains 9+ digits — AR numbers have 10 (or 8 local + area handled
// by the +9 threshold), while dates ("01/02/2020" splits on "/") and dosage
// counts stay well below it.
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]*\d/g;

/** `"email"` or `"phone"` when the text carries one, `null` when it does not. */
export function detectContactInfoInFreeText(text: string): "email" | "phone" | null {
  if (EMAIL_PATTERN.test(text)) return "email";
  for (const candidate of text.match(PHONE_CANDIDATE_PATTERN) ?? []) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 9) return "phone";
  }
  return null;
}
