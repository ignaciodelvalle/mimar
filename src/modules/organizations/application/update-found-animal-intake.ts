// Use-case: an org admin sets whether the org receives found animals
// (migration 0292, P4).
//
// Auth: the action's outer guard (requireOrgAccessByToken) proves a live
// session and SOME membership; the admin re-check is HERE, independent of it,
// the same split updateOrganization uses. The org's type must have the
// setting (canReceiveFoundAnimals) — a refused write, not a stored value
// nothing reads.
//
// AUDIT: not written here. The row trigger on org_found_animal_intake writes
// org_found_animal_intake_changed (before → after) in the same statement, for
// this path and for the RLS write path alike; the writer hands it the actor.

import {
  type FoundAnimalIntakeInput,
  type FoundAnimalIntakeSettings,
  canReceiveFoundAnimals,
  validateFoundAnimalIntake,
} from "@/src/modules/organizations/domain/found-animal-intake";
import type { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

export type UpdateFoundAnimalIntakeInput = {
  userId: string;
  orgToken: string;
  fields: FoundAnimalIntakeInput;
};

type Deps = {
  repo: Pick<OrgRepository, "findMembershipByUserAndOrgToken">;
  upsert: (
    organizationId: string,
    settings: FoundAnimalIntakeSettings,
    actorUserId: string,
  ) => Promise<void>;
};

export async function updateFoundAnimalIntake(
  input: UpdateFoundAnimalIntakeInput,
  deps: Deps,
): Promise<UseCaseResult<FoundAnimalIntakeSettings>> {
  const validated = validateFoundAnimalIntake(input.fields);
  if (!validated.ok) return { ok: false, error: validated.error };

  const row = await deps.repo.findMembershipByUserAndOrgToken(input.userId, input.orgToken);
  if (!row) return { ok: false, error: "No tenés acceso a esta organización." };
  if (row.membership.role !== "admin") {
    return {
      ok: false,
      error: "Solo los administradores de la organización pueden cambiar esta opción.",
    };
  }
  if (!canReceiveFoundAnimals(row.org.orgType)) {
    return {
      ok: false,
      error: "Este tipo de organización no puede figurar como receptora de animales encontrados.",
    };
  }

  await deps.upsert(row.org.id, validated.value, input.userId);
  return { ok: true, value: validated.value, notifications: [] };
}
