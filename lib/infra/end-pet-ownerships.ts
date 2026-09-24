// Closing every live ownership row on a pet, without leaving a caretaker
// arrangement half-open.
//
// WHY THIS IS NOT JUST AN UPDATE
// ---------------------------------------------------------------------------
// Most roles are a single row: ending them is `SET ended_at`. `caretaker` is
// three writes that must land together — close the ownership row, emit
// `caretaker_ended`, flip `pet_caretaker_grants.status` to 'ended'. Doing only
// the first leaves a grant that says 'accepted' pointing at a closed row, and
// the consequences are not theoretical:
//
//   - `detect-pet-cache-drift` reports `pet_caretaker_ownership_drift`. Under
//     invariant 3 a cache row the spine cannot explain is the thing the drift
//     harness exists to catch.
//   - The daily expiry cron eventually calls the end path anyway and writes
//     `caretaker_ended` onto whoever owns the pet BY THEN — months later, for
//     an arrangement that person never made.
//   - `caretaker-public-contact.ts` decides the public lost-mode disclosure
//     from the grant ALONE (status='accepted', ends_at in the future, two
//     consent flags) and never joins `ownerships`. The zombie grant keeps
//     publishing a stranger's first name and phone on the new owner's public
//     credential until ends_at.
//
// `insertAdoptionFinalized` closed every live row with one blanket UPDATE and
// hit exactly that. `execute-decomiso` has the same shape. Both now call this.
//
// THE SAME SHAPE, ONE LEVEL UP: A REHOME SPONSORSHIP (WU3 review, M-2)
// ---------------------------------------------------------------------------
// An org's `shelter_custody` row can be the custody a rehome sponsorship
// opened (rehome-by-titular). Closing that row ends the arrangement in fact,
// and `findOpenSponsorship` — keyed on an UNMATCHED `rehome_sponsorship_started`
// — does not notice rows. Without the closing event, REQ-16 refused every
// future request on the pet ("ya tiene una organización acompañando") with
// nothing left to withdraw: a decomiso locked the titular out of the feature
// for good. So, when the open sponsorship's custody row is among the rows
// closed here, `rehome_sponsorship_ended` is written in the same transaction.
//
// WHY IT LIVES IN lib/infra AND NOT IN THE CARETAKERS MODULE
// ---------------------------------------------------------------------------
// Two modules need the three-step end, and `caretakers` was built with ZERO
// cross-module edges on purpose (`check-dependency-direction.ts` says so in as
// many words). Importing it from `adoption` would invert that premise;
// duplicating the three steps in lib would leave two copies of an atomic
// invariant, which is the drift this repo keeps paying for. So the primitive
// sits below both, module→lib is always allowed, and
// `CaretakersRepository.insertEndGrant` delegates here rather than holding a
// second copy. One definition, no new edge.

import { and, eq, isNull } from "drizzle-orm";

import { ownerships, petCaretakerGrants, petEvents } from "@/db";
import type { db } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { createNotification } from "@/lib/infra/notification-service";
import {
  type SponsorshipEndOutcome,
  endRehomeSponsorship,
  findOpenSponsorship,
} from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import type { GrantEndOutcome } from "@/src/modules/caretakers/domain/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Derived from the column, so a widened `author_role` enum cannot drift from this. */
type AuthorRole = NonNullable<(typeof petEvents.$inferInsert)["authorRole"]>;

export type EndCaretakerGrantArgs = {
  grantId: string;
  ownershipId: string;
  petId: string;
  outcome: GrantEndOutcome;
  endsAt: Date;
  now: Date;
  actorUserId: string | null;
  /**
   * WHO IS SIGNING THE `caretaker_ended` EVENT. Defaults to the titular-authored
   * shape the caretakers module has always written, so that module is unchanged.
   *
   * The defaults are WRONG for a hand-off. `db/schema.ts` states the rule: "the
   * test is who the author IS, not which event type they reached for — signing
   * those notes 'owner' showed the real owner a note apparently written by
   * themselves." On an adoption finalize the author is the org coordinator; on a
   * decomiso it is the sanitary authority. Left at the default, the ADOPTER's
   * timeline renders "Cuidado temporal finalizado — Dueño/a, no verificado" for
   * an event a refugio wrote.
   */
  authorRole?: AuthorRole;
  authorVerified?: boolean;
  authorOrganizationId?: string | null;
};

/**
 * What a hand-off closed, handed back so the caller can tell the people
 * involved. Returned instead of a bare count because a count is not actionable:
 * the caretaker is a real person who may still physically have the animal.
 */
export type EndedCaretakerGrant = {
  grantId: string;
  petId: string;
  caretakerUserId: string | null;
  grantedByUserId: string;
  endsAt: Date;
};

/**
 * THE ATOMIC END, verbatim from where it used to live in the caretakers
 * repository. Close the ownership row, emit `caretaker_ended`, flip the grant —
 * inside the caller's transaction, so a failure takes all three with it.
 *
 * `caretaker_ended` is deliberately NOT a titular-only event type: the cron
 * writes it with no acting user, and a caretaker withdrawing from their own
 * arrangement is legitimate. Only the DESIGNATION is titular-only.
 */
export async function endCaretakerGrantAtomically(
  args: EndCaretakerGrantArgs,
  tx: Tx,
): Promise<{ ended: boolean }> {
  await tx
    .update(ownerships)
    .set({ endedAt: args.now })
    .where(and(eq(ownerships.id, args.ownershipId), isNull(ownerships.endedAt)));

  const payload = validateEventPayload("caretaker_ended", {
    payload_version: 1,
    grant_id: args.grantId,
    outcome: args.outcome,
    ends_at: args.endsAt.toISOString(),
  });

  await tx.insert(petEvents).values({
    petId: args.petId,
    eventType: "caretaker_ended",
    occurredAt: args.now,
    recordedAt: args.now,
    recordedByUserId: args.actorUserId,
    authorRole: args.authorRole ?? "owner",
    authorVerified: args.authorVerified ?? false,
    authorOrganizationId: args.authorOrganizationId ?? null,
    payload,
  });

  const flipped = await tx
    .update(petCaretakerGrants)
    .set({
      status: "ended",
      endedAt: args.now,
      endedReason: args.outcome,
      // ownershipId is deliberately NOT cleared: the biconditional accept CHECK
      // only constrains `status='accepted'`, and the pointer is what lets the
      // drift harness compare the grant against the row it produced long after
      // the arrangement is over.
      updatedAt: args.now,
      updatedBy: args.actorUserId,
    })
    .where(and(eq(petCaretakerGrants.id, args.grantId), eq(petCaretakerGrants.status, "accepted")))
    .returning({ id: petCaretakerGrants.id });

  if (flipped.length === 0) {
    throw new Error("El cuidado ya fue finalizado por otra acción.");
  }

  return { ended: true };
}

/**
 * Close EVERY live ownership row on a pet, routing caretakers through the
 * atomic end above and everything else through a plain close.
 *
 * Callers are custody hand-offs that end the previous arrangement wholesale:
 * adoption finalize, decomiso. They must not enumerate roles one by one — that
 * is what collided with the titular's `owner` row on
 * `ownerships_one_active_owner_per_pet` when rehome-by-titular let that row stay
 * open through a sponsorship, and it would collide with a co-owner too.
 *
 * `outcome` is what the caretaker's own timeline will say about why their
 * arrangement ended. It is a required argument and not a default, because
 * "adoption finalized" and "seized by the authority" are not the same story to
 * tell the person who was looking after the animal.
 *
 * `sponsorshipOutcome` is the same question for a rehome sponsorship whose
 * custody row is among the ones closed here — required for the same reason.
 * `adopted` when the hand-off IS the adoption (finalize, a foster converting);
 * `withdrawn_by_platform` when an authority decided it over both parties
 * (decomiso, a resolved custody dispute).
 */
/**
 * END EVERY CARETAKER ARRANGEMENT ON A PET — both halves of it.
 *
 * Split out of `endAllLiveOwnerships` so the PERSON-TO-PERSON transfer can
 * reach it too. That path closes only `role='owner'` rows
 * (`TransfersRepository.closeOwnerOwnerships`) and, before this existed, did not
 * mention caretakers at all: an accepted grant survived a sale outright, and
 * `caretaker-public-contact.ts` — which decides the public lost-mode disclosure
 * from the GRANT alone, never joining `ownerships` — kept publishing a
 * stranger's first name and phone on the new owner's credential until `ends_at`.
 * Two copies of this rule was not an option; one definition below both is.
 *
 * THE TWO HALVES ARE DIFFERENT WRITES, and neither substitutes for the other:
 *
 *   ACCEPTED → `ended`, through the atomic three-step above (close the row,
 *   emit `caretaker_ended`, flip the grant). The arrangement happened, so the
 *   spine owes an ending fact.
 *
 *   PENDING → `cancelled`, a plain status flip with no event. `pending` is
 *   workflow state, not a fact about the animal — there is no
 *   `caretaker_proposed` — so there is nothing to close and nothing to record.
 *   Leaving it is what let an invitee accept days after the hand-off onto a
 *   STRANGER'S pet: write access on the new owner's animal, their contact
 *   published on its credential, and a new owner who could neither cancel the
 *   invitation (cancel is the granter's, and the granter is gone) nor designate
 *   their own caretaker (`pet_caretaker_grants_one_pending_per_pet`). The only
 *   exit was expiry — up to 180 days.
 */
export async function endCaretakerArrangementsForPet(
  args: {
    petId: string;
    outcome: GrantEndOutcome;
    actorUserId: string | null;
    now: Date;
    authorRole?: AuthorRole;
    authorVerified?: boolean;
    authorOrganizationId?: string | null;
  },
  tx: Tx,
): Promise<{ endedCaretakerGrants: EndedCaretakerGrant[] }> {
  // Caretakers one at a time: each needs its grant and its event, and a blanket
  // ownership close would otherwise swallow the row and leave the grant
  // pointing at it.
  //
  // `.for("update")` IS LOAD-BEARING, and its absence was a real defect in the
  // first cut of this function. `endCaretakerGrantAtomically` THROWS when its
  // `UPDATE … WHERE status='accepted'` matches zero rows — correct for the
  // single-grant callers, which all lock first via `findGrantByIdForUpdate`.
  // Unlocked, a concurrent revoke/withdraw/expiry committing between this read
  // and that update makes the throw abort the CALLER'S WHOLE TRANSACTION: a
  // coordinator who already approved an applicant and uploaded a signed
  // contract would see "El cuidado ya fue finalizado por otra acción." and lose
  // the adoption. With the lock, the concurrently-ended grant drops out of the
  // result set under EvalPlanQual, the loop skips it, and the caller's own close
  // handles the row — no throw, no abort.
  const liveCaretakerGrants = await tx
    .select({
      grantId: petCaretakerGrants.id,
      ownershipId: ownerships.id,
      endsAt: petCaretakerGrants.endsAt,
      caretakerUserId: petCaretakerGrants.caretakerUserId,
      grantedByUserId: petCaretakerGrants.grantedByUserId,
    })
    .from(ownerships)
    .innerJoin(petCaretakerGrants, eq(petCaretakerGrants.ownershipId, ownerships.id))
    .where(
      and(
        eq(ownerships.petId, args.petId),
        eq(ownerships.role, "caretaker"),
        isNull(ownerships.endedAt),
        eq(petCaretakerGrants.status, "accepted"),
      ),
    )
    .for("update");

  for (const grant of liveCaretakerGrants) {
    await endCaretakerGrantAtomically(
      {
        grantId: grant.grantId,
        ownershipId: grant.ownershipId,
        petId: args.petId,
        outcome: args.outcome,
        endsAt: grant.endsAt,
        now: args.now,
        actorUserId: args.actorUserId,
        authorRole: args.authorRole,
        authorVerified: args.authorVerified,
        authorOrganizationId: args.authorOrganizationId,
      },
      tx,
    );
  }

  // The pending half. `responded_at` is stamped rather than left NULL: the
  // titular's cockpit and the drift harness both read "when was this resolved",
  // and a NULL there is indistinguishable from a row nobody ever answered.
  // No `ended_at`/`ended_reason` — those belong to an arrangement that existed.
  await tx
    .update(petCaretakerGrants)
    .set({
      status: "cancelled",
      respondedAt: args.now,
      updatedAt: args.now,
      updatedBy: args.actorUserId,
    })
    .where(and(eq(petCaretakerGrants.petId, args.petId), eq(petCaretakerGrants.status, "pending")));

  return {
    endedCaretakerGrants: liveCaretakerGrants.map((g) => ({
      grantId: g.grantId,
      petId: args.petId,
      caretakerUserId: g.caretakerUserId,
      grantedByUserId: g.grantedByUserId,
      endsAt: g.endsAt,
    })),
  };
}

export async function endAllLiveOwnerships(
  args: {
    petId: string;
    outcome: GrantEndOutcome;
    sponsorshipOutcome: SponsorshipEndOutcome;
    actorUserId: string | null;
    now: Date;
    authorRole?: AuthorRole;
    authorVerified?: boolean;
    authorOrganizationId?: string | null;
  },
  tx: Tx,
): Promise<{ endedCaretakerGrants: EndedCaretakerGrant[] }> {
  // Caretakers first — accepted grants ended through the atomic three-step,
  // pending invitations cancelled — before the blanket close below can swallow
  // the rows they point at.
  const { endedCaretakerGrants } = await endCaretakerArrangementsForPet(
    {
      petId: args.petId,
      outcome: args.outcome,
      actorUserId: args.actorUserId,
      now: args.now,
      authorRole: args.authorRole,
      authorVerified: args.authorVerified,
      authorOrganizationId: args.authorOrganizationId,
    },
    tx,
  );

  // The rehome sponsorship, if the custody row it opened is about to close.
  // Keyed on the spine (`payload.ownership_id`), never on the owner +
  // shelter_custody shape, which also describes a decomiso or an intake. Only
  // a LIVE row counts: a sponsorship whose row was already closed elsewhere
  // without its event is drift for lint:spine to report (its orphaned-
  // sponsorship arm, scripts/check-spine-integrity.ts), not for this function
  // to paper over. Nothing is handed back about it: the callers are hand-offs
  // that do not tell the sponsoring org (a follow-up, if the PO wants it),
  // and a return value nobody reads is a seam that only looks like one.
  const openSponsorship = await findOpenSponsorship(args.petId, tx);
  if (openSponsorship) {
    // FOR UPDATE, not a plain read (M-9). A plain SELECT answers from the last
    // COMMITTED version, so a titular's withdraw and an authority's decomiso
    // racing on the same custody both see it live, and both write
    // `rehome_sponsorship_ended` over it — different outcomes, different
    // authors, and the spine is append-only, so those two contradictory
    // sentences are printed forever in the animal's official record. Nothing
    // below catches it: no unique index on the custody key inside the payload,
    // no idempotency key on this writer, and lint:spine only reports the MIRROR
    // drift (a closed custody with no event). Under the lock the loser blocks
    // behind the winner's close of that very row, re-checks `ended_at IS NULL`
    // via EvalPlanQual, finds it closed, and writes nothing. Same table and
    // same pattern as the caretaker read above; the blanket UPDATE three
    // statements down locks these rows anyway, so this costs no new contention.
    const [liveSponsorRow] = await tx
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.id, openSponsorship.ownershipId), isNull(ownerships.endedAt)))
      .limit(1)
      .for("update");
    if (liveSponsorRow) {
      await endRehomeSponsorship(
        {
          petId: args.petId,
          outcome: args.sponsorshipOutcome,
          recordedByUserId: args.actorUserId,
          authorRole: args.authorRole ?? "owner",
          authorVerified: args.authorVerified ?? false,
          authorOrganizationId: args.authorOrganizationId ?? null,
          now: args.now,
        },
        tx,
      );
    }
  }

  // Everything still open: owner, co_owner, foster, shelter_custody, and any
  // caretaker row whose grant was already resolved (so it has no grant to flip).
  await tx
    .update(ownerships)
    .set({ endedAt: args.now })
    .where(and(eq(ownerships.petId, args.petId), isNull(ownerships.endedAt)));

  return { endedCaretakerGrants };
}

/**
 * Tell the people whose arrangement a hand-off just ended.
 *
 * WHY THIS IS NOT OPTIONAL POLISH. Every other way a grant ends notifies both
 * parties — the end use-case builds two notifications, and the expiry cron does
 * the same, because "the arrangement is over" is news the caretaker cannot get
 * any other way: their ownership row is closed, so the pet simply disappears
 * from their list. Without this, a caretaker who is PHYSICALLY HOLDING THE
 * ANIMAL loses access silently and is never told the title moved or who to hand
 * it back to. The titular's cockpit banner does not cover the gap either: it
 * surfaces only `expired`, by an explicit decision documented in
 * get-caretaker-state-for-pet.ts.
 *
 * MUST BE CALLED AFTER THE TRANSACTION COMMITS, never inside it (ARCH-P): a
 * notification failure may not roll back a hand-off. `createNotification`
 * upholds that — it dead-letters instead of throwing, so this function cannot
 * fail the caller.
 *
 * The dedupe keys are DELIBERATELY the same family the caretakers module and
 * the expiry cron already use (`caretaker:grant_ended:{grantId}:{userId}`). A
 * grant ends exactly once, but if the cron ever reaches the same grant, one
 * "el cuidado terminó" per person is the correct outcome, and a different key
 * here would produce two.
 */
export async function notifyCaretakersOfHandoff(
  ended: EndedCaretakerGrant[],
  pet: { name: string; publicToken: string | null },
): Promise<void> {
  for (const grant of ended) {
    if (grant.caretakerUserId) {
      await createNotification({
        userId: grant.caretakerUserId,
        notificationType: "caretaker_grant_ended",
        severity: "warning",
        category: "custody",
        title: `Tu período de cuidado de ${pet.name} terminó`,
        // PO decision 4A (2026-09-22). This used to say "coordiná la entrega
        // con quien lo tiene a cargo ahora" — an instruction with no way to
        // follow it: the caretaker does not know the new titular and the product
        // gives them no channel to that person. So it names the one person they
        // CAN reach — whoever left the animal with them, by the means they
        // already used — and the platform's own channel as the fallback. The
        // CTA follows the fallback: the pet has already left their list, so
        // "Ver mis mascotas" led nowhere.
        body: `Terminó porque cambió la titularidad de ${pet.name}, y ya no podés cargarle eventos. Si el animal sigue con vos, avisale a quien te lo dejó a cargo por el medio que ya usaban. Si no lo podés contactar, escribinos.`,
        ctaLabel: "Escribinos",
        ctaUrl: "/sugerencias",
        relatedPetId: grant.petId,
        dedupeKey: `caretaker:grant_ended:${grant.grantId}:${grant.caretakerUserId}`,
      });
    }

    await createNotification({
      userId: grant.grantedByUserId,
      notificationType: "caretaker_grant_ended",
      severity: "info",
      category: "custody",
      title: `El cuidado temporal de ${pet.name} terminó`,
      // The other half of 4A: the caretaker is now told to reach whoever left
      // the animal with them — this person — so this side says the same thing
      // from here instead of pointing at a third party.
      body: `Terminó porque cambió la titularidad de ${pet.name}. Si el animal sigue con la persona que lo cuidaba, coordiná con ella la entrega.`,
      ctaLabel: "Ver mis mascotas",
      ctaUrl: pet.publicToken ? `/mis-mascotas/${pet.publicToken}` : "/mis-mascotas",
      relatedPetId: grant.petId,
      dedupeKey: `caretaker:grant_ended:${grant.grantId}:${grant.grantedByUserId}`,
    });
  }
}
