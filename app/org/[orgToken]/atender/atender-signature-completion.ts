// The single exit of every walk-in clinical writer.
//
// WHY THIS EXISTS (Ola I, owner-alert item)
// ---------------------------------------------------------------------------
// The Atender walk-in treats "holds event.write on this org AND knows the DIM
// code" as the consent proxy — see resolveAtenderPet's header, which documents
// that the code is PUBLIC. The PO decided NOT to close that with authorization:
// a vet or refugio meeting an animal for the first time has to be able to treat
// it, and demanding prior custody breaks real clinical care. The answer is
// DETECTION, not prevention — the owner is told, every time, so a third-party
// write on their animal is never invisible.
//
// Which makes the owner alert part of the walk-in's CONTRACT, not a courtesy a
// writer remembers. Seven writers each hand-copying `if (eventId) notify(...)`
// before `return { ok: true, redirectTo }` is an enumeration, and an enumeration
// FAILS OPEN: writer #8 that forgets the block still compiles, still commits,
// still redirects, and silently writes on a stranger's animal.
//
// So success is no longer something a writer can construct. `?firmado=1` — the
// receipt the surface renders — is built HERE and nowhere else, and building it
// runs the alert. To ship a new walk-in writer you must call this, and calling
// this notifies. `occurredAt` and `eventType` are REQUIRED, so a writer cannot
// even reach a success state without handing over the facts the owner is told.
//
// scripts/check-atender-owner-alerts.ts is the backstop for the one remaining
// bypass (hand-rolling the return object): it DERIVES the writer set from the
// module's own imports instead of listing it, so a new writer enters the fence's
// scope the moment it is written.

import type { EventType } from "@/db";
import {
  type ClinicalEventOwnerNotice,
  notifyOwnersOfClinicalEvent,
} from "@/lib/infra/notify-owners-of-clinical-event";
import type { EventFormState } from "@/src/modules/events/actions";

export type AtenderSignatureCompletion = {
  orgToken: string;
  publicToken: string;
  petId: string;
  petName: string;
  /** How the signing organization is named to the owner. */
  organizationName: string;
  /** The signer — never notified about their own signature. */
  signerUserId: string;
  /**
   * The persisted event id. Null when the use-case committed without returning
   * one (idempotent replay); the receipt is still owed to the signer, and there
   * is no new event to tell the owner about.
   */
  eventId: string | null;
  eventType: EventType;
  occurredAt: Date;
  /**
   * OPTIONAL — the owner notice's words, for the walk-in act whose news is not
   * "a new record": the veterinary close of a rabies observation (2026-09-18).
   * It changes WHAT the owner reads and nothing else — recipients, the
   * third-party rule and the durable write stay the ones every writer gets. See
   * ClinicalEventOwnerNotice.
   */
  ownerNotice?: ClinicalEventOwnerNotice;
};

/** The redirect target for a signed walk-in event — the `?firmado=1` receipt. */
function successRedirect(orgToken: string, publicToken: string): string {
  return `/org/${orgToken}/atender/${publicToken}?firmado=1`;
}

/**
 * Close a walk-in clinical signature: alert the pet's owners, then return the
 * writer's success state.
 *
 * The alert is BEST-EFFORT and POST-COMMIT by construction. Callers invoke this
 * after their try/catch, so a throw in here can never reach a writer's
 * cleanupAttachment path and delete the attachment of an already-persisted
 * event; notifyOwnersOfClinicalEvent additionally swallows its own errors, so a
 * notification failure can never tumble clinical care. A pet with no registered
 * owner — the found-animal case the walk-in exists for — simply has no
 * recipient and is a silent no-op.
 */
export async function completeAtenderSignature(
  input: AtenderSignatureCompletion,
): Promise<EventFormState> {
  if (input.eventId) {
    await notifyOwnersOfClinicalEvent({
      petId: input.petId,
      petName: input.petName,
      petPublicToken: input.publicToken,
      eventId: input.eventId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      authorUserId: input.signerUserId,
      authorLabel: input.organizationName,
      notice: input.ownerNotice,
    });
  }

  return {
    error: null,
    ok: true,
    redirectTo: successRedirect(input.orgToken, input.publicToken),
  };
}
