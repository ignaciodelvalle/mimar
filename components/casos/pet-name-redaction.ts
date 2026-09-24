// BITE-NAME-HIDE (PO decision) — pet-name redaction policy for the public,
// anonymous case view.
//
// `/casos/[publicCode]` is public-by-design (Ley 14.346 transparency). On a
// cruelty / bite case an ANONYMOUS viewer must NOT see the pet's proper NAME —
// species, sex, photo, timeline and the intervening org all stay, but the name
// is redacted (it identifies a private animal in an enforcement context).
//
// Lost-pet and adoption cases are deliberately EXCLUDED: there the pet's name is
// the whole point of the public page (it helps a finder return a lost pet, or a
// family recognise an adoptable one), so it must keep showing.
export const PET_NAME_HIDDEN_CASE_KINDS: ReadonlySet<string> = new Set([
  "bite_incident",
  "welfare_denuncia",
]);

/**
 * True when the pet's proper name must be redacted from the case subject
 * descriptor: only for an anonymous (non-authenticated) viewer AND only on the
 * cruelty/bite case kinds above. An authenticated in-scope viewer (owner,
 * govt/admin) always sees the name.
 */
export function shouldRedactPetName(caseKind: string, isPublic: boolean): boolean {
  return isPublic && PET_NAME_HIDDEN_CASE_KINDS.has(caseKind);
}
