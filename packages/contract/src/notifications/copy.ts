// The es-AR sentences a notification's destination is explained with.
//
// ONE TABLE FOR BOTH RENDERERS. The web explanation page (`/notificaciones/{id}`)
// and the app's explanation screen print what the server resolver puts in
// `NotificationTargetV1.reasonCopy` / `actorCopy`, and the server builds those
// strings HERE. A client never composes them: a phone a release behind would
// otherwise print last month's wording for this month's state.
//
// The wording is the PO's (plan `notificaciones-destinos-2026-10`, "Copy"):
//   «Te toca a vos: aceptá o rechazá la propuesta antes del {fecha}.»
//   «Falta que {Organización} acepte el traspaso. No tenés que hacer nada por ahora.»
//   «Lo decide la autoridad de {localidad}. Te avisamos cuando haya novedades.»
//   «Ya no tenés a {mascota} a cargo, por eso no podemos mostrarte su ficha. Esto fue lo que pasó: …»
//   «Esto ya se resolvió: {estado}.»
//
// Zero runtime dependencies.

/** Trailing punctuation is the table's job; a writer's clause never ends in one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Who has to act — one sentence per pending actor, completed by the resolver. */
export const NOTIFICATION_ACTOR_COPY = {
  recipient: (action: string, deadline?: string | null): string =>
    sentence(`Te toca a vos: ${action}${deadline ? ` antes del ${deadline}` : ""}`),
  counterparty: (party: string | null, action: string): string =>
    `Falta que ${party ?? "la otra parte"} ${action}. No tenés que hacer nada por ahora.`,
  authority: (locality: string | null): string =>
    `Lo decide la autoridad de ${locality ?? "tu jurisdicción"}. Te avisamos cuando haya novedades.`,
  resolved: (state: string): string => sentence(`Esto ya se resolvió: ${state}`),
} as const;

/**
 * Why the explanation state is showing, as a code. The wire carries the code AND
 * the sentence, so a client can choose an icon by code without parsing prose.
 */
export const NOTIFICATION_TARGET_REASONS = [
  /** The destination opened normally (case, pet or section). */
  "destination",
  /** The viewer no longer holds the pet the notification is about. */
  "pet_no_longer_held",
  /** A case the viewer is not a party to (no rule grants them a read). */
  "case_not_available",
  /** A case read by a co-holder of the pet: cases are titular-only. */
  "case_titular_only",
  /** The viewer left (or was removed from) the organization the notice was for. */
  "membership_ended",
  /** The notice has nothing to open; it reports a fact. */
  "informational",
  /** The destination exists but only on the web; the app explains and offers the browser. */
  "web_only",
  /** The writer linked an outside site (an official information page); it opens there. */
  "external",
  /** The row was erased at its subject's request (Ley 25.326 art. 16): nothing to open. */
  "erased",
] as const;
export type NotificationTargetReason = (typeof NOTIFICATION_TARGET_REASONS)[number];

/** The explanation sentences. `what` is the notification's own body or title. */
export const NOTIFICATION_REASON_COPY = {
  pet_no_longer_held: (petName: string | null, what: string | null): string =>
    `Ya no tenés a ${petName ?? "esta mascota"} a cargo, por eso no podemos mostrarte su ficha.${
      what ? ` Esto fue lo que pasó: ${sentence(what)}` : ""
    }`,
  case_not_available: (): string =>
    "Este caso no está disponible para tu cuenta: sólo lo ven las partes y la autoridad que interviene.",
  case_titular_only: (petName: string | null): string =>
    `Los casos de ${petName ?? "esta mascota"} los ve sólo la persona titular. Si necesitás el detalle, pedíselo a quien figura como titular.`,
  membership_ended: (org: string | null): string =>
    `Ya no formás parte de ${org ?? "esa organización"}, por eso no podemos mostrarte esto.`,
  informational: (text: string | null): string =>
    text ?? "Esta notificación es sólo un aviso: no hay nada más para abrir.",
  web_only: (): string =>
    "Esto se gestiona desde la web. Abrilo en el navegador con tu misma cuenta.",
  external: (label: string | null): string =>
    `Este aviso enlaza un sitio externo${label ? ` (${label})` : ""}. Se abre fuera de miMAR.`,
  erased: (): string => "Esta notificación se eliminó a pedido de su titular.",
} as const;
