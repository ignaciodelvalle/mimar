"use server";

// admin-org-verification.ts — thin shim (strangler migration 22/61).
//
// Business logic moved to:
//   src/modules/organizations/application/admin-org-verification/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The ForAuthority writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied actorUserId would let any client act as any authority.
// Callers import the writers from
// src/modules/organizations/application/admin-org-verification/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { verifyOrgForAuthority as _verifyOrg } from "@/src/modules/organizations/application/admin-org-verification/verify-org";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { VerifyOrgResult } from "@/src/modules/organizations/application/admin-org-verification/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function verifyOrgAction(input: { organizationId: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await _verifyOrg(user.id, input);
  if ("ok" in result) {
    // Organizaciones is a dual-portal surface (portal-follows-viewer,
    // 2026-07-02): F3+F7 fusion (2026-07-22) made it the Directorio hub's
    // "organizaciones" tab in BOTH portals — revalidate both hub routes.
    revalidatePath("/gob/directorio");
    revalidatePath("/admin/directorio");
  }
  return result;
}

// `unverifyOrgAction` was REMOVED on 2026-08-17. It wrapped
// `unverifyOrgForAuthority` with `reason?: string` — optional — so an omitted
// reason produced an audit_log payload with no `reason` key at all.
//
// It had no UI: `UnverifyOrgButton` was deleted as dead code and the note in
// components/VerifyOrgButton.tsx says the action was "kept for future
// surfaces". But every export of a "use server" file is an independently
// addressable endpoint — this file's own header says so — so "no UI" never
// meant "unreachable". Any admin session could strip an organization of its
// verification over the network and leave a record that answers WHO and WHEN
// and not WHY, while the formal path
// (`revokeOrgVerificationForAuthority`) demands a 30-character motivo plus
// evidence for the same act. Two doors to one effect, and the unguarded one
// was the one nobody could see.
//
// The use case itself stays — it is not network-addressable and its tests
// document the behaviour. A future surface that needs it must add its own
// guarded wrapper, and decide then whether a reason is optional.
