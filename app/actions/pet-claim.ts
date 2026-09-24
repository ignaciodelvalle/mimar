"use server";

// pet-claim.ts — thin shim (strangler migration 10/61).
//
// Business logic moved to:
//   src/modules/pets/application/claim/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The bare ForUser writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied userId would let any client claim/dispute pets as any
// user. Callers import the writers from
// src/modules/pets/application/claim/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { lookupForClaimForUser as _lookupForClaim } from "@/src/modules/pets/application/claim/lookup-for-claim";
import { submitClaimDisputeForUser as _submitClaimDispute } from "@/src/modules/pets/application/claim/submit-claim-dispute";
import { submitFreeClaimForUser as _submitFreeClaim } from "@/src/modules/pets/application/claim/submit-free-claim";
import type { ClaimDisputeInput } from "@/src/modules/pets/application/claim/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  ClaimLookupVariant,
  ClaimLookupResult,
  ClaimDisputeInput,
  ClaimDisputeResult,
  FreeClaimResult,
} from "@/src/modules/pets/application/claim/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function lookupForClaimAction(input: {
  kind: "microchip" | "tattoo";
  value: string;
}) {
  const { user } = await requireUserOrRedirect();
  return _lookupForClaim(user.id, input);
}

export async function submitClaimDisputeAction(input: ClaimDisputeInput, files: File[]) {
  const { user } = await requireUserOrRedirect();
  const result = await _submitClaimDispute(user.id, input, files);
  if (!("error" in result)) {
    // The pet token is derived server-side from the verified identifier — never
    // trusted from the caller — so revalidate using the resolved token (same
    // rule as submitFreeClaimAction below).
    revalidatePath(`/mis-mascotas/${result.petToken}`);
  }
  return result;
}

export async function submitFreeClaimAction(input: {
  identifierKind: "microchip" | "tattoo";
  identifierValue: string;
}) {
  const { user } = await requireUserOrRedirect();
  const result = await _submitFreeClaim(user.id, input);
  if (!("error" in result)) {
    revalidatePath("/mis-mascotas");
    // The pet token is derived server-side from the verified identifier — never
    // trusted from the caller — so revalidate using the resolved token.
    revalidatePath(`/mis-mascotas/${result.petToken}`);
  }
  return result;
}
