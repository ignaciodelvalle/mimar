// Use-case: the titular withdraws an invitation before it is answered.
//
// CANCEL IS NOT END. Cancelling applies only to a `pending` row, which has no
// ownership row and no spine event to undo. Ending applies to an `accepted`
// one and must close the ownership row and emit `caretaker_ended` — see
// end-caretaker-grant.ts. The state machine refuses to blur them, and the
// database's biconditional accept CHECK would refuse the resulting row anyway;
// failing here is what turns that into a sentence the titular can read.

import { canApply } from "../domain/grant-state";
import type { CaretakersRepositoryPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = { repo: CaretakersRepositoryPort; now: () => Date };

export type CancelCaretakerGrantInput = {
  grantPublicToken: string;
  titularUserId: string;
};

export async function cancelCaretakerGrant(
  input: CancelCaretakerGrantInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string }>> {
  const { repo } = deps;
  const now = deps.now();

  const grant = await repo.findGrantByToken(input.grantPublicToken);
  if (!grant) return { ok: false, error: "Invitación no encontrada." };

  if (grant.grantedByUserId !== input.titularUserId) {
    return { ok: false, error: "Esta invitación no es tuya." };
  }

  if (!canApply(grant.status, "cancel")) {
    return {
      ok: false,
      error:
        grant.status === "accepted"
          ? "El cuidado ya está activo. Usá «Finalizar ahora» para terminarlo."
          : "Esta invitación ya no está pendiente.",
    };
  }

  const updated = await repo.updateGrantStatus({
    grantId: grant.id,
    status: "cancelled",
    expectedStatus: "pending",
    respondedAt: now,
    now,
  });
  if (updated === 0) {
    return { ok: false, error: "Esta invitación ya no está pendiente." };
  }

  const pet = await repo.findPetSummaryById(grant.petId);

  // Only an invitee WITH an account can receive an in-app notification. An
  // email-only invitee has no user_id, and notifications.user_id is NOT NULL —
  // there is nobody to tell in this channel.
  const notifications: NewNotification[] = grant.caretakerUserId
    ? [
        {
          userId: grant.caretakerUserId,
          notificationType: "caretaker_invitation_cancelled",
          // Stable across: a retry of this cancel. The UPDATE is guarded by
          // `expectedStatus: "pending"`, so a second pass emits nothing anyway;
          // the key covers the window where the update landed and the flush
          // did not. Distinct across: other grants — cancelling a later
          // invitation to the same person must still notify them.
          dedupeKey: `caretaker:invitation_cancelled:${grant.id}:${grant.caretakerUserId}`,
          // no-cta: the invitation is gone. /cuidado/<token> would 404 and the
          // pet is not theirs to open — there is nowhere this person can go
          // that is about this notice. A CTA to somewhere generic would be
          // worse than none.
          severity: "info",
          title: `Se canceló la invitación para cuidar a ${pet?.name ?? "una mascota"}`,
          body: "El titular retiró la invitación antes de que la respondieras.",
          relatedPetId: grant.petId,
          category: "custody",
        },
      ]
    : [];

  return { ok: true, value: { petId: grant.petId }, notifications };
}
