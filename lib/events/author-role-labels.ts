// WHO recorded an asiento, as es-AR words.
//
// It used to live inside `components/pet-profile/AuthorChip.tsx`, which was the
// right home while a chip was the only thing that needed it. It is not any
// more: `GET /api/v1/pets/{token}/events/{eventId}` composes the same label
// server-side, because a native client must not carry a second copy of this
// vocabulary that can fall out of step with the web's — and a route handler
// reaching into a `.tsx` to borrow a plain object would drag a React component
// into an API route's bundle to read six strings.
//
// So the DATA moves to a framework-free module and the component imports it.
// The chip is unchanged; nothing about how it renders lives here.
//
// THE RULE THIS TABLE ENCODES: a citizen reading their own animal's ledger sees
// the author's ROLE, never their name. An operator's PII is not part of what an
// owner is owed about a record, and the one identity that IS named on these
// surfaces is an ORGANIZATION's — which is a different kind of thing.
//
// A third copy still exists in `app/admin/libro/view.ts`, deliberately: the
// operator ledger styles its own vocabulary with its own tokens and is not a
// citizen surface. If a fourth appears, it should come here instead.

export const AUTHOR_ROLE_LABELS: Record<string, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  shelter: "Refugio",
  govt: "Autoridad pública",
  system: "Sistema",
  scanner: "Lector de chip",
  finder: "Hallador",
};

/**
 * The es-AR word for an author role, or the raw role when the table has none.
 *
 * FALLS BACK TO THE ROLE ITSELF rather than to "Desconocido": a row written by a
 * role this table has not learned yet is still attributable, and printing
 * "Desconocido" over a real author would be a claim the data does not support.
 */
export function authorRoleLabel(role: string): string {
  return AUTHOR_ROLE_LABELS[role] ?? role;
}
