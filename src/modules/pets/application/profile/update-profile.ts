// update-profile.ts — updateProfileForUser use-case.
//
// Validates input, checks profile existence, computes before-values for the
// audit payload, then updates the profiles row and inserts the audit_log entry
// in ONE transaction (2026-08-16 — they used to be separate autocommits, so a
// crash in between could change a user's contact details with no trace).
// No notifications.

import { isWritableName } from "@dim/contract/input";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";

import { db, profiles } from "@/db";
import { writeAuditLog } from "@/lib/infra/audit-log";

import type { UpdateProfileResult } from "./types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

// Emergency / vet contact fields share the same nullable-string semantics
// as the main phone field. Names are free-form (1-80 chars) and clear
// to null when sent as empty string.
// Phone fields no longer enforce AR format server-side — the client form
// surfaces a soft warning via `lib/ar-phone.ts` instead. Older landlines,
// satellite phones, and foreign numbers all save without error.
const emergencyTextField = z.string().max(80, "Máximo 80 caracteres").optional();
const phoneField = z.string().max(40, "Máximo 40 caracteres").optional();

const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(80, "El nombre no puede superar 80 caracteres")
    .trim()
    // A2-alta-asentar-09. Two zero-width spaces are two characters, survive
    // `trim()` and render as nothing — so this schema's length floor passed a
    // display name that leaves the person blank on their own credential while
    // `isIdentityPending` reports them complete. The predicate is the contract's
    // (`@dim/contract/input`), not a second copy: signup step 2 already refuses
    // exactly this, and the two doors write the same column.
    .refine(isWritableName, "Escribí tu nombre con letras"),
  // phone semantics:
  //   undefined  → caller did not include phone in the update; leave DB value unchanged
  //   ""         → caller explicitly cleared phone; set to null in DB
  //   string     → store as-is (format hint shown client-side as warning, not error)
  phone: phoneField,
  // Emergency contact + preferred vet — surfaced on <PetEmergencyCard>. Same
  // undefined / "" / string semantics as `phone`. Added by migration 0042.
  preferredVetName: emergencyTextField,
  preferredVetPhone: phoneField,
  emergencyContactName: emergencyTextField,
  emergencyContactPhone: phoneField,
});

// ---------------------------------------------------------------------------
// Writer: updateProfileForUser
// ---------------------------------------------------------------------------

export async function updateProfileForUser(
  userId: string,
  input: {
    displayName: string;
    phone?: string;
    preferredVetName?: string;
    preferredVetPhone?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
  },
): Promise<UpdateProfileResult> {
  // 1. Validate
  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return { error: `VALIDATION_ERROR: ${firstError.message}` };
  }
  const {
    displayName,
    phone,
    preferredVetName,
    preferredVetPhone,
    emergencyContactName,
    emergencyContactPhone,
  } = parsed.data;

  // 2. Load current profile for before-values + existence check
  const [current] = await db
    .select({
      displayName: profiles.displayName,
      phone: profiles.phone,
      preferredVetName: profiles.preferredVetName,
      preferredVetPhone: profiles.preferredVetPhone,
      emergencyContactName: profiles.emergencyContactName,
      emergencyContactPhone: profiles.emergencyContactPhone,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  if (!current) return { error: "NOT_FOUND" };

  // 3. Build changed_fields + before/after values for the audit payload.
  // Both sides are accumulated at the same moment they are decided, so the
  // audit row can never claim a transition that the update did not perform.
  const changedFields: string[] = [];
  const beforeValues: Record<string, unknown> = {};
  const afterValues: Record<string, unknown> = {};

  if (displayName !== current.displayName) {
    changedFields.push("displayName");
    beforeValues.displayName = current.displayName;
    afterValues.displayName = displayName;
  }

  // phone: undefined → don't touch DB value.
  //        ""        → clear (set to null).
  //        string    → validate passed, store as-is.
  const phoneIsProvided = phone !== undefined;
  const newPhone = phoneIsProvided ? (phone === "" ? null : phone) : current.phone;
  if (newPhone !== current.phone) {
    changedFields.push("phone");
    beforeValues.phone = current.phone;
    afterValues.phone = newPhone;
  }

  // Same semantics for the 4 emergency / vet fields.
  type EmergencyKey =
    | "preferredVetName"
    | "preferredVetPhone"
    | "emergencyContactName"
    | "emergencyContactPhone";
  const emergencyInputs: Record<EmergencyKey, string | undefined> = {
    preferredVetName,
    preferredVetPhone,
    emergencyContactName,
    emergencyContactPhone,
  };
  const emergencyUpdates: Partial<Record<EmergencyKey, string | null>> = {};
  for (const [key, value] of Object.entries(emergencyInputs) as Array<
    [EmergencyKey, string | undefined]
  >) {
    if (value === undefined) continue;
    const next = value === "" ? null : value;
    if (next !== current[key]) {
      changedFields.push(key);
      beforeValues[key] = current[key];
      afterValues[key] = next;
      emergencyUpdates[key] = next;
    }
  }

  // 4. Update profiles
  const updateSet: Record<string, unknown> = {
    displayName,
    updatedAt: new Date(),
  };
  if (phoneIsProvided) {
    updateSet.phone = phone === "" ? null : phone;
  }
  Object.assign(updateSet, emergencyUpdates);

  // 4+5. Update profiles + audit — ONE transaction.
  await db.transaction(async (tx) => {
    await tx.update(profiles).set(updateSet).where(eq(profiles.id, userId));

    await writeAuditLog(tx, {
      action: "profile_self_updated",
      actorUserId: userId,
      targetUserId: userId,
      payload: { changed_fields: changedFields },
      // Lands at payload.before_values / payload.after_values — the same key
      // this call site had already invented by hand, now with its other half.
      before: beforeValues,
      after: afterValues,
    });
  });

  return { ok: true };
}
