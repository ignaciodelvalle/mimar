// Use-case: accept an owner→owner pet transfer.
//
// Migrated from app/actions/pet-transfer.ts::acceptPetTransferAction.
// Auth (requireUserOrRedirect) is handled by the caller.
// callerEmail is resolved from the Supabase session by the thin action.
//
// Orchestrates:
//   1. Load transfer + status check + expiry check + recipient auth (id-or-email)
//   2. Sender-accepting-own guard
//   3. ATOMIC tx:
//      0. sponsored-pet guard under the lock (REQ-15) — refuse, never end
//      a. closeOwnerOwnerships (BEFORE insert — unique-active-owner partial index parity)
//      b. insertOwnerOwnership
//      c. insertPetEvent (custody_transferred, authorRole=owner)
//      d. updateTransferStatus(accepted)
//   4. Collect post-tx notifications (sender)
//   5. After commit: notify every caretaker whose arrangement the hand-off
//      ended (A09-2) — same primitive and dedupe family as finalize-adoption
//   6. Return UseCaseResult<{ petId }>
//      The thin action maps petId → publicToken for revalidatePath (or pre-loads it).
//
// PARITY QUIRK: close BEFORE insert (unique-active-owner partial index validates at commit).

import {
  type EndedCaretakerGrant,
  notifyCaretakersOfHandoff,
} from "@/lib/infra/end-pet-ownerships";
import {
  UNCONFIRMED_EMAIL_TRANSFER_ERROR,
  resolveRecipientMatch,
  validatePetNotSponsored,
  validatePetStatusForTransfer,
} from "../domain/owner-transfer-rules";
import type { TransfersRepository } from "../infrastructure/transfers-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: typeof TransfersRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type AcceptPetTransferInput = {
  transferToken: string;
  /** Caller's authenticated email — resolved by the action via Supabase session. */
  callerEmail: string;
  /**
   * Whether GoTrue holds a non-null `email_confirmed_at` for the accepting
   * account. Load-bearing, not informational: it is the only term separating
   * "this address is mine" from "I typed this address at signup", and the
   * e-mail arm of the addressee rule is what moves titularidad (A09-1).
   */
  callerEmailConfirmed: boolean;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function acceptPetTransfer(
  input: AcceptPetTransferInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string; fromOwnerId: string; petPublicToken: string | null }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Load transfer.
  const transfer = await repo.findTransferByToken(input.transferToken);
  if (!transfer) return { ok: false, error: "Transferencia no encontrada." };
  if (transfer.status !== "pending") {
    return { ok: false, error: `La transferencia ya está ${transfer.status}.` };
  }
  if (transfer.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "La transferencia expiró. Pedile al dueño que la inicie de nuevo." };
  }

  // 2. Recipient auth (id-or-email, and the e-mail arm needs a proved address).
  //
  // The richer `resolveRecipientMatch` rather than the boolean, so the person
  // whose address IS the one on the row but who never confirmed it is told to
  // confirm instead of being told the proposal belongs to somebody else.
  const match = resolveRecipientMatch({
    toOwnerId: transfer.toOwnerId,
    toOwnerEmail: transfer.toOwnerEmail,
    callerId: user.id,
    callerEmail: input.callerEmail,
    callerEmailConfirmed: input.callerEmailConfirmed,
  });
  if (match === "email_unconfirmed") {
    return { ok: false, error: UNCONFIRMED_EMAIL_TRANSFER_ERROR };
  }
  if (match === "no_match") {
    return { ok: false, error: "Esta propuesta no es para tu cuenta." };
  }
  if (transfer.fromOwnerId === user.id) {
    return { ok: false, error: "No podés aceptar tu propia transferencia." };
  }

  const pendingNotifications: NewNotification[] = [];
  // Filled inside the tx, consumed only after it commits (ARCH-P): a rolled-back
  // hand-off ended nobody's arrangement, so nobody may be told it did.
  let endedGrants: EndedCaretakerGrant[] = [];
  let petName = "";

  // 3. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const now = new Date();

      // CONCURRENCY GUARD: re-read the transfer row FOR UPDATE inside the tx
      // and re-check it is still pending. The pre-tx status check above is a
      // stale read — two concurrent accepts (or an accept racing the
      // expire-pet-transfers cron) both pass it. The row lock serializes them;
      // the loser sees the flipped status here and aborts BEFORE touching
      // ownerships (no longer relying on the unique-active-owner index to catch
      // the second insert). Mirrors submitFreeClaimAction's SELECT ... FOR
      // UPDATE + in-tx re-check.
      const locked = await repo.findTransferByIdForUpdate(
        transfer.id,
        tx as Parameters<typeof repo.findTransferByIdForUpdate>[1],
      );
      if (!locked || locked.status !== "pending") {
        throw new Error(`La transferencia ya está ${locked?.status ?? "no encontrada"}.`);
      }

      // CUSTODY GUARD (TR-C1): the transfer row being pending is NOT enough.
      // `closeOwnerOwnerships(petId)` below ends whoever is the CURRENT active
      // owner — not necessarily `transfer.fromOwnerId`. A stale A→B transfer
      // accepted AFTER a govt dispute moved custody A→C would silently strip C
      // and hand the pet to B (custody theft), and the emitted event would lie
      // ("A→B"). Re-run the initiate-time pet guards AND assert the sender is
      // still the single active owner, all under the transfer lock, before any
      // destructive custody write. Default to a HARD ERROR (never auto-cancel).
      const petSnapshot = await repo.findPetStatusById(
        transfer.petId,
        tx as Parameters<typeof repo.findPetStatusById>[1],
      );
      if (!petSnapshot) {
        throw new Error("La mascota ya no existe. La transferencia no es válida.");
      }
      petName = petSnapshot.name;
      const petGuard = validatePetStatusForTransfer({
        status: petSnapshot.status,
        inCustodyDispute: petSnapshot.inCustodyDispute,
      });
      if (!petGuard.ok) {
        throw new Error(petGuard.error);
      }
      const currentOwner = await repo.findActiveOwnerOwnership(
        transfer.petId,
        tx as Parameters<typeof repo.findActiveOwnerOwnership>[1],
      );
      if (!currentOwner || currentOwner.ownerUserId !== transfer.fromOwnerId) {
        throw new Error("La transferencia ya no es válida: la titularidad cambió.");
      }

      // SPONSORED-PET GUARD (REQ-15): `closeOwnerOwnerships` below ends the
      // titular's `owner` row and NOTHING else — by design, per its own
      // docblock. A shelter's `shelter_custody` row opened by a rehome
      // sponsorship therefore survives the hand-off and now stands over a
      // stranger: the public catalogue keeps saying "vive con su familia", and
      // the shelter keeps the power to finalise an adoption that would close
      // the NEW owner's row. Refuse — never end the sponsorship inside another
      // hand-off — exactly as the cross-org twin does (refuseIfSponsoredCustody).
      // Initiate refuses too, but that read is stale: a sponsorship can start
      // during the 7-day window, so the check that HOLDS is this one, under the
      // transfer lock, before any destructive custody write.
      const notSponsored = validatePetNotSponsored({
        openSponsorship: await repo.findOpenSponsorship(
          transfer.petId,
          tx as Parameters<typeof repo.findOpenSponsorship>[1],
        ),
      });
      if (!notSponsored.ok) {
        throw new Error(notSponsored.error);
      }

      // PARITY QUIRK: close BEFORE insert.
      //
      // The accepting user signs the `caretaker_ended` facts (their acceptance
      // is what ended the arrangements), and the ended grants are kept for the
      // post-commit notice below (A09-2): a caretaker who may be physically
      // holding the animal otherwise loses access with no word at all.
      const closed = await repo.closeOwnerOwnerships(
        transfer.petId,
        tx as Parameters<typeof repo.closeOwnerOwnerships>[1],
        { actorUserId: user.id, now },
      );
      endedGrants = closed.endedCaretakerGrants;

      await repo.insertOwnerOwnership(
        { petId: transfer.petId, ownerUserId: user.id, startedAt: now },
        tx as Parameters<typeof repo.insertOwnerOwnership>[1],
      );

      await repo.insertPetEvent(
        {
          petId: transfer.petId,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "owner",
          payload: {
            payload_version: 1,
            from_user_id: transfer.fromOwnerId,
            to_user_id: user.id,
            // Owner→owner P2P handoff: both actors hold the `owner` role. These
            // are REQUIRED by the custody_transferred P2P schema variant.
            from_role: "owner",
            to_role: "owner",
            // reason is validated at initiate (validateOwnerTransferReason), so
            // it is one of sale/gift/inheritance/other. The column is nullable
            // (legacy rows) — coalesce a null to "other" to satisfy the schema.
            reason: transfer.reason ?? "other",
            transfer_token: input.transferToken,
          },
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      // Conditional flip: only update while still pending. Belt-and-suspenders
      // with the FOR UPDATE re-check above — a zero-row result means another
      // writer won the race under the lock, so we abort the whole tx.
      const updatedRows = await repo.updateTransferStatus(
        {
          id: transfer.id,
          status: "accepted",
          respondedAt: now,
          toOwnerId: user.id,
          expectedStatus: "pending",
        },
        tx as Parameters<typeof repo.updateTransferStatus>[1],
      );
      if (updatedRows === 0) {
        throw new Error(`La transferencia ya está ${transfer.status}.`);
      }

      pendingNotifications.push({
        userId: transfer.fromOwnerId,
        notificationType: "pet_transfer_accepted",
        severity: "success",
        title: "Transferencia aceptada",
        body: "El receptor aceptó la propuesta. La mascota ya no figura a tu nombre.",
        ctaUrl: "/mis-mascotas",
        ctaLabel: "Ver mis mascotas",
        relatedPetId: transfer.petId,
        category: "custody",
      });
    });
  } catch (err) {
    // A schema-validation failure on the emitted event is an internal defect,
    // not something the end user can act on — keep the raw zod detail in the
    // server logs and surface a friendly message instead of leaking it.
    if (err instanceof Error && err.name === "EventPayloadValidationError") {
      console.error(
        "[transfers/accept-pet-transfer] custody_transferred payload validation failed:",
        err.message,
      );
      return {
        ok: false,
        error: "No pudimos completar la transferencia. Volvé a intentarlo en unos minutos.",
      };
    }
    // Concurrency guards above throw friendly Spanish messages (row already
    // resolved, etc.) — surface those as-is.
    return { ok: false, error: err instanceof Error ? err.message : "Error desconocido." };
  }

  // Fetch pet publicToken for cache revalidation in the thin action.
  const petPublicToken = await repo.findPetPublicTokenById(transfer.petId);

  // A09-2 — exactly as finalize-adoption: sent directly, after commit, because
  // the copy and the dedupe family belong to the hand-off primitive (the expiry
  // cron uses the same keys and must not be able to double-notify).
  // `createNotification` dead-letters instead of throwing, so this cannot fail
  // an accept that already committed.
  if (endedGrants.length > 0) {
    await notifyCaretakersOfHandoff(endedGrants, { name: petName, publicToken: petPublicToken });
  }

  return {
    ok: true,
    value: { petId: transfer.petId, fromOwnerId: transfer.fromOwnerId, petPublicToken },
    notifications: pendingNotifications,
  };
}
