// Cuidador temporal — turning the server's two lists into what a person reads,
// and what they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every input refusal, and the mapping from a chosen answer to a
// `CaretakerCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `transfers-view-model.ts` follows. What lives here is the WORDS.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `row.capabilities` says which of the four answers this caller may give, and it
// is not a function of `status` a client could reproduce:
//
//   · `canAccept` folds in the ADDRESSEE match — an id-or-e-mail comparison
//     against the grant row that a phone cannot perform, because the payload
//     never tells it who the addressee is — plus the server's clock and a
//     "you cannot accept your own" guard;
//   · `canReject` deliberately ignores the period, because the writer does:
//     refusing something dead is harmless, and taking the control away would
//     leave a row nobody can clear;
//   · `canCancel` and `canRevoke` are the granter's, and they are split by STATUS
//     because the two are different facts — cancelling withdraws an invitation
//     nobody answered, revoking ends a live arrangement and appends
//     `caretaker_ended` to the spine.
//
// A screen that derived any of the four from `status` would offer "Aceptar" to
// the person who SENT the invitation.
//
// NOTHING HERE MAY RECOMPUTE `expired` EITHER. It comes from the server's clock
// (`MyCaretakerGrantV1.expired`), and the flattering error is the dangerous one:
// a screen that called a live arrangement over would have somebody stop expecting
// their animal back on the day they were promised.
//
// THE SCOPE SENTENCE IS NOT WRITTEN HERE, and that is the one string in this
// feature a client must not own. It is a PROMISE about what the titular-only
// deny-list actually enforces, it rides every row as `scopeSentence`, and a copy
// on a phone would go on promising the old scope the day a row is added to
// `lib/domain/titular-only.ts`.

import type {
  CaretakerGrantStatusV1,
  MyCaretakerGrantV1,
  MyCaretakerGrantsV1,
} from "@dim/contract/api";
import {
  CARETAKER_MAX_DURATION_DAYS,
  type CaretakerCommandInput,
  type CaretakerCommandInputCode,
  caretakerCommandInputSchema,
  firstCaretakerCommandInputCode,
} from "@dim/contract/input";

import { todayInAr } from "../pets/record-event-view-model";
import { dateInputToIso } from "../ui/date-input";

export { todayInAr };

/** The longest period the domain accepts, for the form's own sentence. */
export const CARETAKER_WINDOW_DAYS = CARETAKER_MAX_DURATION_DAYS;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/**
 * The two OPEN states, in the web's own words.
 *
 * "Activo" and not "Aceptado": the row's status says how it GOT here, and what a
 * person needs to read on a list is whether somebody is looking after the animal
 * right now.
 */
export function caretakerStatusLabel(status: CaretakerGrantStatusV1): string {
  switch (status) {
    case "pending":
      return "Pendiente";
    case "accepted":
      return "Activo";
  }
}

/**
 * The period, in one line.
 *
 * READS `expired` AND NOT THE DATES. A row can say `status: "accepted"` and
 * `expired: true` at the same time — the daily sweep has not reached it, and the
 * database has already stopped honouring it — and that window is exactly when a
 * person needs the truth rather than the status.
 */
export function caretakerPeriodLabel(grant: MyCaretakerGrantV1): string {
  const from = formatDate(grant.startsAt);
  const to = formatDate(grant.endsAt);
  if (grant.expired) return `Del ${from} al ${to} · el período ya terminó`;
  return `Del ${from} al ${to}`;
}

/**
 * Who the other party is, in one line.
 *
 * INCOMING SHOWS A NAME AND NEVER AN ADDRESS: the only address on the row is the
 * INVITEE'S — the caller's own — and printing "Para: yo@…" to the person it names
 * is noise. When the titular has not set a display name there is nothing to show,
 * and this says so rather than inventing something.
 *
 * OUTGOING FALLS BACK TO THE ADDRESS, which is what the web's cockpit does and is
 * not a leak: it is the address this person typed into the form themselves, and
 * for an invitation to somebody with no account it is the only thing there is.
 */
export function caretakerCounterpartyLabel(grant: MyCaretakerGrantV1): string | null {
  if (grant.direction === "incoming") {
    return grant.counterpartyName === null ? null : `De: ${grant.counterpartyName}`;
  }
  return `Para: ${grant.counterpartyName ?? grant.caretakerEmail}`;
}

/** The heading, per side. */
export function caretakerHeadline(grant: MyCaretakerGrantV1): string {
  if (grant.direction === "incoming") {
    return grant.status === "accepted"
      ? `Estás cuidando a ${grant.pet.name}`
      : `Te proponen cuidar a ${grant.pet.name}`;
  }
  return `Cuidado de ${grant.pet.name}`;
}

/** Every row the payload holds, in one array. */
export function allCaretakerGrants(payload: MyCaretakerGrantsV1): MyCaretakerGrantV1[] {
  return [...payload.incoming, ...payload.outgoing];
}

/**
 * One row by its token, or `null` when this caller has no such grant.
 *
 * For the DEEP-LINK screen. The union of the two lists is exactly the set this
 * caller is authorized to see — the server built them with the same addressee
 * rule the accept writer runs — so a token that is not in it is one this person
 * may not read, and the screen can say so with no second round trip and without
 * the server having to answer a question that would tell a stranger whether a
 * token is real.
 *
 * IT IS ALSO NOT PROOF THE TOKEN IS FAKE. The hub carries OPEN grants only, so a
 * genuine invitation that was answered, withdrawn or swept is absent too. The
 * copy on that screen says "ya no está disponible o no es para vos" for exactly
 * that reason.
 */
export function findCaretakerGrant(
  payload: MyCaretakerGrantsV1,
  grantToken: string,
): MyCaretakerGrantV1 | null {
  return allCaretakerGrants(payload).find((g) => g.grantToken === grantToken) ?? null;
}

/**
 * The open arrangement this caller GRANTED on one animal, or `null`.
 *
 * At most one is possible per state — two partial unique indexes enforce it — and
 * an ACCEPTED one wins over a pending invitation, because "quién está cuidando a
 * este animal" is the question the cockpit answers first.
 */
export function grantForPet(
  payload: MyCaretakerGrantsV1,
  petPublicToken: string,
): MyCaretakerGrantV1 | null {
  const mine = payload.outgoing.filter((g) => g.pet.publicToken === petPublicToken);
  return mine.find((g) => g.status === "accepted") ?? mine[0] ?? null;
}

// ---------------------------------------------------------------------------
// What the TITULAR'S cockpit says about a refusal, in its own words
// ---------------------------------------------------------------------------

/**
 * Two API codes whose shared sentence is wrong on the DESIGNATE screen, and the
 * sentence this screen says instead.
 *
 * `caretaker_forbidden` (A3-documento-credencial-05). Four rules share the
 * code, so `error-copy.ts` names none of them: "Esta acción no es tuya para
 * hacer. Actualizá la pantalla para ver cómo quedó." That is ANSWER-time copy —
 * it is about an arrangement that moved — and on this screen nothing has been
 * answered and nothing has moved. A caretaker who typed an address and a period
 * reads it and refreshes, twice, and the screen comes back identical, because
 * the refusal is about WHO THEY ARE and re-reading cannot change that. The
 * mudanza copy is the shape that works (`move_forbidden`: "Sos cuidador/a de
 * esta mascota: la mudanza la registra el titular") — name the relationship and
 * who can do it.
 *
 * `caretaker_grant_exists` (A4-custodia-06). The shared sentence tells the
 * person to "Terminá o retirá el que está antes de invitar a alguien más", and
 * on this screen there may be nothing to terminate: `grantForPet` reads the
 * caller's OWN outgoing grants, so a co-owner whose co-titular designated a
 * dog-sitter sees an empty cockpit and an invite form. Advice to end something
 * invisible is worse than no advice — and it is also not theirs to take:
 * `endCaretakerGrant` refuses `revoke` unless `actorUserId ===
 * grant.grantedByUserId`, so only the person who designated it can end it.
 */
export const CARETAKER_DESIGNATE_REFUSALS: Readonly<Record<string, string>> = {
  caretaker_forbidden:
    "El cuidado temporal lo designa el titular de la mascota. Si sos cuidador/a o cotitular, pedíselo a quien figura como titular.",
  caretaker_grant_exists:
    "Esta mascota ya tiene un cuidado en curso. Si no aparece en esta pantalla es porque lo designó otra persona: sólo quien lo designó puede terminarlo.",
};

/**
 * The screen's sentence for an api-error code, or `null` to use the shared one.
 *
 * A LOOKUP AND NOT A SWITCH so the shared copy stays the default: this file
 * overrides exactly the two sentences it can improve on, and every other code
 * keeps the one `error-copy.ts` wrote for it.
 */
export function caretakerDesignateRefusalMessage(code: string): string | null {
  return CARETAKER_DESIGNATE_REFUSALS[code] ?? null;
}

/**
 * The refusals a RE-READ can answer — and the whole list (A4-custodia-04).
 *
 * The cockpit used to re-read after EVERY failure, which unmounts the
 * designation form and takes the draft with it, so a refusal about a date
 * arrived over an empty form. These two are the ones where something other than
 * this submission moved: an arrangement was resolved by the other party, or one
 * already exists. Everything else — a bad address, an impossible period, a
 * caller who may not designate — is about the form the person is looking at,
 * and re-reading answers nothing while costing them everything they typed.
 */
export const CARETAKER_STATE_MOVED_CODES: ReadonlySet<string> = new Set([
  "caretaker_already_resolved",
  "caretaker_grant_exists",
]);

export type CommandResult =
  | { ok: true; input: CaretakerCommandInput }
  | { ok: false; message: string; code: CaretakerCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = caretakerCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstCaretakerCommandInputCode(parsed.error);
  return { ok: false, code, message: caretakerInputCodeMessage(code) };
}

/**
 * DESIGNAR A ALGUIEN, from the form's four fields.
 *
 * THE TWO DAYS ARRIVE AS `DD/MM/AAAA` and leave as the wire's `AAAA-MM-DD`
 * (forms-F2). `dateInputToIso` converts the shape and judges nothing: a value
 * it cannot read passes through as typed, the contract answers `DATE_INVALID`,
 * and the person reads the one sentence about dates. ISO passes through
 * untouched, so a caller that already speaks the wire format — every test that
 * predates the masked field — still works.
 */
export function buildDesignateCaretaker(draft: {
  petPublicToken: string;
  inviteeEmail: string;
  startsAt: string;
  endsAt: string;
  note: string;
}): CommandResult {
  return validated({
    command: "designate",
    petPublicToken: draft.petPublicToken,
    inviteeEmail: draft.inviteeEmail,
    startsAt: dateInputToIso(draft.startsAt),
    endsAt: dateInputToIso(draft.endsAt),
    note: draft.note.trim() || null,
  });
}

/**
 * ACEPTAR EL CUIDADO.
 *
 * `publicContactConsent` is KEY 2 of the two-key public-contact model and this is
 * the ONLY moment it can be given — the repository writes it in the same UPDATE
 * as the status flip, so no later screen could collect it. It travels only when
 * it is `true`: the contract treats absence as "not consented", and sending
 * `false` explicitly would say the same thing in a way a reader has to check.
 */
export function buildAcceptCaretakerGrant(
  grantToken: string,
  publicContactConsent: boolean,
): CommandResult {
  return validated(
    publicContactConsent
      ? { command: "accept", grantToken, publicContactConsent: true }
      : { command: "accept", grantToken },
  );
}

/** RECHAZAR LA INVITACIÓN. Takes nothing else — there is no "why" on this flow. */
export function buildRejectCaretakerGrant(grantToken: string): CommandResult {
  return validated({ command: "reject", grantToken });
}

/** RETIRAR UNA INVITACIÓN QUE NADIE RESPONDIÓ. */
export function buildCancelCaretakerGrant(
  petPublicToken: string,
  grantToken: string,
): CommandResult {
  return validated({ command: "cancel", petPublicToken, grantToken });
}

/** FINALIZAR UN CUIDADO ACTIVO, ahora. The titular's unilateral right. */
export function buildRevokeCaretakerGrant(
  petPublicToken: string,
  grantToken: string,
): CommandResult {
  return validated({ command: "revoke", petPublicToken, grantToken });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function caretakerInputCodeMessage(code: CaretakerCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "EMAIL_INVALID":
      return "Escribí un correo válido para la persona que va a cuidar.";
    case "PET_TOKEN_REQUIRED":
      return "No pudimos identificar la mascota. Volvé a entrar desde su ficha.";
    case "GRANT_TOKEN_REQUIRED":
      return "No pudimos identificar el cuidado. Actualizá la pantalla y volvé a intentar.";
    case "DATE_INVALID":
      // Covers a malformed shape AND a day that does not exist. `2026-02-31` is
      // the second: it looks fine and the server's own boundary parser would roll
      // it over to the 3rd of March, so the contract refuses it here instead.
      // ONE CODE, so ONE SENTENCE that has to carry both facts — unlike the
      // asiento form, whose contract now splits them (forms-F2). The format it
      // names is the one the FIELD shows; the view-model converts.
      return "Revisá las fechas: escribilas como DD/MM/AAAA y que sean días reales.";
    case "NOTE_TOO_LONG":
      return "La nota es demasiado larga.";
  }
}
