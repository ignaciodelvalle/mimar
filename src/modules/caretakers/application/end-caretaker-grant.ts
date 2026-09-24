// Use-case: an ACCEPTED arrangement stops. The mirror image of accept.
//
// Four doors, one transaction: close the `ownerships(role='caretaker')` row,
// emit `caretaker_ended`, flip the grant to `ended`. Same all-or-nothing
// requirement as accept, for the same reason — an ownership row left open with
// an event saying it closed is a caretaker who still has write access the log
// says they lost.
//
// THE OUTCOME IS LOAD-BEARING COPY, NOT METADATA. `expired` must never be
// rendered as "the animal came back". The arrangement ended; where the animal
// is, is an open question the titular has to act on. That is why the outcome
// rides the event payload and why the notification bodies below differ.

import { type GrantAction, canApply, endedReasonFor } from "../domain/grant-state";
import type { CaretakersRepositoryPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = {
  repo: CaretakersRepositoryPort;
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

/** The subset of GrantAction that ends an accepted grant. */
export type EndAction = Extract<GrantAction, "revoke" | "withdraw" | "return" | "expire_grant">;

export type EndCaretakerGrantInput = {
  grantPublicToken: string;
  action: EndAction;
  /** Null for the cron. Otherwise the acting user, checked against the action. */
  actorUserId: string | null;
};

export async function endCaretakerGrant(
  input: EndCaretakerGrantInput,
  deps: Deps,
): Promise<UseCaseResult<{ petId: string; petPublicToken: string | null }>> {
  const { repo, transaction } = deps;
  const now = deps.now();

  const grant = await repo.findGrantByToken(input.grantPublicToken);
  if (!grant) return { ok: false, error: "Cuidado no encontrado." };

  if (!canApply(grant.status, input.action)) {
    return { ok: false, error: "Este cuidado ya no está activo." };
  }
  if (grant.ownershipId === null) {
    // Unreachable while the DB's biconditional accept CHECK holds (accepted ⇔
    // caretaker_user_id AND ownership_id both set). Refused rather than
    // narrowed with a `!`, so a future schema loosening surfaces as a message
    // instead of a null dereference inside a transaction.
    return { ok: false, error: "Este cuidado ya no está activo." };
  }

  // WHO may pull which lever. Revocation is the titular's unilateral right;
  // withdrawal is the caretaker's. Neither may perform the other's, or
  // "revoked by owner" would appear in the spine over a caretaker's decision.
  if (input.action === "revoke" && input.actorUserId !== grant.grantedByUserId) {
    return { ok: false, error: "Solo el titular puede finalizar el cuidado." };
  }
  if (input.action === "withdraw" && input.actorUserId !== grant.caretakerUserId) {
    return { ok: false, error: "Solo el cuidador/a puede dar de baja su cuidado." };
  }
  if (input.action === "return" && input.actorUserId !== grant.grantedByUserId) {
    return { ok: false, error: "Solo el titular puede registrar la devolución." };
  }

  const outcome = endedReasonFor(input.action);
  if (outcome === null) {
    return { ok: false, error: "Acción no válida para este cuidado." };
  }

  const ownershipId = grant.ownershipId;

  try {
    await transaction(async (tx) => {
      const locked = await repo.findGrantByIdForUpdate(grant.id, tx);
      if (!locked || locked.status !== "accepted") {
        throw new Error("Este cuidado ya no está activo.");
      }

      await repo.insertEndGrant(
        {
          grantId: grant.id,
          petId: grant.petId,
          ownershipId,
          outcome,
          endsAt: grant.endsAt,
          actorUserId: input.actorUserId,
          now,
        },
        tx,
      );
    });
  } catch (err) {
    console.error("[caretakers/end] end transaction failed:", err);
    return { ok: false, error: "No pudimos finalizar el cuidado. Volvé a intentarlo." };
  }

  const pet = await repo.findPetSummaryById(grant.petId);
  const petName = pet?.name ?? "tu mascota";
  const caretakerName =
    (grant.caretakerUserId ? await repo.findDisplayName(grant.caretakerUserId) : null) ??
    "el cuidador/a";
  const endsAtLabel = formatArDate(grant.endsAt);

  const notifications: NewNotification[] = [
    {
      userId: grant.grantedByUserId,
      notificationType: "caretaker_grant_ended",
      // THE RECIPIENT ID IS LOAD-BEARING HERE. This notice has TWO recipients
      // (titular below, caretaker further down) and they get different copy;
      // keying on the grant id alone would collapse the second insert into the
      // first and one of the two parties would never be told the arrangement
      // ended.
      //
      // Stable across: a retry of this action AND a subsequent cron pass — the
      // key is deliberately IDENTICAL to the one expire-caretaker-grants.ts
      // uses. A grant ends exactly once (both writers gate on `accepted` under
      // a row lock, so the loser emits nothing), and in the pathological race
      // where both produced payloads, one "el cuidado terminó" per person is
      // the correct outcome. There is no outcome/actor in the key: the fact
      // being announced is "it ended", not "how".
      dedupeKey: `caretaker:grant_ended:${grant.id}:${grant.grantedByUserId}`,
      severity: outcome === "expired" ? "warning" : "info",
      title: `El cuidado temporal de ${petName} terminó`,
      body: titularBody({ outcome, caretakerName, petName, endsAtLabel }),
      ctaLabel: "Ver mascota",
      ctaUrl: pet ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    },
  ];

  if (grant.caretakerUserId) {
    notifications.push({
      userId: grant.caretakerUserId,
      notificationType: "caretaker_grant_ended",
      // Same key family as the titular's copy above, differing ONLY in the
      // recipient — that is what keeps both rows alive.
      dedupeKey: `caretaker:grant_ended:${grant.id}:${grant.caretakerUserId}`,
      severity: "info",
      title: `Tu período de cuidado de ${petName} terminó`,
      body: `Ya no tenés acceso para cargar eventos de ${petName}. Si todavía está con vos, coordiná la devolución con el titular.`,
      ctaLabel: "Ver mis mascotas",
      ctaUrl: "/mis-mascotas",
      relatedPetId: grant.petId,
      category: "custody",
    });
  }

  return {
    ok: true,
    value: { petId: grant.petId, petPublicToken: pet?.publicToken ?? null },
    notifications,
  };
}

/**
 * The titular's copy, per outcome.
 *
 * The `expired` branch is the spec's own sentence and the reason the outcome
 * enum exists: the period ran out, which says NOTHING about where the animal
 * is. Anything that reads like "returned" here would be the system asserting a
 * fact nobody recorded.
 */
function titularBody(args: {
  outcome: string;
  caretakerName: string;
  petName: string;
  endsAtLabel: string;
}): string {
  const { outcome, caretakerName, petName, endsAtLabel } = args;
  switch (outcome) {
    case "expired":
      return `El cuidado temporal de ${caretakerName} terminó el ${endsAtLabel}. Si ${petName} sigue con esa persona, coordiná la devolución o iniciá un reclamo.`;
    case "revoked_by_owner":
      return `Finalizaste el cuidado temporal de ${caretakerName}. Si ${petName} sigue con esa persona, coordiná la devolución o iniciá un reclamo.`;
    case "withdrawn_by_caretaker":
      return `${caretakerName} dio de baja el cuidado temporal. Si ${petName} sigue con esa persona, coordiná la devolución o iniciá un reclamo.`;
    // NO `ownership_transferred` CASE, deliberately. That outcome exists for
    // hand-offs (adoption finalize, decomiso, dispute resolution), which never
    // route through this use-case: `endedReasonFor` maps only the four
    // GrantActions above, so a branch here would be unreachable. The hand-off
    // copy for both parties lives with the hand-off, in
    // lib/infra/end-pet-ownerships.ts `notifyCaretakersOfHandoff`.
    default:
      return `${caretakerName} te devolvió a ${petName}. El cuidado temporal terminó.`;
  }
}

function formatArDate(date: Date): string {
  return date.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}
