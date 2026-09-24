// Thin compatibility wrapper around `requirePetAccess` for server components
// that previously used the owner-only helper. The new helper accepts both the
// direct-owner path and the org-mediated path; the return shape stays compact
// for back-compat with existing page-side callers.

import { notFound, redirect } from "next/navigation";

import { requirePetAccess } from "@/lib/infra/pet-access";

// Returns the access record on success. On session expiry, redirects to
// /login; on missing-pet / out-of-scope-pet, calls notFound(). Both throw
// `never`, so the return type is non-nullable and callers do not need a
// follow-up null check.
export async function requireOwnedPetByToken(publicToken: string) {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) {
    if (access.error === "Sesión expirada.") redirect("/iniciar-sesion");
    notFound();
  }
  return {
    user: access.user,
    pet: access.pet,
    accessPath: access.accessPath,
    organization: access.organization,
  };
}
