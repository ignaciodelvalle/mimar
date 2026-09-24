// Use-case: lookupForClaimForUser
//
// Distinct from lookupPetForDenunciaAction — claim needs to distinguish
// "free / active / lost / deceased" so the wizard can route to the right
// step. Returns ONLY a minimal projection; never the full pet record.
//
// A pet is "free" (directly claimable) only when it has NO active custody of
// ANY role — owner, shelter_custody, foster, etc. A refugio's pet without an
// owner-role row must NOT be direct-claimable (adoption/dispute is the path).

import { and, eq, isNull } from "drizzle-orm";

import { db, ownerships, petIdentifications, pets, profiles } from "@/db";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";

import type { ClaimLookupResult } from "./types";

const MICROCHIP_PATTERN = /^\d{15}$/;

async function hasAnyActiveCustody(petId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)))
    .limit(1);
  return !!row;
}

function deriveInitials(displayName: string | null): string | null {
  if (!displayName) return null;
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .slice(0, 2)
    .map((p) => `${p[0]?.toUpperCase() ?? ""}.`)
    .join("");
}

export async function lookupForClaimForUser(
  userId: string,
  input: { kind: "microchip" | "tattoo"; value: string },
): Promise<ClaimLookupResult> {
  const value = input.value.trim();
  if (!value) return { variant: "not_found" };

  try {
    await enforceRateLimit("claim_lookup", userId, { maxPerMinute: 30, maxPerHour: 200 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { error: "Demasiados intentos. Probá en unos minutos.", code: "rate_limited" };
    }
    throw err;
  }

  if (input.kind === "microchip") {
    if (!MICROCHIP_PATTERN.test(value)) {
      return {
        error: "El microchip debe tener exactamente 15 dígitos.",
        code: "identifier_invalid",
      };
    }
    const result = await lookupByChip(value);
    if (!result) return { variant: "not_found" };

    if (result.pet.status === "deceased") {
      return { variant: "deceased", petName: result.pet.name };
    }
    if (result.pet.status === "lost") {
      return { variant: "lost", petToken: result.pet.publicToken, petName: result.pet.name };
    }
    if (result.pet.ownerUserId === null && !(await hasAnyActiveCustody(result.pet.id))) {
      return { variant: "free", petToken: result.pet.publicToken, petName: result.pet.name };
    }
    return {
      variant: "active_owner",
      petToken: result.pet.publicToken,
      petName: result.pet.name,
      ownerInitials: deriveInitials(result.ownerFirstName),
    };
  }

  // Tattoo path — look up via the canonical pet_identifications table
  // (kind='tattoo', status='active'). Migration 0082 ensures completeness.
  const [row] = await db
    .select({
      petId: pets.id,
      petToken: pets.publicToken,
      petName: pets.name,
      petStatus: pets.status,
      ownerUserId: ownerships.ownerUserId,
      ownerDisplayName: profiles.displayName,
    })
    .from(petIdentifications)
    // Art. 16 (PO-4): an erased pet's tattoo answers `not_found`, same as the
    // chip path (whose filter lives inside lookupByChip). "Erased" must not be
    // distinguishable from "never existed" — before this filter the claim
    // wizard returned a named card for an erased pet in every variant.
    .innerJoin(pets, and(eq(pets.id, petIdentifications.petId), isNull(pets.deletedAt)))
    .leftJoin(
      ownerships,
      and(eq(ownerships.petId, pets.id), isNull(ownerships.endedAt), eq(ownerships.role, "owner")),
    )
    .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(
        eq(petIdentifications.kind, "tattoo"),
        eq(petIdentifications.code, value),
        eq(petIdentifications.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return { variant: "not_found" };
  if (row.petStatus === "deceased") {
    return { variant: "deceased", petName: row.petName };
  }
  if (row.petStatus === "lost") {
    return { variant: "lost", petToken: row.petToken, petName: row.petName };
  }
  if (row.ownerUserId === null && !(await hasAnyActiveCustody(row.petId))) {
    return { variant: "free", petToken: row.petToken, petName: row.petName };
  }
  return {
    variant: "active_owner",
    petToken: row.petToken,
    petName: row.petName,
    ownerInitials: deriveInitials(row.ownerDisplayName),
  };
}
