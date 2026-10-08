"use server";

// Thin action controllers for P4 — organizations that receive found animals
// (migration 0292; design note docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md).
//
//   updateFoundAnimalIntakeAction — an org admin's settings card on
//     /org/{token}/configuracion. requireOrgAccessByToken at the edge, the admin
//     re-check in the use case. The audit row is written by the table's trigger.
//   findNearbyHelpAction — the anonymous finder on /encontre-un-animal. A
//     catalogue locality id in, the public-safe projection out. Per-IP limit
//     first. A POST, so nothing about the place rides in a URL or an access log.

import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { isFoundHelpLookupThrottled } from "@/lib/infra/found-help-limits";
import { reportError } from "@/lib/infra/report-error";
import {
  type LookupNearbyHelpResult,
  lookupNearbyHelpForLocality,
} from "@/src/modules/organizations/application/find-nearby-help";
import { updateFoundAnimalIntake } from "@/src/modules/organizations/application/update-found-animal-intake";
import type { FoundAnimalIntakeSettings } from "@/src/modules/organizations/domain/found-animal-intake";
import { upsertFoundAnimalIntake } from "@/src/modules/organizations/infrastructure/found-animal-intake-write";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

export type FoundAnimalIntakeFormState = {
  error: string | null;
  /** The settings as saved — the card shows them without a revalidation. */
  saved?: FoundAnimalIntakeSettings | null;
};

export type { LookupNearbyHelpResult };

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

// @no-auth-required: the anonymous finder of an animal is the whole audience.
// Input is a public catalogue locality id (never a coordinate); output is the
// public-safe projection of organizations that chose to be listed. Per-IP
// limited (lib/infra/found-help-limits.ts) BEFORE any read. Nothing is stored
// and nothing about the place is logged.
export async function findNearbyHelpAction(input: {
  localityId: string;
  includeVets: boolean;
}): Promise<LookupNearbyHelpResult> {
  try {
    return await lookupNearbyHelpForLocality(
      { localityId: String(input?.localityId ?? ""), includeVets: input?.includeVets === true },
      { isThrottled: isFoundHelpLookupThrottled },
    );
  } catch (err) {
    // Reported WITHOUT the input: the locality the finder picked is theirs.
    reportError("found-help/lookup", err);
    return { ok: false, error: "unavailable" };
  }
}
