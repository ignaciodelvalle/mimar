// Client-input contract for DEVOLUCIÓN —
// `POST /api/v1/pets/{publicToken}/return`.
//
// THREE COMMANDS, ONE ENDPOINT, AND THEY DO NOT SHARE A GUARD
// ---------------------------------------------------------------------------
// The read's contract (`@dim/contract/api`'s `pet-return.ts`) states who may run
// each one and this file does not restate it, because two copies of a rule is
// how the copies disagree. What matters here is that the split into three
// COMMANDS is not cosmetic — the three end in different places:
//
//   accept_return   ends the actor's custody, moves `pets.status` back to
//                   `active`, closes two cases and appends `custody_transferred`
//                   plus `status_changed`. It is the one write on this surface
//                   that takes an animal BACK.
//   reject_return   appends `custody_transfer_cancelled` and notifies. Nothing
//                   about the animal changes.
//   propose_return  appends `custody_transfer_proposed` addressed to an
//                   organisation and notifies its members. Custody does not move
//                   until they accept.
//
// A single "responder" command would have had to pick one guard for all three,
// and the first two are the LEGAL OWNER's while the third also admits a foster.
//
// THE REFERENCE POINTS, named by SYMBOL and not by line:
//
//   aceptar     `ownerAcceptReturnUseCase`        …/application/owner-accept-return.ts
//   rechazar    `ownerRejectReturnUseCase`        …/application/owner-reject-return.ts
//   proponer    `ownerProposeReturnToOrgUseCase`  …/application/owner-propose-return-to-org.ts
//               + `ownerProposeReturnToOrgFormAction` …/application/forms/return-to-owner-forms.ts
//
// WHAT THE SERVER STILL DECIDES AFTER THIS SCHEMA PASSES
// ---------------------------------------------------------------------------
//   · WHICH ORGANISATION a proposal is addressed to. There is no field for it
//     and there must not be: `resolveReturnTargetOrg` derives it from the
//     animal's `adoption_finalized` payload or its open custody row. A
//     client-supplied org id would be a `where` behind nothing but a session —
//     the exact shape `submit-claim-dispute.ts` records as having made a writer
//     "a national denial-of-rescue button".
//   · WHETHER THE PROPOSAL IS STILL PENDING, re-checked inside the transaction
//     under `pg_advisory_xact_lock`. A client's read is always stale by the time
//     it taps.
//   · THE AUTO-CANCEL. `accept_return` can succeed while cancelling instead of
//     transferring, when the proposer no longer holds custody or the animal is
//     no longer lost. The ack says which happened; see `PetReturnCommandAckV1`.
//
// NO `proposedAt` FIELD, AND ITS ABSENCE IS A DECISION. The web's form offers a
// date input defaulting to today and `ownerProposeReturnToOrgFormAction` parses
// it into an ISO string. It is a `proposed_at` in the event payload and nothing
// reads it as anything but "when this was proposed", so a phone offering to
// back-date a proposal would be offering a way to describe a conversation that
// did not happen when it says it did. The server stamps its own clock.

import { z } from "zod";

/**
 * The four motives the web's own select offers, DERIVED here so both clients
 * spend one list.
 *
 * IT IS NARROWER THAN THE EVENT SCHEMA ON PURPOSE. `custody_transfer_proposed`
 * accepts more `reason` values — they are valid for an ORG-initiated proposal
 * and wrong for this flow — and `ownerProposeReturnToOrgFormAction` enforces
 * exactly this narrowing with its own `OWNER_RETURN_REASONS` set. Mirroring a
 * server narrowing is parity; inventing one is not.
 */
export const OWNER_RETURN_REASONS = [
  "post_adoption_failed_return",
  "space_constraint",
  "specialization_needed",
  "other",
] as const;
export type OwnerReturnReason = (typeof OWNER_RETURN_REASONS)[number];

/** The longest a rejection motive may be — the web's own `maxLength`. */
export const RETURN_REJECT_REASON_MAX = 500;

/** The longest the free-text notes on a proposal may be — the web's own. */
export const RETURN_NOTES_MAX = 1000;

/**
 * The vocabulary a client shows a field message from.
 *
 * `REJECT_REASON_REQUIRED` and `RETURN_REASON_REQUIRED` are separate because the
 * two controls are different: one is a free-text box the person writes in, the
 * other is a list they pick from, and "escribí un motivo" over a `<select>`
 * sends somebody looking for a text field that is not there.
 */
export const PET_RETURN_COMMAND_INPUT_CODES = [
  "COMMAND_REQUIRED",
  "REJECT_REASON_REQUIRED",
  "REJECT_REASON_TOO_LONG",
  "RETURN_REASON_REQUIRED",
  "NOTES_TOO_LONG",
] as const;
export type PetReturnCommandInputCode = (typeof PET_RETURN_COMMAND_INPUT_CODES)[number];

/**
 * ACEPTAR — "sí, la tengo".
 *
 * NO FIELDS AT ALL, and that is the writer's shape rather than a simplification:
 * `ownerAcceptReturnUseCase` takes a user id and a pet token and reads
 * everything else off the spine. A `proposalEventId` on the wire would look like
 * a safety check and would be one only if the server trusted it — which it must
 * not, because the proposal it acts on is re-resolved under a row lock.
 */
const acceptReturn = z.object({ command: z.literal("accept_return") });

/**
 * RECHAZAR — "no, y este es el motivo".
 *
 * THE MOTIVE IS REQUIRED because the web's own form requires it and because it
 * travels: the rejection appends `custody_transfer_cancelled` and notifies the
 * person or organisation holding the animal, and a bare "no" leaves somebody
 * with an animal they were told to keep and no reason why.
 */
const rejectReturn = z.object({
  command: z.literal("reject_return"),
  reason: z
    .string({ error: "REJECT_REASON_REQUIRED" })
    .trim()
    .min(1, { error: "REJECT_REASON_REQUIRED" })
    .max(RETURN_REJECT_REASON_MAX, { error: "REJECT_REASON_TOO_LONG" }),
});

/**
 * PROPONER LA DEVOLUCIÓN a la organización de origen.
 *
 * `reason` is an ENUM and not free text — the web's select, mirrored. `notes` is
 * a REQUIRED KEY with a nullable value, not an optional key, for the reason
 * `createLibretaShare` gives about `expiresInDays`: an absent field would have
 * to mean either "no notes" or "keep the previous ones", and there are no
 * previous ones. Posting `null` is "no agregó nada".
 */
const proposeReturn = z.object({
  command: z.literal("propose_return"),
  reason: z.enum(OWNER_RETURN_REASONS, { error: "RETURN_REASON_REQUIRED" }),
  notes: z
    .string()
    .trim()
    .max(RETURN_NOTES_MAX, { error: "NOTES_TOO_LONG" })
    .nullish()
    .transform((v) => (v ? v : null)),
});

export const petReturnCommandInputSchema = z.discriminatedUnion("command", [
  acceptReturn,
  rejectReturn,
  proposeReturn,
]);

export type PetReturnCommandInput = z.infer<typeof petReturnCommandInputSchema>;
export type PetReturnCommand = PetReturnCommandInput["command"];

/**
 * The FIRST input code in a failed parse, for a client that wants to show one
 * message. Mirrors `firstPetProfileCommandInputCode` — same shape, same reason.
 */
export function firstPetReturnCommandInputCode(
  error: z.ZodError<unknown>,
): PetReturnCommandInputCode | null {
  for (const issue of error.issues) {
    const code = issue.message;
    if ((PET_RETURN_COMMAND_INPUT_CODES as readonly string[]).includes(code)) {
      return code as PetReturnCommandInputCode;
    }
  }
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" || issue.path.length === 0 || issue.path[0] === "command") {
      return "COMMAND_REQUIRED";
    }
  }
  return null;
}
