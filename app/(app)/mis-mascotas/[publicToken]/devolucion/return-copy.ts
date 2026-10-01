// es-AR sentences of the owner's return screen, keyed by WHO proposed it.
//
// The mobile screen owns the same sentences in
// `apps/mobile/src/custody/devolucion-view-model.ts`, built from the contract's
// `PetReturnStateV1`. The web page does not read that state (it reads the
// proposal event), so these take the proposer kind directly. The parity block
// in `ReturnAcceptanceCard.test.tsx` compares both sets of strings, so a copy
// change on one surface fails here until the other follows.

export type ReturnActorKind = "organization" | "person";

/** What the screen says about the animal's situation. */
export function returnHeadline(actorKind: ReturnActorKind, actorName: string, petName: string) {
  return actorKind === "organization"
    ? `${petName} está en ${actorName}, a salvo y esperándote.`
    : `${actorName} tiene a ${petName} a salvo y quiere devolvértela.`;
}

/** The sentence over the confirm button. */
export function confirmSentence(actorKind: ReturnActorKind, petName: string) {
  const closing =
    actorKind === "organization"
      ? "Ahí el refugio deja de cuidarla."
      : "Ahí termina su cuidado temporal.";
  return `Tocá el botón cuando ya tengas a ${petName} con vos. ${closing}`;
}

/** The sentence over the reject form. */
export function rejectSentence(actorKind: ReturnActorKind) {
  return actorKind === "organization"
    ? "Si no es tu mascota o algo no está bien, contale el motivo al refugio."
    : "Si no es tu mascota o algo no está bien, contale el motivo.";
}

/** The receipt line after a confirmed return. */
export function acceptedSentence(petName: string) {
  return `¡Listo! ${petName} ya está en casa con vos.`;
}
