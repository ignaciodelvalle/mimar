"use server";

// intake.ts — thin shim (strangler migration 11/61).
//
// Business logic moved to:
//   src/modules/pets/application/intake/
//
// This file re-exports the IntakeFormState type and provides the thin
// createIntakeAction wrapper (used by UI components) that adds the auth guard.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { createIntake } from "@/src/modules/pets/application/intake/create-intake";
import type { IntakeFormState } from "@/src/modules/pets/application/intake/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { IntakeFormState };

// ---------------------------------------------------------------------------
// Action wrapper — thin controller for UI components
// ---------------------------------------------------------------------------

export async function createIntakeAction(
  orgToken: string,
  _previous: IntakeFormState,
  formData: FormData,
): Promise<IntakeFormState> {
  // Pin the capability check to the org identified by the URL orgToken — never
  // the session-default membership. Otherwise a multi-org member acting under
  // /org/{orgToken}/intake would author the intake (ownership.ownerOrganizationId
  // + pet_registered authorOrganizationId) against their last-joined org.
  const auth = await requireCapabilityForOrgToken("intake.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;
  return createIntake(orgToken, user, organization, formData);
}
