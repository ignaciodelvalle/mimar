// "Ana registró el fallecimiento de Pampa."
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// `death_recorded` is deliberately NOT in `TITULAR_ONLY_EVENT_TYPES`. The spec
// allows a caretaker to write it, and that is right: the person holding the
// animal is the one who knows. It is also, by a distance, the most consequential
// thing they can record — it closes the life record, flips `pets.status`, and
// cascades into fosters, custody episodes and rabies observation.
//
// The spec attaches a condition to that permission: the titular is notified
// IMMEDIATELY. Not in a digest. Not on next login. This is that obligation, and
// it is the reason the exclusion in lib/domain/titular-only.ts is safe.
//
// WHY IT LIVES IN lib/infra AND NOT IN src/modules/caretakers
// ---------------------------------------------------------------------------
// The caller is `src/modules/events` (createDeathRecordAction). Putting the
// helper in the caretakers module would make `events` import `caretakers` — a
// new cross-module edge, pointing the wrong way, for a notification neither
// module owns. Same argument, same shelf and the same two neighbours as
// `pet-alert-recipients.ts` and `origin-shelter-alert.ts`: lib/infra is not a
// module, so nothing in the dependency fence moves.
//
// SCOPE, stated so the next person does not "generalise" it by accident: this
// covers exactly one caretaker action. It is NOT a feed of everything a
// caretaker does — a vaccine entry does not warrant an urgent push, and turning
// this into one would train owners to ignore the channel that carries this
// sentence.

import "server-only";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db, ownerships, profiles } from "@/db";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import type { PetAccessSuccess } from "@/lib/infra/pet-access";

/**
 * Roles that hold TITULARIDAD and must therefore hear this.
 *
 * `co_owner` is included because a co-owner is owner-equivalent everywhere else
 * in the product (it passes `requireTitularAccess` for exactly that reason);
 * telling one of two owners that their animal died is not "telling the owner".
 *
 * `foster` and `shelter_custody` are excluded: they are custody arrangements,
 * not titularidad, and a foster placement on a pet that also has a caretaker is
 * a shape this change does not need to invent a recipient rule for.
 */
const TITULAR_ROLES = ["owner", "co_owner"] as const;

export async function notifyTitularOfCaretakerDeath(input: {
  petId: string;
  petName: string;
  petPublicToken: string;
  caretakerUserId: string;
  /** The inserted `death_recorded` event id — the idempotency anchor. */
  eventId: string;
}): Promise<{ notified: string[] }> {
  const holders = await db
    .select({ userId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, input.petId),
        isNull(ownerships.endedAt),
        // An org-held row carries `owner_user_id = NULL` (the polymorphic
        // holder CHECK). There is nobody to write a notification row against,
        // and that is a legitimate outcome, not an error.
        isNotNull(ownerships.ownerUserId),
        inArray(ownerships.role, [...TITULAR_ROLES]),
      ),
    );

  const recipients = [
    ...new Set(
      holders
        .map((h) => h.userId)
        .filter((id): id is string => Boolean(id) && id !== input.caretakerUserId),
    ),
  ];
  if (recipients.length === 0) return { notified: [] };

  const [caretaker] = await db
    .select({ displayName: profiles.displayName, deletedAt: profiles.deletedAt })
    .from(profiles)
    .where(eq(profiles.id, input.caretakerUserId))
    .limit(1);
  // An erased profile keeps its row with a redacted display name; putting that
  // sentinel into this sentence would be worse than a neutral noun.
  const caretakerName = caretaker && !caretaker.deletedAt ? (caretaker.displayName ?? null) : null;
  const who = caretakerName ?? "Tu cuidador/a";

  await createNotificationsBulk(
    recipients.map((userId) => ({
      userId,
      notificationType: "caretaker_death_recorded",
      title: `${who} registró el fallecimiento de ${input.petName}`,
      body: "Revisá la libreta para ver los detalles que cargó.",
      severity: "urgent" as const,
      category: "mascota",
      ctaLabel: "Ver la libreta",
      ctaUrl: `/mis-mascotas/${input.petPublicToken}`,
      relatedPetId: input.petId,
      // Anchored on the EVENT, not the moment: the death writer is idempotent
      // (insertEventIdempotent), so a resubmitted form reaches the same event
      // id and this collapses with it. A grieving owner must not be told twice.
      dedupeKey: `caretaker-death:${input.eventId}:${userId}`,
    })),
  );

  return { notified: recipients };
}

/**
 * The call site's whole share of T9.13/T9.14 — gate, invocation and failure
 * policy in one place.
 *
 * WHY THE GATE LIVES HERE AND NOT IN THE ACTION. `src/modules/events/actions.ts`
 * is a 1800-line file already at its size fence, and the three conditions below
 * are not facts about recording a death — they are facts about the caretaker
 * arrangement. Keeping them next to the copy they guard means the next person
 * reading either one finds the other.
 *
 * The three conditions:
 *   - `holderRole === "caretaker"` — a TITULAR recording their own animal's
 *     death does not need to be told about it.
 *   - `insertedEventId` non-null — the death writer is idempotent, and a
 *     resubmit that inserted nothing is not a second death to announce.
 *   - the whole thing is swallowed (ARCH-P) — the record is already in the
 *     spine, and a failed notification must never make a successful write
 *     report as failed.
 */
export async function announceCaretakerDeathRecord(
  access: PetAccessSuccess,
  insertedEventId: string | null,
): Promise<void> {
  if (access.holderRole !== "caretaker" || !insertedEventId) return;
  try {
    await notifyTitularOfCaretakerDeath({
      petId: access.pet.id,
      petName: access.pet.name,
      petPublicToken: access.pet.publicToken,
      caretakerUserId: access.user.id,
      eventId: insertedEventId,
    });
  } catch (err) {
    console.error("[caretakers] death alert failed (the record did land)", err);
  }
}
