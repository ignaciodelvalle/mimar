// DEVOLUCIÓN — turning the server's state into what a person reads, and what
// they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `transfers-view-model.ts`, `lost-view-model.ts` and `shares-view-model.ts`
// all follow. What lives here is the WORDS: the contract carries codes, the
// consumer owns its copy.
//
// AND THE CAPABILITIES ARE THE SERVER'S TOO. Nothing in this file derives a
// button from `state.kind`, and that is the one rule worth stating twice: the
// arm that separates "there is a pending proposal" from "you may answer it" is
// `awaiting_org` — the caller's OWN outgoing proposal, which looks pending and
// offers nothing. The web's page derives its buttons from the state alone and
// draws an "Aceptar" its own writer refuses with "Esta propuesta no está
// dirigida a vos." A screen that read `kind` instead of `capabilities` would
// reproduce that on a second surface.
//
// WHAT IS DELIBERATELY NOT HERE: the wire types are re-exported by nobody and
// re-modelled by nobody. `PetReturnStateV1` is a discriminated union in the
// contract and this file switches on it, so a new arm is a compile error at
// every consumer rather than a silent fall-through.

import type { PetReturnStateV1, PetReturnV1, ReturnCallerRoleV1 } from "@dim/contract/api";
import type { PetReturnCommandInput, PetReturnCommandInputCode } from "@dim/contract/input";
import { firstPetReturnCommandInputCode, petReturnCommandInputSchema } from "@dim/contract/input";

export type ReturnCommandResult =
  | { ok: true; input: PetReturnCommandInput }
  | { ok: false; code: PetReturnCommandInputCode | null; message: string };

/** One sentence per input code. No code falls through to a generic shrug. */
export function returnInputCodeMessage(code: PetReturnCommandInputCode | null): string {
  switch (code) {
    case "REJECT_REASON_REQUIRED":
      // A free-text box, so the message names writing rather than choosing.
      return "Escribí por qué no la aceptás. Quien la tiene va a leerlo.";
    case "REJECT_REASON_TOO_LONG":
      return "El motivo es muy largo. Contalo en menos palabras.";
    case "RETURN_REASON_REQUIRED":
      // A picker, so the message names choosing rather than writing — "escribí
      // un motivo" over a list sends somebody looking for a text field.
      return "Elegí un motivo para la devolución.";
    case "NOTES_TOO_LONG":
      return "El comentario es muy largo. Contalo en menos palabras.";
    case "COMMAND_REQUIRED":
    case null:
      return "No pudimos armar el pedido. Volvé a abrir la pantalla.";
  }
}

function validated(candidate: unknown): ReturnCommandResult {
  const parsed = petReturnCommandInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstPetReturnCommandInputCode(parsed.error);
  return { ok: false, code, message: returnInputCodeMessage(code) };
}

/** ACEPTAR — "sí, la tengo". No fields; the writer reads the spine. */
export function buildAcceptReturn(): ReturnCommandResult {
  return validated({ command: "accept_return" });
}

/** RECHAZAR — the motive travels to whoever is holding the animal. */
export function buildRejectReturn(reason: string): ReturnCommandResult {
  return validated({ command: "reject_return", reason });
}

/** PROPONER — the reason is the web's own four-item list; notes are optional. */
export function buildProposeReturn(reason: string, notes: string): ReturnCommandResult {
  return validated({ command: "propose_return", reason, notes: notes.trim() || null });
}

/**
 * The four motives, with the web's own labels
 * (`OwnerInitiateReturnForm.tsx`'s `RETURN_REASONS`), in the web's order.
 *
 * The VALUES are not retyped from that file — they come from the contract's
 * `OWNER_RETURN_REASONS`, which mirrors the server's own narrowing. What is
 * transcribed here is the copy, which is what a person reads.
 */
export const RETURN_REASON_CHOICES: ReadonlyArray<{ reason: string; label: string }> = [
  { reason: "post_adoption_failed_return", label: "Cambio de circunstancias / no me pude adaptar" },
  { reason: "space_constraint", label: "Limitaciones de espacio o vivienda" },
  { reason: "specialization_needed", label: "Necesita cuidados especiales que no puedo dar" },
  { reason: "other", label: "Otro motivo" },
];

/** What the screen says about the animal's situation, per state. */
export function returnStateHeadline(state: PetReturnStateV1, petName: string): string {
  switch (state.kind) {
    case "inbound_pending":
      return `${state.actorName} tiene a ${petName} y quiere devolvértela.`;
    case "awaiting_org":
      // NOT "aceptá o rechazá". This is the caller's own outgoing proposal and
      // the organisation has not answered; there is nothing for them to do.
      return `Ya propusiste devolver a ${petName}. La organización todavía no respondió.`;
    case "can_propose":
      return state.orgDisplayName === null
        ? `Podés proponer devolver a ${petName} a la organización de origen.`
        : `Podés proponer devolver a ${petName} a ${state.orgDisplayName}.`;
    case "not_titular":
      // The web's own sentence on this page, which names the caller's link to
      // the animal rather than pretending it does not exist to them.
      //
      // "TITULAR" AND NOT "DUEÑO LEGAL" (CA-5). Titular is the word this whole
      // product uses for the person the credential answers to — the role name
      // in the schema, in `holderRoleLabel` one function down, and on every
      // other screen that talks about it. "Dueño legal" invented a second name
      // for the same role, in a sentence whose only job is to explain to
      // somebody which role they are NOT.
      return `Tu vínculo actual con ${petName} es de ${holderRoleLabel(state.holderRole)}. Aceptar o proponer una devolución es acción del titular.`;
    case "no_source_org":
      return state.callerRole === "foster"
        ? "No encontramos el refugio de origen de este tránsito. Contactá a la organización directamente para coordinar la devolución."
        : `No hay devoluciones pendientes para ${petName} y no encontramos una adopción registrada a tu nombre. Si la recibiste de un refugio fuera de miMAR, contactalo directamente.`;
    case "not_the_adopter":
      return `${petName} figura adoptada por otra persona, así que la devolución la propone quien la adoptó.`;
  }
}

/** The web's own role labels on this page (`ROLE_LABELS`), transcribed. */
export function holderRoleLabel(role: string): string {
  switch (role) {
    case "shelter_custody":
      return "custodia temporal (tránsito)";
    case "foster":
      return "tránsito formal";
    case "co_owner":
      return "co-dueño";
    case "caretaker":
      return "cuidador";
    default:
      return role;
  }
}

/**
 * What the screen says after `accept_return` came back.
 *
 * TWO OUTCOMES BEHIND ONE 200, and the difference is whether the animal came
 * back. The writer cancels instead of transferring when the proposal's
 * preconditions no longer hold, and the server's own sentence says which one
 * failed — so it is rendered verbatim rather than replaced with a summary that
 * would drop the reason.
 */
export function acceptedMessage(
  ack: { autoCancelled: boolean; reason: string | null },
  petName: string,
): { tone: "ok" | "err"; message: string } {
  if (!ack.autoCancelled) {
    return { tone: "ok", message: `Listo. ${petName} vuelve a figurar a tu nombre.` };
  }
  return {
    tone: "err",
    message:
      ack.reason ??
      "La propuesta se canceló automáticamente y la mascota no volvió a tu nombre. Volvé a abrir la pantalla.",
  };
}

/** The role a `can_propose` state is offering to, for the copy. */
export function proposeCallerRole(view: PetReturnV1): ReturnCallerRoleV1 | null {
  return view.state.kind === "can_propose" ? view.state.callerRole : null;
}
