"use server";

// chip-match.ts — thin shim (strangler migration 21/61).
//
// Business logic moved to:
//   src/modules/pets/application/chip-match/
//
// confirmChipMatchAction (the auth dispatcher / controller) is kept inline here
// because it IS the controller layer — it owns auth guards and routes to the
// appropriate writer based on actorMode.
//
// Both writers and the result type are re-exported with identical signatures so
// the 2 UI importers and the integration test keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireOrgAccessByToken, requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { confirmChipMatchAsRefugioWriter as _confirmChipMatchAsRefugioWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-refugio";
import { confirmChipMatchAsVecinoWriter as _confirmChipMatchAsVecinoWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-vecino";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { ConfirmChipMatchResult } from "@/src/modules/pets/application/chip-match/types";

// ---------------------------------------------------------------------------
// Action — thin controller: auth + routing only, no business logic
// ---------------------------------------------------------------------------

export async function confirmChipMatchAction({
  matchedPetToken,
  actorMode,
  orgToken,
  claim,
  attemptedMicrochipId,
  decision,
  notes,
}: {
  matchedPetToken: string;
  actorMode: "refugio" | "vecino";
  orgToken?: string;
  claim?: string;
  /**
   * Vecino mode only: the code the actor typed into the alta. It is that
   * mode's actor↔pet binding — the counterpart of `claim` in refugio mode,
   * which has an org identity to sign against and a vecino does not.
   */
  attemptedMicrochipId?: string;
  decision: "same" | "not_same";
  notes?: string;
}) {
  // ---------------------------------------------------------------------------
  // Auth validation
  // ---------------------------------------------------------------------------

  if (actorMode === "refugio") {
    if (!orgToken) {
      return { error: "orgToken requerido para actorMode='refugio'." };
    }
    // Resolve the org from the URL token FIRST (review 24 HIGH #7 / MED #11):
    // requireCapability("intake.create") alone resolves the session's default
    // (last-joined) membership, so a multi-org user could confirm a match as
    // the wrong org. Pin the capability check to the org named in the URL.
    const orgAccess = await requireOrgAccessByToken(orgToken);
    const auth = await requireCapability("intake.create", orgAccess.organization.id);
    if (auth.error !== null) return { error: auth.error };
    return _confirmChipMatchAsRefugioWriter({
      auth,
      orgToken,
      claim,
      matchedPetToken,
      decision,
      notes,
    });
  }

  if (actorMode === "vecino") {
    // A live session is ALL this branch used to require, and self-signup is
    // free — see the authorization note in confirm-chip-match-vecino.ts. The
    // writer refuses without a matching attemptedMicrochipId; passing it
    // through unvalidated is deliberate, the comparison belongs next to the
    // canonical row.
    const session = await requireUserOrRedirect();
    return _confirmChipMatchAsVecinoWriter({
      userId: session.user.id,
      matchedPetToken,
      attemptedMicrochipId: attemptedMicrochipId ?? "",
      decision,
      notes,
    });
  }

  return { error: "actorMode inválido. Debe ser 'refugio' o 'vecino'." };
}

// Bare writers are NOT re-exported here (impersonation triage, review 07).
// confirmChipMatchAsRefugioWriter takes a caller-supplied `auth`, and
// confirmChipMatchAsVecinoWriter a caller-supplied `userId`; exporting them
// from a "use server" file would let any client confirm matches as any
// org/user. They live on in src/modules/pets/application/chip-match/*;
// integration tests import them from there, and the guarded
// confirmChipMatchAction above derives identity from the session/capability.
