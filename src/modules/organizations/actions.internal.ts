// Internal writers for the organizations domain — NOT server actions.
//
// This module is intentionally NOT a "use server" file: its exports accept a
// caller-supplied userId and must never be independently addressable from the
// client (authz triage 2026-07-04). The guarded public entry point is
// updateOrganizationAction in ./actions.ts, which derives the userId from the
// session before delegating to the same use-case.

import { revalidatePath } from "next/cache";

import { updateOrganization } from "./application/update-organization";
import { OrgRepository } from "./infrastructure/org-repository";

import type { UpdateOrgFormState } from "./actions";

const repo = new OrgRepository();

export type UpdateOrgInput = {
  orgToken: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  description?: string | null;
  personeriaJuridicaNumber?: string | null;
  tier0ShowOriginOrg?: boolean;
};

// Testable inner writer: scopes by the caller-supplied userId. The admin-role
// re-check runs inside the updateOrganization use-case.
export async function updateOrganizationForUser(
  userId: string,
  orgToken: string,
  input: UpdateOrgInput,
): Promise<UpdateOrgFormState> {
  const result = await updateOrganization(
    {
      userId,
      orgToken,
      fields: {
        displayName: input.displayName,
        legalName: input.legalName,
        email: input.email,
        phone: input.phone,
        website: input.website,
        description: input.description,
        personeriaJuridicaNumber: input.personeriaJuridicaNumber,
        tier0ShowOriginOrg: input.tier0ShowOriginOrg,
      },
    },
    { repo },
  );

  if (!result.ok) return { error: result.error };

  revalidatePath(`/org/${orgToken}/configuracion`);
  revalidatePath(`/org/${orgToken}`);

  return { error: null, ok: true };
}
