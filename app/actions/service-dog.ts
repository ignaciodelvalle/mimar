"use server";

// service-dog.ts — thin shim (strangler migration 14/61).
//
// Business logic moved to:
//   src/modules/pets/application/service-dog/
//
// This file re-exports all exported types and provides thin Action wrappers
// (used by UI components) that add the auth guard.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import type { ServiceDogVisibility } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { retireServiceDog } from "@/src/modules/pets/application/service-dog/retire-service-dog";
import { revokeServiceDogCredential } from "@/src/modules/pets/application/service-dog/revoke-service-dog-credential";
import { setServiceDogVisibility } from "@/src/modules/pets/application/service-dog/set-service-dog-visibility";
import { submitServiceDogVerificationRequest } from "@/src/modules/pets/application/service-dog/submit-verification-request";
import type {
  RevokeServiceDogInput,
  SubmitVerificationInput,
  SubmitVerificationResult,
  UpsertServiceDogInput,
  UpsertServiceDogResult,
} from "@/src/modules/pets/application/service-dog/types";
import { upsertServiceDog } from "@/src/modules/pets/application/service-dog/upsert-service-dog";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  RevokeServiceDogInput,
  SubmitVerificationInput,
  SubmitVerificationResult,
  UpsertServiceDogInput,
  UpsertServiceDogResult,
};

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function upsertServiceDogAction(
  input: UpsertServiceDogInput,
): Promise<UpsertServiceDogResult> {
  const { user } = await requireUserOrRedirect();
  return upsertServiceDog(user.id, input);
}

export async function submitServiceDogVerificationRequestAction(
  input: SubmitVerificationInput,
): Promise<SubmitVerificationResult> {
  const { user } = await requireUserOrRedirect();
  return submitServiceDogVerificationRequest(user.id, input);
}

export async function setServiceDogVisibilityAction(input: {
  petPublicToken: string;
  publicVisibility: ServiceDogVisibility;
}): Promise<{ ok: true } | { error: string }> {
  const { user } = await requireUserOrRedirect();
  return setServiceDogVisibility(user.id, input);
}

export async function retireServiceDogAction(input: {
  petPublicToken: string;
}): Promise<{ ok: true } | { error: string }> {
  const { user } = await requireUserOrRedirect();
  return retireServiceDog(user.id, input);
}

export async function revokeServiceDogCredentialAction(
  input: RevokeServiceDogInput,
): Promise<{ ok: true } | { error: string }> {
  const { user } = await requireUserOrRedirect();
  const result = await revokeServiceDogCredential(user.id, input);
  if ("ok" in result) {
    // Drop the revoked credential from the Directorio hub's "credenciales"
    // tab (F3+F7 fusion, 2026-07-22 — formerly /gob/rupga) via server-side
    // revalidate, mirroring the org/vet revocation shims, rather than a
    // client router.refresh() — keeps the nav-pattern fence green.
    //
    // BOTH paths, not just /gob (RA-2 F13): app/admin/directorio/page.tsx is a
    // re-export of app/gob/directorio/page.tsx, but revalidatePath is keyed on
    // the ROUTE PATH, not on the module. Revalidating only /gob left an admin
    // who revoked from /admin/directorio looking at a cached "Vigente" pill
    // directly above the "Credencial revocada" they had just produced.
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/directorio");
  }
  return result;
}
