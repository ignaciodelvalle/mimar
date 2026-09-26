// Full use-case body for the privileged govt pet lookup used by the decomiso form.
// Moved verbatim from app/actions/decomiso-pet-lookup.ts (strangler 40/61, 2026-06-30).
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §6.
//
// Used by DecomisoForm to confirm a pet's identity before executing a
// decomiso. Returns full name, species, sex, status, and whether the pet
// has an active owner (to trigger the DC2 double-confirm modal).
//
// Auth: requireDecomisoPrincipal is enforced by the caller (shim). This
// use-case receives the already-resolved session so it never re-fetches.
// Returns owner display name (not just initials) because the operator
// needs to know whose custody they're about to revoke.

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, pets, profiles } from "@/db";
import { DIM_TOKEN_PATTERN, normalizeDimTokenInput } from "@/lib/domain/dim-token";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import type { DecomisoPrincipalSession } from "@/lib/infra/auth-guards";

import type { GovtPetLookupResult } from "./types";

export async function lookupPetForDecomiso(
  session: DecomisoPrincipalSession,
  query: string,
): Promise<GovtPetLookupResult> {
  // ASCII-only case folding (lib/domain/dim-token.ts): Unicode `toUpperCase()`
  // turned lookalikes such as a dotless `ı` into a real token's letters.
  const trimmed = normalizeDimTokenInput(query);
  if (!trimmed) return { found: false, error: "Ingresá un token de mascota." };
  if (!DIM_TOKEN_PATTERN.test(trimmed)) {
    return { found: false, error: "El formato del token es DIM-XXXX-XXXX." };
  }

  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      sex: pets.sex,
      status: pets.status,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      localityId: pets.localityId,
    })
    .from(pets)
    .where(eq(pets.publicToken, trimmed))
    .limit(1);

  if (!pet) {
    return {
      found: false,
      error: `No se encontró ninguna mascota con el token ${trimmed}.`,
    };
  }

  // Jurisdiction scope check — mirrors executeDecomisoAction (review 24 HIGH #3).
  // Admin role has universal scope (session.jurisdictions is empty by design).
  // For govt, the pet's FULL (province, locality) pair must match one of the
  // user's assigned jurisdictions. A province-only check let a CABA-Palermo
  // operator read a CABA-other-locality owner's PII; a null-province allowance
  // let any govt read jurisdiction-less pets. Both are closed here: fail-closed
  // on any pair that isn't an exact assignment. If out of scope, return an
  // error WITHOUT exposing owner PII (ownerDisplayName / hasOwner).
  if (session.profile.role === "govt") {
    // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
    // every barrio in it; barrio-specific assignments stay exact (never widens).
    const inScope = jurisdictionScopeContains(
      session.jurisdictions,
      pet.jurisdictionProvince,
      pet.jurisdictionLocality,
      // The row's catalogue row: on the id path a unit grant compares rows
      // (localidades-por-id), so a homonym's record is out of scope.
      pet.localityId,
    );
    if (!inScope) {
      return {
        found: false,
        error: "Esta mascota no está en tu jurisdicción asignada.",
      };
    }
  }

  // Check for an active user-based 'owner' ownership.
  const [ownerRow] = await db
    .select({
      ownerUserId: ownerships.ownerUserId,
    })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
        isNull(ownerships.ownerOrganizationId),
      ),
    )
    .limit(1);

  let ownerDisplayName: string | null = null;
  if (ownerRow?.ownerUserId) {
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, ownerRow.ownerUserId))
      .limit(1);
    ownerDisplayName = profile?.displayName ?? null;
  }

  return {
    found: true,
    id: pet.id,
    publicToken: pet.publicToken,
    name: pet.name,
    species: pet.species,
    sex: pet.sex,
    status: pet.status,
    hasOwner: Boolean(ownerRow?.ownerUserId),
    ownerDisplayName,
  };
}
