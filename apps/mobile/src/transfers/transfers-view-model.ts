// Transferencias — turning the server's three lists into what a person reads,
// and what they tapped into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a chosen answer to a
// `TransferCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `lost-view-model.ts` and `shares-view-model.ts` both follow. What lives
// here is the WORDS: the contract carries codes, the consumer owns its copy.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `row.capabilities` says which of the three answers this caller may give, and
// it is not a function of `status` that a client could reproduce:
//
//   · `canAccept` folds in the ADDRESSEE match — an id-or-email comparison
//     against the transfer row that a phone cannot perform, because the payload
//     never tells it who the addressee is;
//   · `canReject` deliberately ignores expiry, because the writer does
//     (`reject-pet-transfer.ts:53-66`): refusing something dead is harmless, and
//     taking the control away would leave a row nobody can clear;
//   · `canCancel` is `fromOwnerId === caller`, which is NARROWER than "this is
//     my pet" — a co-owner may not withdraw a proposal they did not send.
//
// A screen that derived any of the three from `status` would offer "Aceptar" to
// the person who SENT the proposal.
//
// NOTHING HERE MAY RECOMPUTE `expired` EITHER. It comes from the server's clock
// (`MyTransferV1.expired`), and the flattering error is the dangerous one: a
// screen that called a live proposal dead would have somebody stop waiting for
// an animal that is still theirs to take.

import type { MyTransferV1, MyTransfersV1, PetTransferStatusV1 } from "@dim/contract/api";
import type { TransferCommandInput, TransferCommandInputCode } from "@dim/contract/input";
import {
  type OWNER_TRANSFER_REASONS,
  TRANSFER_EXPIRY_DAYS,
  firstTransferCommandInputCode,
  transferCommandInputSchema,
} from "@dim/contract/input";

/**
 * The four reasons, DERIVED from the contract rather than retyped, with the
 * web's own labels (`TransferSenderForm.tsx:14-19`).
 *
 * The order is the web's too, and `gift` is deliberately not first: the web's
 * `<select>` defaults to it, so a phone that listed it first and preselected it
 * would be making the same default twice by accident. This app preselects
 * nothing and asks.
 */
export const TRANSFER_REASON_CHOICES: ReadonlyArray<{
  reason: (typeof OWNER_TRANSFER_REASONS)[number];
  label: string;
}> = [
  { reason: "sale", label: "Venta" },
  { reason: "gift", label: "Regalo" },
  { reason: "inheritance", label: "Herencia" },
  { reason: "other", label: "Otro" },
];

/** How long a proposal stays open, for the sentence the form shows. */
export const TRANSFER_WINDOW_DAYS = TRANSFER_EXPIRY_DAYS;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** The web's own five words for the five statuses (`/transferencias/page.tsx:26-32`). */
export function transferStatusLabel(status: PetTransferStatusV1): string {
  switch (status) {
    case "pending":
      return "Pendiente";
    case "accepted":
      return "Aceptada";
    case "rejected":
      return "Rechazada";
    case "expired":
      return "Expirada";
    case "cancelled":
      return "Cancelada";
  }
}

/**
 * One line about the deadline, or `null` when there is no deadline left to talk
 * about.
 *
 * IT USED TO FALL BACK TO THE STATUS WORD and that was a defect the hub's render
 * test caught: every row already carries a status badge, so a resolved proposal
 * printed "Rechazada" twice, once as a badge and once where a date belongs. A
 * deadline on an answered proposal is not a fact anybody needs — the answer
 * superseded it — so the honest return is nothing, and the caller decides
 * whether to draw the line at all.
 *
 * READS `expired` AND NOT THE DATE. A row can say `status: "pending"` and
 * `expired: true` at the same time — the nightly cron has not reached it yet —
 * and that window is exactly when a person needs the truth rather than the
 * status.
 */
export function transferDeadlineLabel(transfer: MyTransferV1): string | null {
  if (transfer.status !== "pending") return null;
  if (transfer.expired) return `Venció el ${formatDate(transfer.expiresAt)}`;
  return `Vence el ${formatDate(transfer.expiresAt)}`;
}

/** The heading, in the web's own two shapes (`/transferencias/[transferToken]/page.tsx:78-79`). */
export function transferHeadline(transfer: MyTransferV1): string {
  return transfer.direction === "incoming"
    ? `Recibiste a ${transfer.pet.name}`
    : `Transferencia de ${transfer.pet.name}`;
}

/**
 * Who the other party is, in one line.
 *
 * INCOMING SHOWS A NAME AND NEVER AN ADDRESS, because the payload carries no
 * sender e-mail at all — and cannot: `profiles` has no email column. When the
 * sender has not set a display name there is nothing to show, and this says so
 * rather than falling back to something it does not have.
 *
 * OUTGOING FALLS BACK TO THE ADDRESS, which is what the web does
 * (`/transferencias/page.tsx:206-209`) and is not a leak: it is the address this
 * person typed into the form themselves, and for an open invitation to somebody
 * with no account it is the only thing there is to show.
 */
export function transferCounterpartyLabel(transfer: MyTransferV1): string | null {
  if (transfer.direction === "incoming") {
    return transfer.counterpartyName === null ? null : `De: ${transfer.counterpartyName}`;
  }
  return `Para: ${transfer.counterpartyName ?? transfer.toEmail}`;
}

/** The reason, in es-AR, or `null` when the row carries none. */
export function transferReasonLabel(transfer: MyTransferV1): string | null {
  if (transfer.reason === null) return null;
  return TRANSFER_REASON_CHOICES.find((c) => c.reason === transfer.reason)?.label ?? null;
}

/**
 * Every row the payload holds, in one array.
 *
 * For the DETAIL screen, which is reached by a deep link carrying a token and
 * has to find its row. The union of the three lists is exactly the set this
 * caller is authorized to see — the server built them with the same addressee
 * rule the accept writer runs — so a token that is not in it is one this person
 * may not read, and the screen can say so with no second round trip.
 */
export function allTransfers(payload: MyTransfersV1): MyTransferV1[] {
  return [...payload.incoming.pending, ...payload.incoming.history, ...payload.outgoing];
}

/** One row by its token, or `null` when this caller has no such proposal. */
export function findTransfer(payload: MyTransfersV1, transferToken: string): MyTransferV1 | null {
  return allTransfers(payload).find((t) => t.transferToken === transferToken) ?? null;
}

/**
 * What the list screen says when it is empty.
 *
 * THREE DIFFERENT EMPTIES, because they are three different facts and a single
 * "no hay nada" would tell somebody waiting on a proposal that none was sent.
 */
export function emptyIncomingLabel(): string {
  return "No tenés transferencias pendientes.";
}

export function emptyOutgoingLabel(): string {
  return "No enviaste ninguna transferencia todavía.";
}

/**
 * What the INITIATE screen says about `transfer_forbidden`
 * (A3-documento-credencial-05).
 *
 * Three rules share that code — not the current owner, not the addressee, not
 * the sender — so `error-copy.ts` names none of them and sends the reader to
 * re-read: "Esta propuesta no es tuya para responder. Actualizá la pantalla."
 * That is ANSWER-time copy. On the initiate form there is no proposal yet and
 * nothing to respond to, so a caretaker who typed an address and tapped send
 * reads a sentence about a thing that does not exist and an instruction that
 * changes nothing — the refusal is about WHO THEY ARE, and refreshing produces
 * the identical screen forever.
 *
 * Only ONE of the three rules is reachable from here (the owner check), which
 * is what makes a specific sentence honest. The shape is the mudanza's
 * (`move_forbidden`): name the relationship and who can do it.
 */
export const TRANSFER_INITIATE_FORBIDDEN_MESSAGE =
  "La transferencia de la titularidad la inicia el titular. Si sos cuidador/a o cotitular de esta mascota, pedíselo a quien figura como titular.";

/** The screen's own sentence for a code, or `null` to keep the shared one. */
export function transferInitiateRefusalMessage(code: string): string | null {
  return code === "transfer_forbidden" ? TRANSFER_INITIATE_FORBIDDEN_MESSAGE : null;
}

export type CommandResult =
  | { ok: true; input: TransferCommandInput }
  | { ok: false; message: string; code: TransferCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = transferCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstTransferCommandInputCode(parsed.error);
  return { ok: false, code, message: transferInputCodeMessage(code) };
}

/** OFRECER LA TITULARIDAD, from the form's three fields. */
export function buildInitiateTransfer(draft: {
  petPublicToken: string;
  toEmail: string;
  reason: string;
  note: string;
}): CommandResult {
  return validated({
    command: "initiate",
    petPublicToken: draft.petPublicToken,
    toEmail: draft.toEmail,
    reason: draft.reason,
    note: draft.note.trim() || null,
  });
}

/**
 * ACEPTARLA — the irreversible one.
 *
 * NO IDEMPOTENCY KEY, and unlike every other spine write in this app that is
 * not an omission. `accept` DOES append (`custody_transferred`), so the reflex
 * is right; the endpoint simply does not read the header, because
 * `acceptPetTransfer` takes no `clientIdempotencyKey`. Sending one would be this
 * client claiming a guarantee the server has not made. What protects a retry is
 * an `expectedStatus: "pending"` UPDATE, which REFUSES a replay rather than
 * absorbing it — so the screen's job after a timeout is to re-read, never to
 * re-send. `apps/mobile/src/pets/idempotency.ts` explains what the header buys
 * where it IS honoured.
 */
export function buildAcceptTransfer(transferToken: string): CommandResult {
  return validated({ command: "accept", transferToken });
}

/** RECHAZARLA, optionally saying why. The reason reaches the sender. */
export function buildRejectTransfer(transferToken: string, reason: string): CommandResult {
  return validated({ command: "reject", transferToken, reason: reason.trim() || null });
}

/** RETIRAR UNA PROPUESTA PROPIA. Sender-only; the server decides, not this file. */
export function buildCancelTransfer(transferToken: string): CommandResult {
  return validated({ command: "cancel", transferToken });
}

/** es-AR copy for each input code. Exhaustive: every code has a sentence. */
export function transferInputCodeMessage(code: TransferCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "La app no pudo armar la acción. Volvé a intentar.";
    case "EMAIL_INVALID":
      return "Escribí un email válido para el receptor.";
    case "NOTE_TOO_LONG":
      return "El comentario es demasiado largo.";
    case "PET_TOKEN_REQUIRED":
      return "No pudimos identificar la mascota. Volvé a entrar desde su ficha.";
    case "REASON_INVALID":
      return "Elegí un motivo de la lista.";
    case "TRANSFER_TOKEN_REQUIRED":
      return "No pudimos identificar la propuesta. Actualizá la pantalla y volvé a intentar.";
  }
}
