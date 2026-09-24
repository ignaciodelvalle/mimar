// Stub-profile claim flow. When a refugio finalizes an adoption to a person
// who isn't yet a DIM user, app/actions/adoption.ts creates a `stub profile`
// (no auth.users link) keyed on DNI. The stub holds the new `owner` ownership
// row so the pet's chain of custody stays consistent.
//
// This action lets the real user, after signing up via Supabase Auth, claim
// the stub by DNI: ownership rows transfer from stub.id → real.id, the stub
// row is deleted, and the user's profile takes the DNI. The immutable
// adoption_finalized payload keeps the stub uuid for historical accuracy.
//
// SECURITY GATE (review 2026-05-19 §2.1): DNI is public information in
// Argentina (printed on national ID cards, 8-digit space). Until DNI
// verification through Mi Argentina OAuth ships, anyone who knows another
// person's DNI could claim that stub and inherit their pet ownerships /
// medical records. The action is therefore disabled at the top: it returns
// an explanatory error immediately. The downstream tx / merge logic is kept
// in place because re-enabling once Mi Argentina lands should be a one-line
// revert. ClaimForm.tsx renders a "paused" notice instead of the input
// form so users see the explanation before reaching the server action.

import { db, notifications, ownerships, petEvents, profiles, reminders } from "@/db";
import { matchesDbError } from "@/lib/infra/db-errors";
import { createClient } from "@/lib/supabase/server";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import { pluralizeEs } from "@/lib/utils/format";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import type { ClaimFormState } from "./types";

// SECURITY GATE (review 2026-05-19 §2.1): flip to `true` once Mi Argentina
// identity verification lands. Until then the action returns early with an
// explanatory error; ClaimForm.tsx renders a "paused" notice in parallel.
// The flag is typed as `boolean` (not the literal `false`) so the rest of
// the function stays reachable for typecheck purposes.
const STUB_CLAIM_ENABLED: boolean = false;

// Mirrors app/actions/adoption.ts → CHECKIN_WINDOWS_MONTHS. Kept inline
// (rather than extracted) because this is the only second use site; if a
// third arrives, lift both to lib/post-adoption-checkin.ts.
const CHECKIN_WINDOWS_MONTHS = [1, 3, 6, 12] as const;

function addMonths(base: Date, months: number): Date {
  const result = new Date(base);
  result.setMonth(result.getMonth() + months);
  return result;
}

function normalizeDni(input: string): string {
  return input.replace(/\D/g, "");
}

function isValidDni(value: string): boolean {
  return /^\d{7,9}$/.test(value);
}

export async function claimStubProfile(
  _previous: ClaimFormState,
  formData: FormData,
): Promise<ClaimFormState> {
  // SECURITY GATE — see STUB_CLAIM_ENABLED and file header.
  if (!STUB_CLAIM_ENABLED) {
    return {
      error:
        "El reclamo por DNI está temporalmente pausado mientras integramos la verificación de identidad con Mi Argentina. Si tu refugio te avisó que registró tu adopción, escribinos a soporte y te ayudamos a vincular el perfil manualmente.",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  const dniRaw = String(formData.get("dni") ?? "");
  const dni = normalizeDni(dniRaw);
  if (!dni) return { error: "Falta el DNI." };
  if (!isValidDni(dni)) return { error: "DNI inválido (7 a 9 dígitos)." };

  // The current user's own profile (created by the handle_new_user trigger
  // at signup). Verify it doesn't already have a different DNI — claiming
  // overwrites a null DNI but never overrides an existing one.
  // No DNI in plaintext (Wave 5 Item 25a): we compare and store via hash.
  const dniHashValue = hashDni(dni);
  const dniLast4Value = dniLast4(dni);

  const [currentProfile] = await db
    .select({ id: profiles.id, dniHash: profiles.dniHash })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);
  if (!currentProfile) {
    return {
      error: "No encontramos tu perfil miMAR. Volvé a iniciar sesión.",
    };
  }
  if (currentProfile.dniHash && currentProfile.dniHash !== dniHashValue) {
    return {
      error: "Tu perfil ya tiene un DNI distinto registrado. Contactá soporte si es un error.",
    };
  }

  // The stub: a profile with the same dni_hash that's NOT the current user.
  // The partial-unique index `profiles_dni_hash_unique` guarantees at most one match.
  const [stub] = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(and(eq(profiles.dniHash, dniHashValue), ne(profiles.id, user.id)))
    .limit(1);

  if (!stub) {
    // No stub found. If the user's own profile already has the DNI hash, this is
    // a no-op success. Otherwise it's a genuine miss — no refugio has staged
    // an adoption for them.
    if (currentProfile.dniHash === dniHashValue) {
      return { error: null };
    }
    // Set the DNI hash + last4 on the user's profile — first-time identity binding.
    // Harmless if they're not awaiting a refugio.
    try {
      await db
        .update(profiles)
        .set({ dniHash: dniHashValue, dniLast4: dniLast4Value, dniVerified: false })
        .where(eq(profiles.id, user.id));
    } catch (err) {
      // drizzle 0.45 wraps pg errors; matchesDbError walks the `.cause` chain to
      // the real constraint name (no longer on the top-level message).
      if (matchesDbError(err, { constraint: /profiles_dni_hash_unique/ })) {
        return { error: "Ese DNI ya está en uso por otro perfil." };
      }
      const message = err instanceof Error ? err.message : "Error desconocido.";
      return { error: `No se pudo guardar el DNI: ${message}` };
    }
    return { error: null };
  }

  // Atomic merge. Order matters:
  //   1. Move ownership rows off the stub onto the real user.
  //   2. Delete the stub profile.
  //   3. Set the DNI on the real user's profile.
  // The partial-unique DNI index allows (2) and (3) to happen in the same
  // transaction because by the time (3) commits, the stub no longer exists.
  let ownershipsMoved = 0;
  let remindersBackfilled = 0;
  try {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(ownerships)
        .set({ ownerUserId: user.id })
        .where(and(eq(ownerships.ownerUserId, stub.id), isNull(ownerships.endedAt)))
        .returning({ id: ownerships.id });
      ownershipsMoved = moved.length;

      // Backfill post-adoption reminders that adoption.ts skipped at
      // finalize time because the adopter was a stub (no auth.users row
      // for reminders.userId to reference). Now that auth.users exists,
      // any window still in the future is fair game. Past-window
      // reminders are deliberately NOT created — emitting a cron
      // notification for a missed window the user couldn't have hit is
      // worse UX than silently dropping it.
      const now = new Date();
      const adoptions = await tx
        .select({
          eventId: petEvents.id,
          petId: petEvents.petId,
          occurredAt: petEvents.occurredAt,
          payload: petEvents.payload,
        })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.eventType, "adoption_finalized"),
            sql`${petEvents.payload}->>'adopter_user_id' = ${stub.id}`,
          ),
        );

      const reminderRows: Array<typeof reminders.$inferInsert> = [];
      for (const adoption of adoptions) {
        const payload = adoption.payload as {
          post_adoption_followup_months?: number | null;
          previous_owner_organization_id?: string | null;
        };
        const followupMonths = payload.post_adoption_followup_months;
        if (followupMonths === null || followupMonths === undefined || followupMonths <= 0)
          continue;
        for (const m of CHECKIN_WINDOWS_MONTHS) {
          if (m > followupMonths) continue;
          const dueAt = addMonths(new Date(adoption.occurredAt), m);
          if (dueAt.getTime() <= now.getTime()) continue;
          reminderRows.push({
            petId: adoption.petId,
            userId: user.id,
            reminderType: "post_adoption_checkin",
            dueAt,
            title: `Seguimiento post-adopción a los ${m} ${m === 1 ? "mes" : "meses"}`,
            description:
              "Tu refugio pidió un check-in. Subí fotos y contales cómo está tu mascota.",
            sourceEventId: adoption.eventId,
          });
        }
      }
      if (reminderRows.length > 0) {
        await tx.insert(reminders).values(reminderRows);
        remindersBackfilled = reminderRows.length;
      }

      await tx.delete(profiles).where(eq(profiles.id, stub.id));

      await tx
        .update(profiles)
        .set({ dniHash: dniHashValue, dniLast4: dniLast4Value, dniVerified: false })
        .where(eq(profiles.id, user.id));

      const bodyParts: string[] = [];
      if (ownershipsMoved === 0) {
        bodyParts.push("Vinculamos tu DNI a tu cuenta. No encontramos mascotas pendientes.");
      } else {
        bodyParts.push(
          `Tu perfil quedó vinculado a tu DNI y ${ownershipsMoved} ${pluralizeEs(
            ownershipsMoved,
            "mascota",
          )} ahora figura${ownershipsMoved === 1 ? "" : "n"} en tu libreta.`,
        );
      }
      if (remindersBackfilled > 0) {
        bodyParts.push(
          `Programamos ${remindersBackfilled} ${pluralizeEs(
            remindersBackfilled,
            "recordatorio",
          )} de seguimiento post-adopción.`,
        );
      }
      await tx.insert(notifications).values({
        userId: user.id,
        notificationType: "stub_profile_claimed",
        title: "Reclamaste tu perfil de adopción",
        body: bodyParts.join(" "),
        severity: "success",
        ctaLabel: "Ver mis mascotas",
        ctaUrl: "/mis-mascotas",
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return { error: `No se pudo reclamar el perfil: ${message}` };
  }

  redirect(`/mis-mascotas?reclamado=${ownershipsMoved}`);
}
