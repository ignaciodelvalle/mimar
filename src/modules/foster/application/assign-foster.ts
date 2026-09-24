// Use-case: assign a foster volunteer to a pet in shelter custody.
//
// Migrated from app/actions/foster.ts::assignFosterAction.
// Auth (foster.assign capability) is handled by the caller (thin action).
//
// Orchestrates:
//   1. Input validation (domain rules)
//   2. Pet lookup (must be in org's shelter_custody)
//   3. Membership check (foster must be active member of org)
//   4. One-foster-at-a-time guard
//   5. Atomic tx: repo.insertAssignFoster (ownership + case + event)
//   6. Collect post-tx best-effort notifications
//   7. Return UseCaseResult with redirectPath + notifications
//
// NOT handled here (stays in the action):
//   - requireCapability("foster.assign")
//   - Parsing formData
//   - redirect / revalidatePath
//   - Flushing pendingNotifications

import { validateAssignFosterInput } from "../domain/assign-rules";
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

export type AssignFosterInput = {
  petPublicToken: string;
  fosterUserId: string;
  expectedWeeksRaw: string;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function assignFoster(
  input: AssignFosterInput,
  deps: Deps,
): Promise<UseCaseResult<{ redirectPath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Domain validation.
  const validation = validateAssignFosterInput({
    fosterUserId: input.fosterUserId,
    expectedWeeksRaw: input.expectedWeeksRaw,
    notes: input.notes,
  });
  if (!validation.ok) return { ok: false, error: validation.error };
  const validated = validation.value;

  // 2. Pet lookup.
  const petRow = await repo.findShelterPetByToken(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 3. Foster must be an active member of the org.
  const membership = await repo.findActiveMembership(validated.fosterUserId, organization.id);
  if (!membership) {
    return { ok: false, error: "Esa persona no es miembro activo de la organización." };
  }

  // 4. One-foster-at-a-time guard.
  const activeFosterRows = await repo.findActiveFosterRows(petRow.id);
  if (activeFosterRows.length > 0) {
    return {
      ok: false,
      error: "Este animal ya tiene un tránsito activo. Finalizalo antes de asignar otro.",
    };
  }

  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  // 5. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const { caseId } = await repo.insertAssignFoster(
        {
          petId: petRow.id,
          petName: (petRow as { name: string }).name,
          petJurisdictionProvince:
            (petRow as { jurisdictionProvince?: string | null }).jurisdictionProvince ?? null,
          petJurisdictionLocality:
            (petRow as { jurisdictionLocality?: string | null }).jurisdictionLocality ?? null,
          fosterUserId: validated.fosterUserId,
          expectedWeeks: validated.expectedWeeks,
          notes: validated.notes,
          actorUserId: user.id,
          actorOrgId: organization.id,
          actorOrgVerified: organization.verified,
          actorOrgDisplayName: organization.displayName,
          now,
        },
        tx as Parameters<typeof repo.insertAssignFoster>[1],
      );

      pendingNotifications.push({
        userId: validated.fosterUserId,
        notificationType: "foster_assigned",
        title: `Te asignaron tránsito: ${(petRow as { name: string }).name}`,
        body: `${organization.displayName} te asignó como tránsito de ${(petRow as { name: string }).name}.`,
        severity: "info",
        ctaLabel: "Ver detalles",
        ctaUrl: "/mis-mascotas",
        relatedPetId: petRow.id,
        relatedCaseId: caseId,
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo asignar el tránsito: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  return {
    ok: true,
    value: {
      redirectPath: `/org/${organization.publicToken}/mascotas?foster=${input.petPublicToken}`,
    },
    notifications: pendingNotifications,
  };
}
