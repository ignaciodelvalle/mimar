// Who hears "somebody found your pet", resolved ONCE.
//
// WHY IT LIVES HERE AND NOT IN src/modules/caretakers
// ---------------------------------------------------------------------------
// Its sibling in this directory, origin-shelter-alert.ts, was extracted for the
// same reason and says so: the predicate has to be readable by the surfaces
// that PROMISE it, not only by the one that fires it. The caretaker-facing copy
// ("mientras dure el cuidado vas a recibir los avisos de hallazgo") is a promise,
// and a promise kept in a second copy of the rule drifts.
//
// Putting it inside the caretakers module would force every caller —
// app/(public)/p/[publicToken]/encontre/action.ts today, others later — to
// import that module, which is exactly the inversion `requireTitularAccess`
// avoids by living in lib/infra/pet-access.ts. Same argument, same shelf.
//
// DELIBERATE NON-CALLERS, named so the next person does not "unify" them:
//   - `resolve-dispute` picks one holder with the same shape and a DIFFERENT
//     decision: a custody dispute must NOT notify a contested party, so its
//     ranking is about who is uncontested, not who is most responsible.
//
// THE SIGHTING FLOW WAS ON THAT LIST AND IS NOT ANY MORE (2026-08-23). It was
// listed as "a lower-stakes channel whose recipient set is a product question…
// migrating it is a decision, not a tidy-up", and the decision has now been
// taken deliberately rather than drifted into. What forced it was the header
// below coming true in the sighting flow: a role FILTER was added there, and
// because that read is a hard gate placed BEFORE the event write, a pet in
// shelter custody stopped being able to receive a sighting at all. The
// recipient set of a sighting turned out to be the same question as the
// recipient set of a found report, one notch lower in stakes — and a second
// copy of the rule would have drifted from the promise the caretaker UI makes.
// Caller: src/modules/pets/application/sighting/report-pet-sighting.ts.
//
// HISTORY WORTH KEEPING. The ranking below used to be a bare `.limit(1)` over
// every active ownership row, with no role filter and no ORDER BY (ROUTE-1,
// audit 2026-08-04). On a pet with an active foster, Postgres was free to hand
// back the foster, and the finder's phone number went to them instead of the
// titular — on the recovery path, which is exactly where mis-routing hurts. A
// role FILTER would have been worse than the bug: a pet in shelter custody has
// no `owner` row at all, so filtering turns a mis-routed alert into no alert.
// Ranking is the fix, and it is preserved here byte-for-byte.

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { type OwnershipRole, db, ownerships } from "@/db";

export type AlertRecipientTier = "primary" | "secondary";

export type AlertRecipient = {
  userId: string;
  role: OwnershipRole;
  /**
   * `primary` is the single winner ROUTE-1 would have picked on its own.
   * `secondary` is a concurrent recipient — delivered at the same time, with
   * the SAME finder contact, not a fallback and not a digest. Ranking exists so
   * the titular reads first in any surface that orders by responsibility, not
   * so the caretaker waits.
   */
  tier: AlertRecipientTier;
};

/**
 * Everyone who must hear that a finder has this pet.
 *
 * Empty when nobody can be notified — every holder is an organisation (there is
 * no `user_id` to write a notification row against) or there is no active
 * holder at all. The caller treats empty as "no active owner found".
 *
 * @param petId internal pet id, not the public token.
 */
export async function resolveLostPetAlertRecipients(petId: string): Promise<AlertRecipient[]> {
  const activeHolders = await db
    .select({ userId: ownerships.ownerUserId, role: ownerships.role })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        isNull(ownerships.endedAt),
        // ROUTE-1 filtered nulls in JS with `&& r.userId`; doing it in SQL is
        // the same answer and keeps an org-held pet from occupying a rank.
        isNotNull(ownerships.ownerUserId),
      ),
    )
    // NOT in ROUTE-1, and a deliberate refinement rather than an accident: the
    // third rule ("whoever is caring for it") had no tie-break, so two holders
    // of different non-ranked roles gave a non-deterministic winner. Ordering
    // by when the row opened makes it the longest-standing holder. It cannot
    // change the first two rules — one active `owner` row per pet is a partial
    // unique index, and so is one active shelter_custody per (pet, org).
    .orderBy(asc(ownerships.startedAt), asc(ownerships.id));

  // ROUTE-1's ranking, unchanged: titular, else the institution holding
  // custody, else whoever is caring for the animal.
  const primary =
    activeHolders.find((r) => r.role === "owner") ??
    activeHolders.find((r) => r.role === "shelter_custody") ??
    activeHolders[0];

  if (!primary?.userId) return [];

  const recipients: AlertRecipient[] = [
    { userId: primary.userId, role: primary.role, tier: "primary" },
  ];

  // Active caretakers join as CONCURRENT recipients. Deduped against the
  // primary: a lone caretaker already won ROUTE-1's third rule, and listing
  // them again would send the same person two notifications for one report.
  for (const holder of activeHolders) {
    if (holder.role !== "caretaker") continue;
    if (!holder.userId || holder.userId === primary.userId) continue;
    recipients.push({ userId: holder.userId, role: "caretaker", tier: "secondary" });
  }

  return recipients;
}
