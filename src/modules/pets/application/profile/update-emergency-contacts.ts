// Use-case: updateEmergencyContactsForPet — narrow write for the pet profile's
// `?sheet=emergencia` (owner-ia-redesign P2, PO decision 2).
//
// Emergency contacts became "per-pet override + account default": this sheet
// now writes the PET-LEVEL columns (pets.preferred_vet_* / emergency_contact_*,
// migration 0145), NOT the account-level profiles columns. The account default
// is still edited from /cuenta (updateProfileForUser). When a pet column is
// cleared (empty string → null) the profile-level value is shown as the
// fallback (see lib/domain/emergency-contacts.ts).
//
// SECURITY: the write is scoped to a pet the caller currently OWNS. `db`
// bypasses RLS (service role), so ownership is verified in-query here — the
// same pattern update-profile.ts uses for the per-user profile row.
//
// These 4 columns are UI preferences (like emergency_info_visible /
// disclose_*_when_lost) — editing them does NOT emit a pet event, so this
// deliberately does not go through the event-emitting updatePet path.

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { db, ownerships, pets } from "@/db";

import type { UpdateProfileResult } from "./types";

export type UpdateEmergencyContactsInput = {
  preferredVetName?: string;
  preferredVetPhone?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
};

// Same nullable-string semantics as update-profile: names ≤ 80, phones ≤ 40;
// an empty string clears the override (→ null → account fallback). Phone
// format is a soft client-side warning, never a server error.
const nameField = z.string().max(80, "Máximo 80 caracteres").optional();
const phoneField = z.string().max(40, "Máximo 40 caracteres").optional();
const inputSchema = z.object({
  preferredVetName: nameField,
  preferredVetPhone: phoneField,
  emergencyContactName: nameField,
  emergencyContactPhone: phoneField,
});

/** "" (or whitespace) clears the override; a real value overrides. */
function toColumn(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function updateEmergencyContactsForPet(
  userId: string,
  petPublicToken: string,
  input: UpdateEmergencyContactsInput,
): Promise<UpdateProfileResult> {
  // 1. Validate
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return { error: `VALIDATION_ERROR: ${firstError.message}` };
  }

  // 2. Resolve the pet + verify current ownership (owner role, not ended).
  //    Single query so a non-owner (or a stale/ended ownership) can never
  //    write the pet's override columns.
  const [owned] = await db
    .select({ petId: pets.id })
    .from(pets)
    .innerJoin(
      ownerships,
      and(
        eq(ownerships.petId, pets.id),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .where(eq(pets.publicToken, petPublicToken))
    .limit(1);

  if (!owned) return { error: "NOT_FOUND" };

  // 3. Write the pet-level override columns. Empty inputs clear to null so the
  //    account default takes over on read.
  await db
    .update(pets)
    .set({
      preferredVetName: toColumn(parsed.data.preferredVetName),
      preferredVetPhone: toColumn(parsed.data.preferredVetPhone),
      emergencyContactName: toColumn(parsed.data.emergencyContactName),
      emergencyContactPhone: toColumn(parsed.data.emergencyContactPhone),
      updatedAt: new Date(),
    })
    .where(eq(pets.id, owned.petId));

  return { ok: true };
}
