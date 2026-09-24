// Pure resolver for the "Ver mascota →" deep link on a case-detail subject.
//
// A3 (ronda-5 A4 regression, cowork demo 2026-07-17): the button pointed EVERY
// authed viewer at the owner-only /mis-mascotas/<token> surface. An operator
// (admin / govt / vet) does not own the pet, so that surface silently bounced
// them back to their portal home — the button read as "roto" in the demo.
// Operators get the PUBLIC credential /p/<token> instead: it always exists, is
// role-free, and shows exactly what any verifier sees. Only the OWNER keeps the
// /mis-mascotas deep link (it IS their pet).

export type CasePetLinkRole = "owner" | "vet" | "govt" | "admin" | "national";

/**
 * The pet-credential link for an authed case-detail viewer, by role. Null when
 * the case has no linked pet. Owner → the owner surface; every operator role →
 * the role-free public credential page.
 */
export function casePetLink(
  publicToken: string | null | undefined,
  role: CasePetLinkRole,
): string | null {
  if (!publicToken) return null;
  return role === "owner" ? `/mis-mascotas/${publicToken}` : `/p/${publicToken}`;
}
