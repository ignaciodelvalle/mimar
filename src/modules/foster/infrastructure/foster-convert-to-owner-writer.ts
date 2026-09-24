// The atomic foster -> owner conversion, in one transaction.
//
// WHY IT LEFT foster-repository.ts (2026-08-21)
// ---------------------------------------------------------------------------
// That file sat 5 lines under its size ratchet, and it GREW the night before:
// the custody hand-off fix wired `endAllLiveOwnerships` into this very method,
// because closing ownership rows by enumerating roles had been letting a
// `caretaker` row survive a conversion. So the repository was one edit away
// from failing CI, and the largest single thing in it was this method.
//
// WHY A SIBLING AND NOT lib/infra/ OR THE ADOPTION MODULE
// ---------------------------------------------------------------------------
// It writes `foster_ended` and `custody_transferred` — titular-only event
// types. `scripts/check-titular-gate.ts` scans
// `src/modules/**/infrastructure/**`, so a writer moved to `lib/infra/` would
// vanish from the guard that exists to catch an ungated writer. And the flow is
// foster-owned: putting it under `src/modules/adoption/` would add a
// cross-module edge that `check-dependency-direction.ts` does not allow.
//
// Same shape as `adoption-finalize-writer.ts` and `rehome-sponsorship-writer.ts`
// in the adoption module: a composite write extracted to a named writer that
// stays inside its own module's infrastructure layer, with the repository
// delegating to it so no caller and no test double changes.
//
// VERBATIM MOVE. Same statements, same order, same comments — including the
// explanation of why enumerating roles let a caretaker through.

import { and, eq, isNull, sql } from "drizzle-orm";

import { type db, ownerships, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import { type EndedCaretakerGrant, endAllLiveOwnerships } from "@/lib/infra/end-pet-ownerships";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomic: convert foster → owner in one transaction.
 *
 * Ordering (mirrors transfer-custody.ts for FK/CHECK parity):
 *   a. endFosterOwnership (sets endedAt on the foster row)
 *   b. findOpenCaseForPetAndKind("foster_placement") → caseId
 *   c. insertPetEvent(foster_ended, UPFRONT UUID)
 *   d. closeCase(foster_placement, "resolved") if open
 *   e. closeOwnerOwnerships + closeShelterCustody (end any prior owner rows
 *      AND the org's active shelter_custody — a foster always coexists with an
 *      active shelter_custody; leaving it open = permanent double custody.
 *      Mirrors insertAdoptionFinalized, which closes BOTH. Prevents the
 *      unique-active-owner partial index violation at tx commit.)
 *   f. insertOwnerOwnership (new role='owner' row for the foster user)
 *   g. insertPetEvent(custody_transferred, references foster_ended UUID)
 */
export async function insertConvertFosterToOwner(
  args: {
    petId: string;
    petName: string;
    fosterOwnershipId: string;
    fosterUserId: string;
    fosterEndedEventId: string;
    actorUserId: string;
    now: Date;
  },
  tx: Tx,
): Promise<{ endedCaretakerGrants: EndedCaretakerGrant[] }> {
  const {
    petId,
    petName: _petName,
    fosterOwnershipId,
    fosterUserId,
    fosterEndedEventId,
    actorUserId,
    now,
  } = args;

  // THE PET ADVISORY LOCK, FIRST (M-8). Two writers CLOSE a foster row — this
  // one and `insertEndFoster` — while a shelter's adoption finalize or
  // cross-org accept closes it from the other side. An advisory lock excludes
  // only other TAKERS, so it has to be taken by BOTH sides: locking the convert
  // alone would leave it unserialised against endFoster. `insertAssignFoster`,
  // which OPENS a foster, already takes this exact lock in this same module,
  // naming the double-submit as its threat — the module set the pattern for
  // opening and never applied it to the two writers that close.
  //
  // Taken BEFORE any row lock, it also keeps the row locks `endAllLiveOwnerships`
  // takes below from forming a cycle with the titular's withdraw (WU5 lock
  // order, same key as adoption's `acquirePetAdvisoryLock`).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);

  // a. End foster ownership — RE-READ AND CHECKED under the lock, never a blind
  //    UPDATE by id. The use-case's `findActiveFosterByUser` runs OUTSIDE the
  //    transaction and is stale by construction; the old statement had no
  //    `ended_at IS NULL` and DISCARDED its row count, so when a racing writer
  //    had already closed this row, this one could not tell it had done nothing
  //    and went on to mint an `owner` row on top of a fact already written and
  //    confirmed — in an append-only spine. Refusing is the shape
  //    `finalize-adoption.ts` uses (`lockLiveCustodyRow` + `if (!locked)`), not
  //    a WHERE clause whose row count nobody reads.
  const [lockedFoster] = await tx
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(and(eq(ownerships.id, fosterOwnershipId), isNull(ownerships.endedAt)))
    .limit(1)
    .for("update");
  if (!lockedFoster) {
    throw new Error("Este tránsito ya no está activo. Actualizá la página y volvé a intentar.");
  }
  await tx.update(ownerships).set({ endedAt: now }).where(eq(ownerships.id, fosterOwnershipId));

  // b. Find open foster_placement case.
  const caseRow = await findOpenCaseForPetAndKind(petId, "foster_placement", tx);
  const caseId = caseRow?.id ?? null;

  // c. Emit foster_ended (upfront UUID for ordering).
  const fosterEndedPayload = validateEventPayload("foster_ended", {
    foster_user_id: fosterUserId,
    // "adoption" is the canonical programmatic reason for a foster→owner
    // transition (see event-schemas.ts fosterEnded catalog). The old
    // "adopted_by_foster" value is NOT in the enum, so this whole path threw
    // an EventPayloadValidationError at runtime — the convert flow was dead.
    reason: "adoption",
    notes: null,
  });
  await tx.insert(petEvents).values({
    id: fosterEndedEventId,
    petId,
    eventType: "foster_ended",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: actorUserId,
    authorRole: "owner",
    authorOrganizationId: null,
    authorVerified: false,
    payload: fosterEndedPayload,
    caseId,
  });

  // d. Close foster_placement case if open.
  if (caseId) {
    await closeCase({ caseId, reason: "resolved", closedByUserId: actorUserId }, tx);
  }

  // e. Close EVERY remaining live row — prior owner, the org's
  //    shelter_custody, and any caretaker. Must be BEFORE inserting the new
  //    owner row: the unique-active-owner partial index is checked at commit.
  //
  //    THIS USED TO ENUMERATE TWO ROLES, and the comment that lived here
  //    stated the parity contract it was already half-failing: "A foster
  //    ALWAYS coexists with an active shelter_custody… insertAdoptionFinalized
  //    closes BOTH; convert must too." Closing only foster + owner left
  //    permanent double custody — the org could still re-foster, list, or
  //    finalize the pet to a different adopter, and metrics double-count.
  //
  //    Enumerating is what let a THIRD role through. A `caretaker` row was
  //    closed by neither branch, so a volunteer who adopted the animal they
  //    fostered inherited a live caretaker with write access to their pet and
  //    a grant still publishing that person's name and phone on the public
  //    credential. `endAllLiveOwnerships` takes the set, not a list of roles,
  //    which is the only shape that cannot miss the next one.
  //
  //    authorRole is left at its default here, matching the `foster_ended`
  //    event this same function writes eight lines up. If that attribution is
  //    wrong it is wrong for both, and should move together.
  //
  //    A rehome sponsorship over this pet (the titular kept the title while
  //    the org ran the listing, and the org placed the animal with this
  //    foster) ends here as `adopted`: the foster becoming the owner IS the
  //    adoption the sponsorship was for.
  const { endedCaretakerGrants } = await endAllLiveOwnerships(
    { petId, outcome: "ownership_transferred", sponsorshipOutcome: "adopted", actorUserId, now },
    tx,
  );

  // f. Insert new owner ownership row.
  await tx.insert(ownerships).values({
    petId,
    ownerUserId: fosterUserId,
    role: "owner",
    startedAt: now,
  });

  // g. Emit custody_transferred (AFTER foster_ended — UUID reference is safe).
  const transferredPayload = validateEventPayload("custody_transferred", {
    from_user_id: fosterUserId,
    to_user_id: fosterUserId,
    from_role: "owner" as const,
    to_role: "owner" as const,
    foster_ended_event_id: fosterEndedEventId,
    notes: "Tránsito convertido en adopción por el propio transitante.",
  });
  await tx.insert(petEvents).values({
    petId,
    eventType: "custody_transferred",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: actorUserId,
    authorRole: "owner",
    authorOrganizationId: null,
    authorVerified: false,
    payload: transferredPayload,
    caseId,
  });

  // Handed back so the caller can tell the caretaker post-tx: their row is
  // closed, the pet is gone from their list, and they may still have it.
  return { endedCaretakerGrants };
}
