// Use-case: end an active foster for a pet.
//
// Migrated from app/actions/foster.ts::endFosterAction.
// Auth (foster.end capability) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Pet lookup (must be in org's custody)
//   2. Active foster row check
//   3. Atomic tx: repo.insertEndFoster (end ownership + event + close case + read slots)
//   4. Re-enroll prompt: IF volunteerAvailableSlots === 0 THEN push notification
//   5. Return UseCaseResult with redirectPath + notifications
//
// NOT handled here:
//   - requireCapability("foster.end")
//   - Parsing formData
//   - redirect / revalidatePath
//   - Flushing pendingNotifications
//
// PARITY: redirect param is ?fostend= (NOT ?foster=) — preserve exactly.
// PARITY: re-enroll prompt fires only when availableSlots===0 (read in tx).

import { endReasonToClosedReason, resolveEndFosterReason } from "../domain/assign-rules";
import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type EndFosterInput = {
  petPublicToken: string;
  reasonRaw: string;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function endFoster(
  input: EndFosterInput,
  deps: Deps,
): Promise<UseCaseResult<{ redirectPath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Pet lookup — must be in org's active custody.
  const petRow = await repo.findShelterPetByToken(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 2. Active foster row check.
  const activeFosterRows = await repo.findActiveFosterRows(petRow.id);
  const fosterRow = activeFosterRows[0] ?? null;
  if (!fosterRow || !fosterRow.ownerUserId) {
    return { ok: false, error: "Este animal no tiene un tránsito activo para finalizar." };
  }

  const fosterUserId = fosterRow.ownerUserId;

  // 3. Resolve reason + closed_reason.
  const reason = resolveEndFosterReason(input.reasonRaw);
  const closedReason = endReasonToClosedReason(reason);

  const now = new Date();
  const pendingNotifications: NewNotification[] = [];
  let volunteerSlots: number | null = null;

  // 4. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const { volunteerAvailableSlots } = await repo.insertEndFoster(
        {
          petId: petRow.id,
          petName: (petRow as { name: string }).name,
          fosterOwnershipId: fosterRow.id,
          fosterUserId,
          reason,
          closedReason,
          notes: input.notes,
          actorUserId: user.id,
          actorOrgId: organization.id,
          actorOrgVerified: organization.verified,
          now,
        },
        tx as Parameters<typeof repo.insertEndFoster>[1],
      );

      volunteerSlots = volunteerAvailableSlots;

      pendingNotifications.push({
        userId: fosterUserId,
        notificationType: "foster_ended",
        title: `Finalizó tu tránsito: ${(petRow as { name: string }).name}`,
        body: `${organization.displayName} cerró el tránsito de ${(petRow as { name: string }).name}.${
          input.notes ? ` Nota: ${input.notes}` : ""
        }`,
        severity: "info",
        ctaLabel: "Ver detalles",
        ctaUrl: "/mis-mascotas",
        relatedPetId: petRow.id,
      });

      // Re-enroll prompt: fire ONLY when availableSlots===0 (spec R2 parity).
      if (volunteerAvailableSlots !== null && volunteerAvailableSlots === 0) {
        pendingNotifications.push({
          userId: fosterUserId,
          notificationType: "foster_volunteer_reenroll_prompt",
          title: `Tu tránsito con ${(petRow as { name: string }).name} terminó`,
          body: "¿Querés volver al pool y recibir nuevas propuestas?",
          severity: "info",
          ctaLabel: "Inscribirme de nuevo",
          ctaUrl: "/cuenta/ofrecerme-como-transito",
          relatedPetId: petRow.id,
        });
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo finalizar el tránsito: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  void volunteerSlots; // assigned in tx, captured before tx close

  return {
    ok: true,
    value: {
      // PARITY: ?fostend= (NOT ?foster=)
      redirectPath: `/org/${organization.publicToken}/mascotas?fostend=${input.petPublicToken}`,
    },
    notifications: pendingNotifications,
  };
}
