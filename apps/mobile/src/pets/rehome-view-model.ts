// Acompañamiento de adopción — turning the server's answer into what a person
// reads, and a tap into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence
// for every state, every lever and every outcome, and the mapping from a tap
// to a `RehomeCommandInput`. Nothing here touches the network.
//
// THE COPY IS THE WEB'S, TRANSCRIBED. Every sentence below is
// `TitularRehomePanel.tsx`'s or `buscar-hogar/page.tsx`'s, with one
// substitution the phone forces: where the web links to `/casos/{code}` ("Ver
// la solicitud", "Ver el expediente") this app has no casos screen, so it shows
// the code as a fact the person can quote. Nothing is invented.
//
// THE CAPABILITIES ARE THE SERVER'S AND THIS FILE NEVER RECOMPUTES THEM. A lever
// is offered when its flag is true and not otherwise; `state.kind` says what is
// running, not what this caller may do about it (`@dim/contract/api`'s
// `pet-rehome.ts`).

import type {
  ApiV1ErrorCode,
  PetRehomeOrgV1,
  PetRehomeV1,
  RehomeCommandAckV1,
} from "@dim/contract/api";
import {
  type RehomeCommandInput,
  type RehomeCommandInputCode,
  firstRehomeCommandInputCode,
  rehomeCommandInputSchema,
} from "@dim/contract/input";

/** "Refugio" / "Red de rescate" — the web's own `orgKindLabel`. */
export function orgKindLabel(orgType: string): string {
  return orgType === "rescue_network" ? "Red de rescate" : "Refugio";
}

/** The picker row's second line: kind, then the locality that matched, when there is one. */
export function orgRowCaption(org: PetRehomeOrgV1): string {
  return org.locality
    ? `${orgKindLabel(org.orgType)} · ${org.locality}`
    : orgKindLabel(org.orgType);
}

/** The page's intro, under the title. */
export function introLine(petName: string): string {
  return `Una organización verificada publica a ${petName} en la búsqueda de hogar y evalúa a quienes se postulan. ${petName} sigue viviendo con vos hasta que se concrete la adopción, y podés dar de baja el acompañamiento cuando quieras.`;
}

/** Under the picker while nothing is running — the web's footnote. */
export const PICKER_FOOTNOTE =
  "La organización recibe el pedido en su bandeja de casos y lo acepta o lo rechaza. Hasta que responda, nada cambia y podés cancelarlo acá mismo.";

/**
 * Why the picker cannot be used, or `null` when it can.
 *
 * THREE REASONS, THREE SENTENCES, and only one of them has a fix on this phone:
 * no province means "editá el perfil" (the screen draws the door to it);
 * nobody covering the zone means wait or call somebody — the web's own two
 * empty states, verbatim — and the third is the server withholding the ask.
 *
 * THE THIRD ONE IS CHECKED FIRST, AND BEFORE `orgs.length`, because it is the
 * only one that can be true while the list is FULL. Without it the screen drew
 * a card headed "Organizaciones", listed the shelters, and then showed no
 * button, no footnote and no sentence — a dead end that told the owner nothing.
 * The web does not have this hole: its page has no capabilities and draws the
 * ask regardless, so a web owner at least gets a server refusal with a reason.
 *
 * WHY THE SENTENCE NAMES TWO CAUSES AND NOT ONE. `canRequest` is
 * `owner && validateRequestOpen(...)` (src/modules/rehome/domain/rehome-rules.ts),
 * and the route 403s anyone who is not the legal owner, so `owner` is always
 * true here. `validateRequestOpen` refuses on four grounds, but an open request
 * or a running sponsorship would put `state.kind` at `pending` or `active` — so
 * on THIS branch, with `state.kind === "none"`, the only two survivors are a
 * lost report and a registered death. The payload does not carry which, so the
 * sentence names both rather than guessing one.
 *
 * The wording deliberately agrees with `reporte` and `fallecimiento`, never
 * with the animal: PetRehomeV1 carries no sex, and "perdida" would misgender
 * half of them.
 */
export function emptyPickerReason(
  view: PetRehomeV1,
):
  | { kind: "no_province"; message: string }
  | { kind: "nobody_covers"; message: string }
  | { kind: "cannot_request"; message: string }
  | null {
  if (view.state.kind !== "none") return null;
  if (!view.capabilities.canRequest) {
    return {
      kind: "cannot_request",
      message: `Ahora no se puede pedir acompañamiento para ${view.petName}. Pasa cuando la ficha tiene un reporte de extravío abierto o un fallecimiento registrado. Revisá la ficha para ver cuál es el caso.`,
    };
  }
  if (view.orgs.length > 0) return null;
  if (!view.zone.province) {
    return {
      kind: "no_province",
      message: `${view.petName} no tiene provincia registrada. Editá el perfil para poder elegir una organización cercana.`,
    };
  }
  return {
    kind: "nobody_covers",
    message: `No encontramos refugios ni redes de rescate verificados en ${view.zone.locality ?? view.zone.province}. Podés volver a intentarlo más adelante o contactar una organización directamente.`,
  };
}

/** The pending state's callout: title, body, and the code the web would link. */
export function pendingCopy(
  view: Extract<PetRehomeV1["state"], { kind: "pending" }>,
  petName: string,
): { title: string; body: string; reference: string } {
  return {
    title: `Pedido enviado a ${view.orgDisplayName}`,
    body: `Todavía no respondió. Mientras tanto nada cambia: ${petName} sigue con vos y no hay ninguna publicación.`,
    reference: `Solicitud ${view.requestCasePublicCode}`,
  };
}

/** The active state's callout. `reference` is null when no expediente is open. */
export function activeCopy(
  view: Extract<PetRehomeV1["state"], { kind: "active" }>,
  petName: string,
): { title: string; body: string; reference: string | null } {
  return {
    title: `${view.orgDisplayName} acompaña la adopción de ${petName}`,
    body: `${petName} sigue viviendo con vos. ${view.orgDisplayName} lo publica en la búsqueda de hogar y evalúa a quienes se postulan; cuando haya una adopción, te lo van a avisar.`,
    reference: view.listingCasePublicCode ? `Expediente ${view.listingCasePublicCode}` : null,
  };
}

/**
 * The two exits, each a two-step — trigger, then a confirmation that says
 * exactly what the act does. The web confirms both and NOT the ask, and this
 * file keeps that: the ask is reversible on this same screen, and a
 * confirmation on a reversible act is friction with nothing behind it.
 */
export type ExitCopy = { trigger: string; confirm: string; busy: string; explanation: string };

export function cancelExitCopy(orgDisplayName: string): ExitCopy {
  return {
    trigger: "Cancelar el pedido",
    confirm: "Confirmar la cancelación",
    busy: "Procesando…",
    explanation: `El pedido a ${orgDisplayName} se cancela y la organización deja de verlo. No empezó nada, así que no se pierde nada; podés pedírselo a otra organización cuando quieras.`,
  };
}

export function withdrawExitCopy(orgDisplayName: string, petName: string): ExitCopy {
  return {
    trigger: "Dar de baja el acompañamiento",
    confirm: "Confirmar la baja",
    busy: "Procesando…",
    explanation: `${petName} se retira de la búsqueda de hogar en este momento y ${orgDisplayName} deja de tener custodia registral. Las postulaciones que haya quedan cerradas y cada persona recibe un aviso. Si más adelante querés volver a buscarle hogar, pedís un acompañamiento nuevo.`,
  };
}

export type CommandResult =
  | { ok: true; input: RehomeCommandInput }
  | { ok: false; message: string; code: RehomeCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = rehomeCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstRehomeCommandInputCode(parsed.error);
  return { ok: false, code, message: rehomeInputCodeMessage(code) };
}

/** PEDIR ACOMPAÑAMIENTO to one org of the picker, by its public token. */
export function buildRequestSponsorship(orgPublicToken: string): CommandResult {
  return validated({ command: "request_sponsorship", orgPublicToken });
}

/** CANCELAR EL PEDIDO. */
export function buildWithdrawRequest(): CommandResult {
  return validated({ command: "withdraw_request" });
}

/** DAR DE BAJA EL ACOMPAÑAMIENTO. */
export function buildWithdrawSponsorship(): CommandResult {
  return validated({ command: "withdraw_sponsorship" });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function rehomeInputCodeMessage(code: RehomeCommandInputCode | null): string {
  if (code === null) return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "ORG_REQUIRED":
      return "Elegí una organización de la lista.";
  }
}

/**
 * What the screen says after a command landed.
 *
 * THE ASK HAS NO SENTENCE OF ITS OWN, and that is the web's decision kept: the
 * page re-renders in its pending state, whose callout ("Pedido enviado a X") IS
 * the success notice — one name for the act, start to end. The two exits say
 * what happened, and a REPLAY says it in the past perfect: the act had already
 * landed, this tap changed nothing, and both are done.
 */
export function ackMessage(ack: RehomeCommandAckV1): string | null {
  switch (ack.command) {
    case "request_sponsorship":
      return null;
    case "withdraw_request":
      return ack.replayed ? "El pedido ya estaba cancelado." : "El pedido quedó cancelado.";
    case "withdraw_sponsorship":
      return ack.replayed
        ? "El acompañamiento ya estaba dado de baja."
        : "El acompañamiento quedó dado de baja.";
  }
}

/**
 * The refusals whose only instruction is "look again" — so the screen looks,
 * instead of quoting "actualizá la pantalla" at somebody with no refresh.
 *
 * THE ASK'S REPLAY IS ONE OF THEM, and that is why this is not cosmetic. The
 * ask carries no `Idempotency-Key` (`@dim/contract/input`'s `rehome.ts`), so a
 * retry whose first attempt landed — two taps, a lost response — does not
 * answer `replayed: true`; it answers `rehome_already_open`. Rendered as a red
 * sentence over the picker, that is a landed write presented as a failure. The
 * pending callout the re-read draws is the ask's success notice, on the web
 * and here. `rehome_nothing_to_withdraw` is the mirror: an exit that arrived
 * after the organisation already resolved the case. Both mean the state moved
 * under the tap and the next state is the server's.
 *
 * Every other refusal is about THIS tap — whose decision it is, which org,
 * what situation the animal is in — and a re-read would not change it.
 */
export function isLookAgainRefusal(code: ApiV1ErrorCode): boolean {
  return code === "rehome_already_open" || code === "rehome_nothing_to_withdraw";
}
