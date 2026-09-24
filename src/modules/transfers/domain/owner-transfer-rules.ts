// Owner→owner transfer domain rules — pure functions, no DB, no Next.js.
// Extracted from app/actions/pet-transfer.ts validation blocks.

import {
  type DomainResult,
  OWNER_TRANSFER_REASONS,
  type OwnerTransferReason,
  type PetStatusSnapshot,
  TRANSFER_EXPIRY_DAYS,
} from "./types";

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

export function isValidTransferEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Transfer reason validation
// ---------------------------------------------------------------------------

export function validateOwnerTransferReason(reason: string): DomainResult<OwnerTransferReason> {
  if (!(OWNER_TRANSFER_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: "Motivo inválido." };
  }
  return { ok: true, value: reason as OwnerTransferReason };
}

// ---------------------------------------------------------------------------
// Pet status guard
// ---------------------------------------------------------------------------

export function validatePetStatusForTransfer(pet: PetStatusSnapshot): DomainResult {
  if (pet.status === "deceased") {
    return { ok: false, error: "No podés transferir una mascota fallecida." };
  }
  if (pet.status === "lost") {
    return {
      ok: false,
      error: "Esta mascota está reportada como perdida. Resolvé el episodio primero.",
    };
  }
  if (pet.inCustodyDispute) {
    return {
      ok: false,
      error: "Hay una disputa de custodia en curso. La transferencia se bloquea.",
    };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Sponsored pet guard (rehome-by-titular, REQ-15)
// ---------------------------------------------------------------------------

/**
 * The refusal a titular sees when the pet is still on a shelter's adoption
 * listing.
 *
 * The cross-org twin's `SPONSORED_CUSTODY_TRANSFER_ERROR` says the same thing
 * to the ORG holding the row ("only the titular may end it — no se puede
 * transferir a otra organización"). Read BY the titular that sentence names
 * the wrong actor and the wrong destination (this hand-off goes to a person),
 * so the P2P side gets its own wording, whose job is to name the one action
 * that unblocks it: withdraw the sponsorship first.
 */
export const SPONSORED_PET_TRANSFER_ERROR =
  "Un refugio está acompañando la adopción de esta mascota. Antes de transferir la titularidad tenés que dar de baja el acompañamiento.";

/**
 * An owner→owner transfer closes the titular's `owner` row and touches nothing
 * else (`closeOwnerOwnerships` filters on `role='owner'` by design). If a
 * shelter's `shelter_custody` row is still open under a rehome sponsorship,
 * the hand-off leaves it standing over a stranger: the public catalogue keeps
 * saying "vive con su familia" about someone else's animal, and the shelter
 * keeps the power to finalise an adoption to a third party — which closes the
 * NEW owner's ownership row. Neither side is told the title changed.
 *
 * Spec REQ-15 already decided this shape for the cross-org twin: a sponsored
 * custody is **refused**, never ended inside another hand-off, because ending
 * it here would leave no `rehome_sponsorship_started` naming a live row and
 * REQ-10's unconditional route back would be gone. The titular's own withdraw
 * is the door.
 *
 * Unlike `validateSourceNotSponsored`, this predicate does NOT compare ids:
 * the cross-org rule blocks an org from handing off THAT row, while here ANY
 * open sponsorship on the pet is the thing left dangling by the title change.
 */
export function validatePetNotSponsored(input: {
  openSponsorship: { ownershipId: string } | null;
}): DomainResult {
  if (input.openSponsorship) {
    return { ok: false, error: SPONSORED_PET_TRANSFER_ERROR };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Self-transfer guard
// ---------------------------------------------------------------------------

/**
 * Validates that the caller (sender) is not the same user as the recipient.
 * Only applicable when toOwnerId is already resolved.
 */
export function validateSelfTransfer(callerId: string, toOwnerId: string): DomainResult {
  if (callerId === toOwnerId) {
    return { ok: false, error: "No podés transferirte la mascota a vos mismo/a." };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Recipient match (id-or-email)
// ---------------------------------------------------------------------------

/**
 * The refusal an account sees when the proposal IS addressed to its e-mail
 * address but the account has never proved it controls that address.
 *
 * Written for the ONE person who legitimately hits it: somebody who was invited
 * by address, created the account by hand instead of following the invitation
 * link, and is now looking at a proposal they cannot answer. It names the single
 * action that unblocks them. "Esta propuesta no es para tu cuenta." would be a
 * lie by omission here — the proposal IS for their address.
 */
export const UNCONFIRMED_EMAIL_TRANSFER_ERROR =
  "Confirmá tu correo electrónico para aceptar esta transferencia.";

/**
 * Which arm of the addressee rule answered, and how.
 *
 * `email_unconfirmed` exists so a caller can tell "you are not the addressee"
 * apart from "you are the addressee but your address is not proved". They are
 * the same refusal for authorization and DIFFERENT sentences for a person.
 */
export type RecipientMatchOutcome = "id" | "email" | "email_unconfirmed" | "no_match";

/**
 * Is the caller the intended recipient, and by which arm?
 *
 * Semantics: if toOwnerId is set, match by id only. If toOwnerId is null (open
 * invitation by e-mail), match by e-mail (lowercased, trimmed) AND only when the
 * caller's address is CONFIRMED.
 *
 * WHY THE E-MAIL ARM NEEDS `callerEmailConfirmed` (audit 2026-09 A09-1, PO
 * decision 2026-09-02). `to_owner_id` is NULL precisely when the address had no
 * account at initiate time, so the row stores a string and this comparison is
 * the whole of the proof that the caller is the addressee. A bare string compare
 * treats "I signed up with that address" as "I read that mailbox", and those are
 * only the same claim when the platform made the account prove it. Without the
 * confirmation term, anyone who KNOWS an invited address can register it and the
 * accept moves titularidad in the national registry.
 *
 * THE ID ARM IS UNAFFECTED. When `to_owner_id` resolved, the sender's own
 * initiate already bound the proposal to an existing account by id, and an id is
 * not a claim about a mailbox.
 *
 * WHAT THIS GUARD DOES NOT DO, said here rather than left to be assumed: it is
 * NOT a substitute for `enable_confirmations` being ON in the Supabase project.
 * With confirmations OFF, GoTrue auto-confirms at signup and stamps
 * `email_confirmed_at` itself, so the column carries no mailbox proof and this
 * term degrades to always-true. It is a second lock on the same door — it closes
 * the shapes where an account exists with an unproved address under a project
 * that DOES require confirmation (admin-created accounts, identities imported
 * from a provider that did not verify the address).
 *
 * An EMPTY `callerEmail` never matches, which removes the reliance on
 * `to_owner_email` being non-empty by side effect of a NOT NULL column.
 */
export function resolveRecipientMatch(args: {
  toOwnerId: string | null;
  toOwnerEmail: string;
  callerId: string;
  callerEmail: string;
  /** GoTrue's `email_confirmed_at` is non-null for the accepting account. */
  callerEmailConfirmed: boolean;
}): RecipientMatchOutcome {
  if (args.toOwnerId !== null) {
    return args.toOwnerId === args.callerId ? "id" : "no_match";
  }
  const callerEmail = args.callerEmail.trim().toLowerCase();
  if (callerEmail.length === 0) return "no_match";
  if (args.toOwnerEmail.trim().toLowerCase() !== callerEmail) return "no_match";
  return args.callerEmailConfirmed ? "email" : "email_unconfirmed";
}

/**
 * Returns true when the caller is the intended recipient.
 *
 * The boolean face of `resolveRecipientMatch`, for the readers that only need a
 * yes/no: the list capabilities, the reject writer and the viewer read. The
 * accept writer asks the richer question so it can say WHY it refused.
 */
export function validateRecipientMatch(args: {
  toOwnerId: string | null;
  toOwnerEmail: string;
  callerId: string;
  callerEmail: string;
  callerEmailConfirmed: boolean;
}): boolean {
  const outcome = resolveRecipientMatch(args);
  return outcome === "id" || outcome === "email";
}

// ---------------------------------------------------------------------------
// Expiry computation
// ---------------------------------------------------------------------------

export function computeTransferExpiresAt(now: Date): Date {
  return new Date(now.getTime() + TRANSFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}
