"use server";

// booking.ts — thin shim (strangler migration 23/61).
//
// Business logic moved to:
//   src/modules/events/application/booking/
//
// This file re-exports all types and the pure writer (used by integration
// tests and form components) and provides thin Action wrappers (used by UI
// components) that add the auth guard + revalidatePath.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, ownerships, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { bookSlotWriter as _bookSlotWriter } from "@/src/modules/events/application/booking/book-slot";
import { cancelAppointmentByOwner as _cancelAppointmentByOwner } from "@/src/modules/events/application/booking/cancel-appointment-by-owner";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  BookSlotResult,
  CancelAppointmentResult,
} from "@/src/modules/events/application/booking/types";

// Bare writer is NOT re-exported here (impersonation triage, review 07).
// bookSlotWriter(slotId, petId, userId) takes a caller-supplied userId;
// exporting it from a "use server" file would let any client book slots as
// any user. It lives on in src/modules/events/application/booking/book-slot;
// integration tests import it from there, and bookSlotAction below derives
// the user from requireUserOrRedirect + an ownership check.

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function bookSlotAction(
  slotId: string,
  petId: string,
): Promise<Awaited<ReturnType<typeof _bookSlotWriter>>> {
  const { user } = await requireUserOrRedirect();

  // Verify the pet belongs to this user via an active ownership row, and read
  // its lifecycle status in the same trip.
  const [ownershipRow] = await db
    .select({ petId: ownerships.petId, petStatus: pets.status })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      // Art. 16 (Ley 25.326): an erased pet folds into the SAME "no te
      // pertenece" a never-owned petId gets — a guard here (reachable directly
      // by a surviving foster/co-owner), not a distinct error, so it is not an
      // existence oracle. Full rationale in the commit message.
      sql`${ownerships.ownerUserId} = ${user.id}
          AND ${ownerships.petId} = ${petId}
          AND ${ownerships.endedAt} IS NULL
          AND ${pets.deletedAt} IS NULL`,
    )
    .limit(1);

  if (!ownershipRow) {
    return { error: "Esta mascota no te pertenece." };
  }

  // The booking SELECTOR already hides deceased pets (Cowork QA v3, B2 —
  // reservar/[slotId]/page.tsx), but that filter is presentational: it only
  // shapes the options a fresh render offers. A tab opened before the death was
  // recorded, a Back-button return, or a hand-posted petId all reach this
  // action with a petId the selector would no longer show. Active tenencia is
  // not enough — the pet's state counts too, and it has to be checked HERE.
  if (ownershipRow.petStatus === "deceased") {
    return { error: "No se puede reservar un turno para una mascota fallecida." };
  }

  const result = await _bookSlotWriter(slotId, petId, user.id);
  if ("error" in result) return result;

  revalidatePath("/mis-turnos");
  // N3: return the destination, do not redirect() from the action. The App
  // Router drops that transition in production — the appointment IS booked and
  // the user is left staring at the form (lib/ui/full-page-action-nav.ts).
  return { ...result, redirectTo: `/mis-turnos/${result.appointmentToken}` };
}

export async function cancelAppointmentByOwnerAction(
  appointmentToken: string,
): Promise<Awaited<ReturnType<typeof _cancelAppointmentByOwner>>> {
  const { user } = await requireUserOrRedirect();

  const result = await _cancelAppointmentByOwner(appointmentToken, user.id);
  if ("error" in result) return result;

  revalidatePath("/mis-turnos");
  revalidatePath(`/mis-turnos/${appointmentToken}`);

  return { ok: true };
}
