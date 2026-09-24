// Use-case: setPetFound
//
// Migrated from app/actions/events.ts::setPetFoundAction.
//
// AUTH: requirePetAccess (accepts deceased/lost) at the action layer.
//   This function is auth-agnostic — exported for tests.
//
// Parity:
//   - status=deceased → throw with "fallecida" message.
//   - status≠lost → idempotent early return (NO write) — returns { ok: true, alreadyActive: true }.
//   - Normal path: findOpenCaseForPetAndKind(lost_pet_episode) + insert status_changed(lost→active)
//     + updateStatusProjection(active) + closeCase (if case found).
//   - Result: { ok: true, alreadyActive: boolean }

import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";

type CaseExecutor = Parameters<typeof closeCase>[1];

import type { EventsRepository } from "../../infrastructure/events-repository";
import type { NewNotification } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetPetFoundParams = {
  petId: string;
  petStatus: string;
  petPublicToken: string;
  /** Pet name + sex for the recovery-notification copy (UI-4). */
  petName: string;
  petSex: string | null;
  recordedByUserId: string;
  /** User id of the pet's current owner — recipient of the confirmation. */
  ownerUserId: string;
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  now?: Date;
};

export type SetPetFoundResult = { ok: true; alreadyActive: boolean };

type Deps = {
  repo: Pick<EventsRepository, "insertEvent" | "updateStatusProjection">;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /**
   * Resolves the user ids that received the original lost_pet_broadcast for this
   * pet, so the resolution notice reaches the same audience. Optional: when
   * absent (e.g. headless tests), only the owner confirmation is emitted.
   */
  findBroadcastRecipientUserIds?: (petId: string) => Promise<string[]>;
  /**
   * Flushes pending notifications post-tx. Optional so existing call sites and
   * tests that do not care about notifications keep working unchanged.
   */
  flushNotifications?: (pending: NewNotification[]) => Promise<void>;
};

// Masculine/feminine/neutral past participle for "encontrado".
function foundParticiple(sex: string | null): string {
  if (sex === "male") return "encontrado";
  if (sex === "female") return "encontrada";
  return "encontrada/o";
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

/**
 * Mark a pet as found (active) from lost status.
 * Throws for deceased pets (parity with original which throws inside setPetFoundAction).
 * Returns alreadyActive=true without writing when pet is not lost (idempotent guard).
 */
export async function setPetFound(
  params: SetPetFoundParams,
  deps: Deps,
): Promise<SetPetFoundResult> {
  const {
    petId,
    petStatus,
    petPublicToken,
    petName,
    petSex,
    recordedByUserId,
    ownerUserId,
    eventAuthorship,
    now = new Date(),
  } = params;

  if (petStatus === "deceased") {
    throw new Error("Esta mascota está registrada como fallecida y no acepta nuevos eventos.");
  }

  if (petStatus !== "lost") {
    // Idempotent — pet is already active (or in some other non-lost status).
    return { ok: true, alreadyActive: true };
  }

  // Look up the open lost_pet_episode so the status_changed event carries case_id.
  const lostCase = await findOpenCaseForPetAndKind(petId, "lost_pet_episode");

  await deps.transaction(async (tx) => {
    const eventPayload = validateEventPayload("status_changed", {
      from_status: "lost",
      to_status: "active",
    });

    await deps.repo.insertEvent(
      {
        petId,
        eventType: "status_changed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId,
        ...eventAuthorship,
        payload: eventPayload,
        caseId: lostCase?.id ?? null,
      } as Parameters<typeof deps.repo.insertEvent>[0],
      tx as Parameters<typeof deps.repo.insertEvent>[1],
    );

    await deps.repo.updateStatusProjection(
      petId,
      "active",
      now,
      tx as Parameters<typeof deps.repo.updateStatusProjection>[3],
    );

    if (lostCase) {
      await closeCase(
        { caseId: lostCase.id, reason: "resolved", closedByUserId: recordedByUserId },
        tx as CaseExecutor,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Recovery notifications (UI-4 fix 3). Emitted post-tx, best-effort: a
  // notification failure must never roll back the recovery itself.
  // -------------------------------------------------------------------------
  const participle = foundParticiple(petSex);
  const pending: NewNotification[] = [];

  // (a) Confirmation to the OWNER. Non-urgent, informational with CTA to the pet
  // (now back in the normal profile / cockpit-exited view).
  pending.push({
    userId: ownerUserId,
    notificationType: "lost_episode_resolved_owner",
    severity: "success",
    title: `Marcaste a ${petName} como ${participle}`,
    body: "Su credencial pública volvió al modo normal. ¡Nos alegra el reencuentro!",
    relatedPetId: petId,
    relatedCaseId: lostCase?.id ?? null,
    category: "perdidas",
    ctaLabel: "Ver mascota",
    ctaUrl: `/mis-mascotas/${petPublicToken}`,
  });

  // (b) Resolution notice to the org members who received the original
  // lost_pet_broadcast — same audience, so they stop looking. Informational,
  // severity=info, CTA to the public credential.
  if (deps.findBroadcastRecipientUserIds) {
    let recipientIds: string[] = [];
    try {
      recipientIds = await deps.findBroadcastRecipientUserIds(petId);
    } catch (err) {
      console.error("[setPetFound] broadcast recipient lookup failed (non-fatal):", err);
      recipientIds = [];
    }
    for (const userId of recipientIds) {
      // Never notify the owner twice (they may also belong to a covering org).
      if (userId === ownerUserId) continue;
      pending.push({
        userId,
        notificationType: "lost_episode_resolved_broadcast",
        severity: "info",
        title: `${petName} fue ${participle}`,
        body: "La mascota perdida que se difundió en tu zona ya volvió con su familia. Gracias por estar atento/a.",
        relatedPetId: petId,
        relatedCaseId: lostCase?.id ?? null,
        category: "perdidas",
        ctaLabel: "Ver credencial",
        ctaUrl: `/p/${petPublicToken}`,
      });
    }
  }

  if (deps.flushNotifications && pending.length > 0) {
    await deps.flushNotifications(pending);
  }

  return { ok: true, alreadyActive: false };
}
