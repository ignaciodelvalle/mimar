"use server";

// tier2-public.ts — thin shim (strangler migration 50/61).
//
// Business logic moved to:
//   src/modules/pets/application/tier2-public/
//
// This file re-exports thin delegating wrappers with identical signatures so
// all UI importers and the parity test keep working unchanged.

import { requireTitularAccess } from "@/lib/infra/pet-access";
import { enableTier2Public } from "@/src/modules/pets/application/tier2-public/enable-tier2-public";
import { revokeTier2Public } from "@/src/modules/pets/application/tier2-public/revoke-tier2-public";

export async function enableTier2PublicAction(
  publicToken: string,
  formData?: FormData,
): Promise<void> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) throw new Error(access.error);
  return enableTier2Public(access.pet, publicToken, formData);
}

export async function revokeTier2PublicAction(publicToken: string): Promise<void> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) throw new Error(access.error);
  return revokeTier2Public(access.pet, publicToken);
}
