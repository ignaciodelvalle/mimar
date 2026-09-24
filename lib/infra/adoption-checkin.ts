// Shared adoption gate for the post-adoption check-in surfaces (QA A9).
//
// The check-in page (eventos/nuevo/checkin/page.tsx) 404s unless the pet's
// LATEST adoption_finalized event names the current user as the adopter.
// The anotar capture catalog (ALL_CAPTURE_OPTIONS) used to list the
// "Check-in post-adopción" entry unconditionally, sending every non-adopter
// straight into that 404. Both surfaces now share this single predicate:
// the server-side option assembly includes the entry only when it passes,
// and the page keeps running it as its defense-in-depth gate.
//
// TWO MORE READERS SINCE 2026-09-09, and they are the reason the lookup is a
// function of its own rather than folded into the predicate: the check-in
// use-case needs the adoption's ORGANIZATION as well as its adopter (the
// refugio the check-in is addressed to), and `POST /api/v1/pets/{token}/events`
// resolves the "is there a window open" fact for the app's picker. One query
// for "who adopted this animal, and from whom" is what keeps the page, the
// menu, the writer and the endpoint agreeing about which adoption counts —
// latest-event-wins, on every door.

import { db, petEvents, reminders } from "@/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

/** The executor a caller may hand in to read inside its own transaction. */
type DbExecutor = Pick<typeof db, "select">;

export type LatestAdoption = {
  adopterUserId: string | null;
  /** The refugio that finalized it. Null only on a malformed payload. */
  organizationId: string | null;
};

/**
 * The pet's most recent `adoption_finalized` event, or null when the animal
 * was never adopted through the platform.
 *
 * LATEST-EVENT-WINS: a re-adoption to a different family revokes the old
 * adopter's check-in surface, on every door that asks this question.
 */
export async function findLatestAdoption(petId: string): Promise<LatestAdoption | null> {
  const [adoption] = await db
    .select({ payload: petEvents.payload })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);
  if (!adoption) return null;
  const payload = adoption.payload as {
    adopter_user_id?: string;
    previous_owner_organization_id?: string;
  };
  return {
    adopterUserId: payload.adopter_user_id ?? null,
    organizationId: payload.previous_owner_organization_id ?? null,
  };
}

/**
 * True when the pet's most recent adoption_finalized event names `userId`
 * as the adopter — the same query + payload check the check-in page enforces.
 */
export async function isPetAdoptedByUser(petId: string, userId: string): Promise<boolean> {
  const adoption = await findLatestAdoption(petId);
  return adoption !== null && adoption.adopterUserId === userId;
}

/**
 * The SOONEST open post-adoption check-in window for this pet and adopter, or
 * null when none is pending.
 *
 * ONE QUERY FOR THREE READERS. The page gates its form on it ("Sin check-ins
 * pendientes" otherwise), the use-case refuses a check-in nobody asked for on
 * it, and the write closes exactly this row — so all three have to agree about
 * which row that is: the soonest by `due_at`, not completed. Later windows stay
 * open; the adopter self-reports again at each milestone.
 *
 * `executor` lets the writer read it INSIDE its transaction, where the row it
 * is about to close must be the row it just looked at.
 */
export async function findOpenPostAdoptionCheckinReminder(
  petId: string,
  userId: string,
  executor: DbExecutor = db,
): Promise<{ id: string; dueAt: Date } | null> {
  const [next] = await executor
    .select({ id: reminders.id, dueAt: reminders.dueAt })
    .from(reminders)
    .where(
      and(
        eq(reminders.petId, petId),
        eq(reminders.userId, userId),
        eq(reminders.reminderType, "post_adoption_checkin"),
        isNull(reminders.completedAt),
      ),
    )
    .orderBy(asc(reminders.dueAt))
    .limit(1);
  return next ?? null;
}
