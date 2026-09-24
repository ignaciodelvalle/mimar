// Use-case: the invitee declines a pending invitation.
//
// No spine event, no ownership row. A pending invitation is workflow state —
// emitting `caretaker_ended` here would record, permanently, an arrangement
// that never began.

import { canApply } from "../domain/grant-state";
import type { CaretakersRepositoryPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = { repo: CaretakersRepositoryPort; now: () => Date };

export type RejectCaretakerGrantInput = {
  grantPublicToken: string;
  callerUserId: string;
  callerEmail: string;
  /**
   * GoTrue's `email_confirmed_at` is non-null for this account (A09-1).
   *
   * THE GENERIC REFUSAL, not the "confirmá tu correo" sentence the accept path
   * returns — and the reason is NOT that the screen upstream already named the
   * remedy. It does not. This comment said it did until 2026-09-03; here is what
   * actually happens.
   *
   * `get-grant-for-viewer.ts`'s `resolveRelation` folds an invitee whose address
   * is unconfirmed into `"outsider"`, and the outsider branch of
   * `app/(app)/cuidado/[grantToken]/page.tsx` renders "Esta invitación no es para
   * esta cuenta … cerrá sesión y volvé a entrar con la cuenta que recibió la
   * invitación" — advice for somebody in the WRONG account, shown to somebody in
   * the right one. So on the caretaker side the remedy is named nowhere, and this
   * refusal is generic because nothing better reaches a person here either: a
   * reject with an unproved address is a request no published client can build.
   *
   * TRANSFERS DOES NAME IT, which is what makes the caretaker side an asymmetry
   * rather than a policy: `get-transfer-for-viewer.ts` returns
   * `UNCONFIRMED_EMAIL_TRANSFER_ERROR` on its `email_unconfirmed` arm,
   * `getTransferForViewerAction` passes it through, and
   * `app/(app)/transferencias/[transferToken]/page.tsx` renders it in the callout.
   *
   * Closing the gap means changing user-facing copy on a page nobody has decided
   * about — a PO decision, deliberately out of scope of the pass that corrected
   * this comment. It is an OPEN GAP, not a property this file may rely on.
   */
  callerEmailConfirmed: boolean;
};

export async function rejectCaretakerGrant(
  input: RejectCaretakerGrantInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string }>> {
  const { repo } = deps;
  const now = deps.now();

  const grant = await repo.findGrantByToken(input.grantPublicToken);
  if (!grant) return { ok: false, error: "Invitación no encontrada." };

  // The e-mail arm needs a PROVED address, like its accept twin (A09-1).
  const matchesId = grant.caretakerUserId !== null && grant.caretakerUserId === input.callerUserId;
  const callerEmail = (input.callerEmail ?? "").trim().toLowerCase();
  const matchesEmail =
    input.callerEmailConfirmed &&
    callerEmail.length > 0 &&
    grant.caretakerEmail.trim().toLowerCase() === callerEmail;
  if (!matchesId && !matchesEmail) {
    return { ok: false, error: "Esta invitación no es para tu cuenta." };
  }

  if (!canApply(grant.status, "reject")) {
    return { ok: false, error: "Esta invitación ya no está disponible." };
  }

  const updated = await repo.updateGrantStatus({
    grantId: grant.id,
    status: "rejected",
    expectedStatus: "pending",
    respondedAt: now,
    now,
  });
  if (updated === 0) {
    // Somebody resolved it under us — the titular cancelled, or the cron
    // expired it. The pre-read status check above is a stale read by
    // construction; this predicate is what actually serialises the two writers.
    return { ok: false, error: "Esta invitación ya no está disponible." };
  }

  const pet = await repo.findPetSummaryById(grant.petId);
  const caretakerName = (await repo.findDisplayName(input.callerUserId)) ?? grant.caretakerEmail;

  const notifications: NewNotification[] = [
    {
      userId: grant.grantedByUserId,
      notificationType: "caretaker_invitation_rejected",
      // Stable across: a retry of this reject (the `expectedStatus: "pending"`
      // guard already makes a second pass a no-op). Distinct across: other
      // grants — if the titular re-invites and is declined again, that is a
      // different grant id and the titular hears about it.
      dedupeKey: `caretaker:invitation_rejected:${grant.id}:${grant.grantedByUserId}`,
      severity: "info",
      title: `${caretakerName} no puede cuidar a ${pet?.name ?? "tu mascota"}`,
      body: "Podés invitar a otra persona cuando quieras.",
      ctaLabel: "Ver mascota",
      ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    },
  ];

  return { ok: true, value: { petId: grant.petId }, notifications };
}
