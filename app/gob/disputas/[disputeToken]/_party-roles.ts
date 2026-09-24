// The ONE label per custody-dispute party role.
//
// These lived in two places — the detail page's PARTY_ROLE_LABELS and
// AddPartyForm's ROLE_OPTIONS — and had already drifted apart in three ways:
// "Reclamante" vs "Reclamante (persona)", and "Organización" spelled without
// its accent in the form ("Organizacion en custodia", "Organizacion
// reclamante"). A user adding a party read one word and then saw a different
// one on the row they had just created.
//
// GENDER (D.2, live review 2026-07-28): "Dueño actual" was the app talking to
// half its users. The rest of the product says "dueño/a" — the share view, the
// sighting form, the found-pet flow — so this says it too. The chip drift the
// same review found (ABIERTO vs ABIERTA on one dispute) came from the same
// root: the same concept spelled by two files that never met.

import type { DisputePartyRole } from "@/src/modules/custody-disputes/domain/types";

/**
 * Canonical es-AR label for every party role.
 *
 * Typed as a TOTAL Record over DisputePartyRole, not `Record<string, string>`:
 * adding a role to the domain union now fails to compile until it is named
 * here, instead of rendering the raw enum value to an official.
 */
export const PARTY_ROLE_LABELS: Record<DisputePartyRole, string> = {
  current_owner: "Dueño/a actual",
  // Disambiguated from "Organización reclamante" — the two sit next to each
  // other in the add-party select, and a bare "Reclamante" made the reader
  // check which one they had picked.
  claimant_owner: "Reclamante (persona)",
  current_org_custody: "Organización en custodia",
  claimant_org: "Organización reclamante",
  witness: "Testigo",
};

/** Select options, in the order a form should offer them. */
export const PARTY_ROLE_OPTIONS = (
  Object.entries(PARTY_ROLE_LABELS) as Array<[DisputePartyRole, string]>
).map(([value, label]) => ({ value, label }));

/** Label for a stored role value; falls back to the raw value rather than "". */
export function partyRoleLabel(role: string): string {
  return PARTY_ROLE_LABELS[role as DisputePartyRole] ?? role;
}
