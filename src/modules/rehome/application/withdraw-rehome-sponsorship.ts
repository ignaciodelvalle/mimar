// Use-case: the titular ends an ACTIVE sponsorship (rehome-by-titular, spec
// REQ-8, REQ-10, REQ-15; design WU4 — "the one-way door's escape hatch").
//
// AUTH IS THE ACTION'S JOB. `requireTitularAccess` plus the owner-role check
// run at the edge; this layer re-asserts the live `owner` row FOR UPDATE
// inside the transaction, because a foster, a caretaker and a co-owner all
// hold a Path-1 row and none of them may end an arrangement the titular made.
//
// UNCONDITIONAL ON THE ORG'S SIDE. Nothing here asks whether the org is
// verified, reachable, mid-review of an applicant, or has paused the listing.
// REQ-10: there is no elapsed time, no org inaction and no org state that
// leaves the titular unable to take the animal back off the shelf — because
// the titular never gave the title away, "taking it back" is just closing the
// org's row.
//
// ONE TRANSACTION, AND THE ORDER IS LOAD-BEARING (the inverse of ADR-1):
//   0. Take the pet advisory lock — BEFORE any row lock. Finalize locks the
//      custody row and then closes the owner row; this path locked the owner
//      row and then closed the custody row: the same two row locks in opposite
//      orders, a deadlock Postgres resolves with 40P01 (WU5 review). Both
//      sides now take `pg_advisory_xact_lock(hashtext(petId))` first, so the
//      row locks under it can no longer form a cycle.
//   1. Lock the titular's owner row; find the open sponsorship on the spine.
//   2. Close the custody row the sponsorship opened — BY ID, never by the
//      (pet, org) shape, which also describes a decomiso or an intake. If it
//      was already closed by someone who forgot the spine, the withdraw goes
//      on anyway: the titular's exit is not hostage to someone else's drift
//      (lint:spine names that orphan separately).
//   3. Clear the listing cache (adoptionListedAt, adoptionListingPausedAt)
//      through the adoption writer — the catalog stops resolving the pet in
//      this same transaction, not eventually.
//   4. Emit `rehome_sponsorship_ended{withdrawn_by_titular}`, signed by the
//      titular — BEFORE step 5, because it attaches to the listing case only
//      while that case is open (attaches-when-open).
//   5. Close the `adoption_listing` case (the sponsorship itself): cancelled,
//      by the titular, with a timeline note both sides read.
//   6. Close every application the listing had (WU4 review, carry-forward 1).
//      With the custody row ended, the org's review and finalize readers and
//      the applicant's own withdraw reader all inner-join a LIVE custody and
//      find nothing; both inboxes hide the rows; nobody is told. A pending
//      application is resolved on the spine (auto-generated, reason named,
//      signed by the titular); an approved one keeps its approval and loses
//      only its open case. Every applicant gets a notification after commit.
//
// ELIGIBILITY IS NOT TOUCHED. `adoptionEligible` is the org's assessment and
// the spine recorded it; without a live custody row and a listed_at it lists
// nothing, and the next accept re-asserts it with an honest previous_state.
// Flipping it here would need an `adoption_eligibility_set(eligible=false)`
// with a reason from a closed catalog that has no "titular withdrew" member.
//
// Notifications and revalidation are OUTSIDE the transaction, per house
// convention: a dead SMTP must never roll back the titular's exit.
//
// THE LEDGER IS ASKED BEFORE THE STATE GUARD (2026-09-10, with the bearer
// door). Step 1's "is there something to withdraw" is the precondition this
// write's own success invalidates: once the sponsorship is ended there is
// nothing open, which is exactly what a RETRY of the same withdraw — a phone
// that never saw the 200 — would be refused with, forever. So when the caller
// hands in a `clientIdempotencyKey`, step 4's `rehome_sponsorship_ended`
// carries it, and a later call with the same key finds that fact under the pet
// lock (step 0, before step 1) and answers the way the first attempt did: ok,
// the same custody row, `replayed: true`, nothing written and nobody told
// twice. The web sends no key and takes the state path it always took.

import { pgErrorCode } from "@/lib/infra/db-errors";

import { NO_ACTIVE_SPONSORSHIP_ERROR, validateWithdrawSponsorship } from "../domain/rehome-rules";
import type { PetSummary, RehomeWithdrawPort, SponsorOrg, StrandedApplication } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

/**
 * SQLSTATEs Postgres raises when it had to pick a loser between two
 * transactions on the same rows: 40P01 deadlock_detected, 40001
 * serialization_failure. Nothing was written; the titular's act is still
 * theirs to retry. Every other failure propagates — a refusal must not hide
 * a real bug.
 */
const SERIALIZATION_CODES = new Set(["40P01", "40001"]);

function serializationRefusal(petName: string): string {
  return `Otra acción sobre ${petName} se estaba registrando al mismo tiempo y la baja no se aplicó. No cambió nada. Volvé a intentar en unos segundos.`;
}

type Deps = {
  repo: RehomeWithdrawPort;
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type WithdrawRehomeSponsorshipInput = {
  petPublicToken: string;
  titularUserId: string;
  /** The client's replay key (a UUID), or null from a door that sends none. */
  clientIdempotencyKey?: string | null;
};

export type WithdrawRehomeSponsorshipValue = {
  petId: string;
  petPublicToken: string;
  /** Null only on a replay whose custody row's org could not be re-read. */
  sponsoringOrganizationId: string | null;
  sponsoringOrganizationPublicToken: string | null;
  /** The custody row the sponsorship opened, now closed. */
  ownershipId: string;
  /** The `adoption_listing` case this closed, or null if none was open (or on a replay). */
  listingCasePublicCode: string | null;
  /** False when the row had already been closed elsewhere (drift, healed here), and on a replay. */
  custodyRowWasLive: boolean;
  /** `true` when the ledger recognised the key: this withdraw had already happened. */
  replayed: boolean;
};

type TxOutcome =
  | {
      ok: true;
      replayed: false;
      ownershipId: string;
      org: SponsorOrg | null;
      orgId: string;
      listing: { id: string; publicCode: string } | null;
      custodyRowWasLive: boolean;
      /** The applications step 6 closed — each applicant told after commit, in words that fit their case. */
      strandedApplications: StrandedApplication[];
    }
  | {
      ok: true;
      replayed: true;
      ownershipId: string;
      orgId: string | null;
      orgPublicToken: string | null;
    }
  | { ok: false; error: string };

export async function withdrawRehomeSponsorship(
  input: WithdrawRehomeSponsorshipInput,
  deps: Deps,
): Promise<UseCaseResult<WithdrawRehomeSponsorshipValue>> {
  const { repo } = deps;
  const key = input.clientIdempotencyKey ?? null;

  const pet: PetSummary | null = await repo.findPetByToken(input.petPublicToken);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };

  const now = deps.now();

  const outcome = await runWithdrawTransaction(pet.name, deps, async (tx) => {
    // 0. The pet lock, before any row lock (see the header: lock order).
    await repo.acquirePetAdvisoryLock(pet.id, tx);

    // 0b. The ledger, before the state guard — see the header.
    if (key !== null) {
      const done = await repo.findSponsorshipEndedByKey(pet.id, input.titularUserId, key, tx);
      if (done) {
        return {
          ok: true,
          replayed: true,
          ownershipId: done.ownershipId,
          orgId: done.sponsoringOrganizationId,
          orgPublicToken: done.sponsoringOrganizationPublicToken,
        };
      }
    }

    // 1. The titular's row, locked; the arrangement, on the spine.
    const ownerRow = await repo.lockLiveOwnerRow(pet.id, input.titularUserId, tx);
    const open = await repo.findOpenSponsorshipForPet(pet.id, tx);
    const gate = validateWithdrawSponsorship({
      titularOwnerRowLive: ownerRow !== null,
      openSponsorship: open,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
    if (!open) return { ok: false, error: NO_ACTIVE_SPONSORSHIP_ERROR };

    const org = await repo.findOrgById(open.sponsoringOrganizationId, tx);
    const orgName = org?.displayName ?? "la organización";

    // 2. The org's custody row — by id.
    const { ended } = await repo.endCustodyRow(open.ownershipId, now, tx);

    // 3. The listing cache.
    await repo.unpublishListing({ petId: pet.id, now }, tx);

    // 4. The closing fact, while the listing case is still open — carrying the
    //    client's key, which is what step 0b reads on a replay.
    await repo.endSponsorshipByTitular(
      { petId: pet.id, titularUserId: input.titularUserId, now, clientIdempotencyKey: key },
      tx,
    );

    // 5. The sponsorship case. A lost close (another closer got there first)
    //    writes no note — the case is closed either way, which is what the
    //    titular asked for.
    const listing = await repo.findOpenListingCase(pet.id, open.sponsoringOrganizationId, tx);
    if (listing) {
      await repo.closeListingCase(
        {
          caseId: listing.id,
          closedByUserId: input.titularUserId,
          organizationId: open.sponsoringOrganizationId,
          timelineNote: `El titular dio de baja el acompañamiento de ${orgName}. El animal sigue con su familia; la publicación se retiró de la búsqueda de hogar.`,
          now,
        },
        tx,
      );
    }

    // 6. The applications the listing had, each closed the way its state
    //    deserves — in THIS transaction, so a stranded applicant cannot exist
    //    for even one committed instant.
    const stranded = await repo.findApplicationsOnListing(pet.id, tx);
    for (const application of stranded) {
      await repo.closeApplicationByTitular(
        {
          petId: pet.id,
          petName: pet.name,
          application,
          titularUserId: input.titularUserId,
          organizationId: open.sponsoringOrganizationId,
          organizationDisplayName: orgName,
          now,
        },
        tx,
      );
    }

    return {
      ok: true,
      replayed: false,
      ownershipId: open.ownershipId,
      org,
      orgId: open.sponsoringOrganizationId,
      listing,
      custodyRowWasLive: ended,
      strandedApplications: stranded,
    };
  });

  if (!outcome.ok) return { ok: false, error: outcome.error };

  // A replay wrote nothing and tells nobody again: the org and every stranded
  // applicant were told the first time, and the dedupe keys below would have
  // collapsed the rows anyway — this simply does not build them.
  if (outcome.replayed) {
    return {
      ok: true,
      value: {
        petId: pet.id,
        petPublicToken: pet.publicToken,
        sponsoringOrganizationId: outcome.orgId,
        sponsoringOrganizationPublicToken: outcome.orgPublicToken,
        ownershipId: outcome.ownershipId,
        listingCasePublicCode: null,
        custodyRowWasLive: false,
        replayed: true,
      },
      notifications: [],
    };
  }

  const titularName = (await repo.findDisplayName(input.titularUserId)) ?? "El titular";
  const recipients = await repo.orgAdminAndCoordinatorUserIds(outcome.orgId);
  const ctaUrl = outcome.listing
    ? `/casos/${outcome.listing.publicCode}`
    : outcome.org
      ? `/org/${outcome.org.publicToken}/casos`
      : null;
  const notifications: NewNotification[] = recipients.map((userId) => ({
    userId,
    notificationType: "rehome_sponsorship_withdrawn",
    severity: "warning",
    title: `${titularName} dio de baja el acompañamiento de ${pet.name}`,
    body: `${pet.name} sigue viviendo con su familia. La publicación se retiró de la búsqueda de hogar y tu organización ya no tiene custodia registral sobre esta mascota.`,
    dedupeKey: `rehome:withdrawn:${outcome.ownershipId}:${userId}`,
    ctaLabel: ctaUrl ? "Ver caso" : null,
    ctaUrl,
    relatedPetId: pet.id,
    relatedCaseId: outcome.listing?.id ?? null,
    category: "custody",
  }));

  // The applicants whose application step 6 closed. What happened and what
  // it means for them, with nothing asked of them — the same courtesy the
  // finalize cascade's "encontró hogar" extends, for the opposite outcome.
  // NOT the same words for both (WU5 review): the adopter the org had
  // already APPROVED was days from an adoption and is told the approval
  // existed and the adoption will not happen; the pending applicant had been
  // promised nothing and gets the plain close.
  const told = new Set<string>();
  for (const application of outcome.strandedApplications) {
    const userId = application.applicantUserId;
    if (told.has(userId)) continue;
    told.add(userId);
    notifications.push({
      userId,
      notificationType: "adoption_application_closed",
      severity: "info",
      title: application.approved
        ? `Tu postulación por ${pet.name} había sido aprobada y quedó cerrada`
        : `Tu postulación por ${pet.name} quedó cerrada`,
      body: application.approved
        ? `El titular retiró la búsqueda de hogar de ${pet.name} antes de concretar la adopción, así que la adopción no va a realizarse y tu postulación quedó cerrada. No hace falta que hagas nada. Hay otras mascotas buscando hogar.`
        : `El titular retiró la búsqueda de hogar de ${pet.name}; tu postulación quedó cerrada. No hace falta que hagas nada. Hay otras mascotas buscando hogar.`,
      dedupeKey: `rehome:withdrawn:${outcome.ownershipId}:applicant:${userId}`,
      ctaLabel: "Ver otras en adopción",
      ctaUrl: "/adoptar",
      relatedPetId: pet.id,
      relatedCaseId: null,
      category: "adoption",
    });
  }

  return {
    ok: true,
    value: {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      sponsoringOrganizationId: outcome.orgId,
      sponsoringOrganizationPublicToken: outcome.org?.publicToken ?? null,
      ownershipId: outcome.ownershipId,
      listingCasePublicCode: outcome.listing?.publicCode ?? null,
      custodyRowWasLive: outcome.custodyRowWasLive,
      replayed: false,
    },
    notifications,
  };
}

/**
 * The withdraw transaction, with the one failure Postgres can legitimately
 * hand back mapped to a sentence. Under the pet advisory lock the row-lock
 * deadlock of the WU5 review cannot form, but a serialization failure against
 * some OTHER writer that does not take the pet lock is still Postgres's call
 * to make — and when it makes it, nothing was written and the titular may
 * simply try again. It used to reach the action as an unhandled error.
 */
async function runWithdrawTransaction(
  petName: string,
  deps: Pick<Deps, "transaction">,
  body: (tx: unknown) => Promise<TxOutcome>,
): Promise<TxOutcome> {
  try {
    return await deps.transaction<TxOutcome>(body);
  } catch (err) {
    const code = pgErrorCode(err);
    if (code !== null && SERIALIZATION_CODES.has(code)) {
      return { ok: false, error: serializationRefusal(petName) };
    }
    throw err;
  }
}
