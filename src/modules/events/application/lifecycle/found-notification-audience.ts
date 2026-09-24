// WHO HEARS THAT THE ANIMAL CAME HOME.
//
// Two reads, extracted from `setPetFoundAction` when `POST /api/v1/pets/{token}/
// lost` needed the same pair. NOT a tidy-up: the first of them carries a bug
// that was live for months and a comment explaining why the fix is right HERE
// and wrong two files over, and a second door that re-typed the query would have
// re-typed the bug. One copy is the whole point.
//
// Neither of these is a guard. The caller has already resolved access; these
// answer "who gets told", and being wrong about that produces a notification
// nobody reads rather than a permission nobody had.

import { and, asc, eq, isNull } from "drizzle-orm";

import { db, notifications, ownerships } from "@/db";

/**
 * The active TITULAR's user id, so a recovery confirmation reaches the human
 * owner even when an org member pressed the button. Falls back to the acting
 * user when no owner-user row exists (an org-owned pet).
 *
 * `role = 'owner'` IS LOAD-BEARING and was missing until 2026-08-23. This is the
 * seventh instance of the `(pet_id, ended_at IS NULL)` + `limit(1)` pattern, and
 * the sweep before it (afd01fb3c) declared the corpus bounded without having
 * seen this one. An accepted caretaker grant opens a SECOND active `ownerships`
 * row, so heap order decided who got the confirmation: the titular marks their
 * own pet found, "Marcaste a Luna como encontrada" lands on the caretaker's
 * phone, and the titular — who pressed the button — is never told, then gets
 * re-notified through the broadcast branch as if they were a stranger who had
 * been looking.
 *
 * A FILTER IS RIGHT HERE AND WAS WRONG IN THE SIGHTING FLOW, and the difference
 * is worth naming so the next reader does not copy the wrong half.
 * `lib/infra/pet-alert-recipients.ts` refuses a role filter because THERE the
 * read is a hard gate and an empty result cancels the whole action for a pet in
 * shelter custody. Here the `?? actingUserId` fallback absorbs an empty result —
 * a pet with no owner-user row confirms to whoever pressed the button, which is
 * the behaviour that fallback was written for. And the ranking helper would be
 * actively wrong: it returns a RECIPIENT SET including concurrent caretakers,
 * whereas this is a single IDENTITY used twice — as the addressee of a
 * second-person confirmation ("Marcaste…", which only the actor's titular can be
 * told) and as the `userId === ownerUserId` key that suppresses the duplicate
 * broadcast notice. A set has no answer to either question.
 */
export async function resolveFoundConfirmationRecipient(
  petId: string,
  actingUserId: string,
): Promise<string> {
  const [ownerRow] = await db
    .select({ ownerUserId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .orderBy(asc(ownerships.startedAt))
    .limit(1);
  return ownerRow?.ownerUserId ?? actingUserId;
}

/**
 * The audience of the ORIGINAL `lost_pet_broadcast` for this pet, so the
 * resolution notice reaches exactly the people who were asked to look.
 *
 * Resolved from the notification ROWS rather than by re-running the broadcast's
 * own jurisdiction fan-out: the audience is whoever was actually reached, which
 * is a fact in the table, and re-deriving it would silently disagree the day the
 * fan-out rule changes — telling a new set of people the search is over and
 * leaving the old set still looking.
 */
export async function findBroadcastRecipientUserIds(petId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.notificationType, "lost_pet_broadcast"),
        eq(notifications.relatedPetId, petId),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => Boolean(id));
}
