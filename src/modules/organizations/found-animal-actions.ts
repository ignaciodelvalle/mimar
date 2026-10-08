"use server";

// Thin action controllers for P4 — organizations that receive found animals
// (migration 0292; design note docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md).
//
//   updateFoundAnimalIntakeAction — an org admin's settings card on
//     /org/{token}/configuracion. requireOrgAccessByToken at the edge, the admin
//     re-check in the use case. The audit row is written by the table's trigger.
//
// The finder's public lookup lives in found-help-public-actions.ts, apart on
// purpose: this file is imported by an authenticated page, and anything it
// imports counts as "behind auth" for the public soft-delete census
// (__tests__/public-soft-delete-resolution.test.ts). The public limiter pulls
// the credential readers, which must stay public-only there.

import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { updateFoundAnimalIntake } from "@/src/modules/organizations/application/update-found-animal-intake";
import type { FoundAnimalIntakeSettings } from "@/src/modules/organizations/domain/found-animal-intake";
import { upsertFoundAnimalIntake } from "@/src/modules/organizations/infrastructure/found-animal-intake-write";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

export type FoundAnimalIntakeFormState = {
  error: string | null;
  /** The settings as saved — the card shows them without a revalidation. */
  saved?: FoundAnimalIntakeSettings | null;
};

const repo = new OrgRepository();

export async function updateFoundAnimalIntakeAction(
  _prev: FoundAnimalIntakeFormState,
  formData: FormData,
): Promise<FoundAnimalIntakeFormState> {
  const orgToken = String(formData.get("orgToken") ?? "").trim();
  if (!orgToken) return { error: "Token de organización requerido." };

  // Outer guard: redirect to /login if unauth; notFound() if no active membership.
  const { user } = await requireOrgAccessByToken(orgToken);

  const result = await updateFoundAnimalIntake(
    {
      userId: user.id,
      orgToken,
      fields: {
        accepting: formData.get("accepting") === "true",
        capacityStatus: String(formData.get("capacityStatus") ?? ""),
        publicContactKind: String(formData.get("publicContactKind") ?? "") || null,
        publicContactValue: String(formData.get("publicContactValue") ?? "") || null,
        publicHours: String(formData.get("publicHours") ?? "") || null,
      },
    },
    { repo, upsert: upsertFoundAnimalIntake },
  );
  if (!result.ok) return { error: result.error };
  return { error: null, saved: result.value };
}
