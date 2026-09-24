// Use-case: the sponsoring org answers a titular's rehome_request — accept or
// decline (rehome-by-titular, spec REQ-4, REQ-5; design ADR-1).
//
// ACCEPT IS ONE TRANSACTION AND THE ORDER IS LOAD-BEARING (ADR-1):
//   1. SELECT ... FOR UPDATE the case; assert open rehome_request addressed to
//      the acting org. This lock is mitigation 1 against two concurrent
//      accepts; migration 0195's per-pet org custody index is mitigation 2,
//      and when it fires (a custody row committed by ANOTHER path between the
//      step-3 read and the step-5 insert) the 23505 is mapped to step 3's own
//      refusal below — never surfaced raw.
//   1b. Re-read the ACCEPTING org inside the transaction, FOR SHARE, and
//      assert it still qualifies to sponsor (verified, shelter / rescue
//      network) — the bar the request applied, applied again at answer time.
//      The session snapshot is not believed here: a verification withdrawn
//      since login would otherwise produce custody + listing + "ya figura en
//      la búsqueda" for a pet the catalog never shows. The share lock makes a
//      de-verification that is racing this accept wait behind it, so the row
//      the accept believes is the row that holds when it commits.
//   2. Assert the consenting titular still holds a live `owner` row — consent
//      expires with title. The row is read FOR UPDATE: a transfer committing
//      between this read and step 5 would otherwise grant custody on the
//      consent of an ex-owner.
//   3. Assert ZERO live shelter_custody rows on the pet — one org at a time.
//   4. Assert the catalog preconditions, so the org gets a reason instead of a
//      silent non-listing.
//   5. INSERT the org's shelter_custody row. NOTHING CLOSES: this is the
//      inverse of decomiso, and the first write path in DIM that produces the
//      owner + shelter_custody pair on purpose.
//   6. Set adoptionEligible + emit adoption_eligibility_set — the adoption
//      writer, whose attachment rule opens the adoption_listing case (the
//      sponsorship itself) as a side effect. That is the point.
//   7. Publish the listing through the adoption REPOSITORY writer (the
//      use-case would look for a custody row step 5 has not committed yet).
//   8. Emit rehome_sponsorship_started attached to the REQUEST case, which
//      is still open at this instant (requires-open).
//   9. Close the request: resolved. Last — the request has been answered.
//
// DECLINE closes the case (cancelled, by the org member) and writes NOTHING
// to the spine: nothing about the animal changed. The `case_closed` timeline
// entry names the org, so the titular reads a decline as a decline and not
// as their own cancel or an operator's close (REQ-5).
//
// Notifications and revalidation are OUTSIDE the transaction, per house
// convention: a dead SMTP must never roll back a granted custody.

import { isOrgCustodyCollision } from "@/lib/infra/org-custody";

import {
  CUSTODY_PRESENT_ERROR,
  validateAcceptPreconditions,
  validateDeclinePreconditions,
} from "../domain/rehome-rules";
import type { PetSummary, RehomeAnswerPort, RequestCase } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Actor = {
  user: { id: string };
  organization: { id: string; displayName: string; verified: boolean };
};

type Deps = {
  repo: RehomeAnswerPort;
  actor: Actor;
  now: () => Date;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type RehomeDecision = "accept" | "decline";

export type RespondToRehomeRequestInput = {
  casePublicCode: string;
  decision: RehomeDecision;
};

export type RespondToRehomeRequestValue = {
  caseId: string;
  casePublicCode: string;
  petId: string;
  petPublicToken: string;
  decision: RehomeDecision;
  /** The shelter_custody row opened on accept; null on decline. */
  ownershipId: string | null;
  /** The adoption_listing case opened on accept; null on decline. */
  listingCaseId: string | null;
};

type TxOutcome =
  | { ok: true; ownershipId: string | null; listingCaseId: string | null; pet: PetSummary }
  | { ok: false; error: string };

export async function respondToRehomeRequest(
  input: RespondToRehomeRequestInput,
  deps: Deps,
): Promise<UseCaseResult<RespondToRehomeRequestValue>> {
  const { repo, actor } = deps;
  const { organization } = actor;

  // Pre-transaction read: a cheap, readable refusal. Stale by construction —
  // every assertion is repeated under the lock below.
  const pre = await repo.findRequestCaseByPublicCode(input.casePublicCode);
  if (!pre) return { ok: false, error: "Solicitud no encontrada." };
  const preGate = validateDeclinePreconditions(answerSnapshot(pre, organization.id));
  if (!preGate.ok) return { ok: false, error: preGate.error };
  if (!pre.primaryPetId || !pre.openedByUserId) {
    return { ok: false, error: "La solicitud no tiene una mascota o un titular asociados." };
  }

  const now = deps.now();
  const petIdForLock = pre.primaryPetId;

  const outcome = await runAnswerTransaction(deps, async (tx) => {
    // 0. The pet advisory lock, before any row lock — the same first lock the
    //    titular's withdraw and adoption's finalize take (WU5 review: lock
    //    order). The pet id is the case's and cannot change under us.
    await repo.acquirePetAdvisoryLock(petIdForLock, tx);

    // 1. Lock, re-read, re-assert.
    const locked = await repo.lockRequestCase(pre.id, tx);
    if (!locked || !locked.primaryPetId || !locked.openedByUserId) {
      return { ok: false, error: "Solicitud no encontrada." };
    }
    const petId = locked.primaryPetId;
    const titularUserId = locked.openedByUserId;

    const pet = await repo.findPetById(petId, tx);
    if (!pet) return { ok: false, error: "Mascota no encontrada." };

    if (input.decision === "decline") {
      const gate = validateDeclinePreconditions(answerSnapshot(locked, organization.id));
      if (!gate.ok) return { ok: false, error: gate.error };

      await repo.closeRequestCase(
        {
          caseId: locked.id,
          reason: "cancelled",
          closedByUserId: actor.user.id,
          decision: "declined",
          organizationId: organization.id,
          timelineNote: `${organization.displayName} rechazó la solicitud de nuevo hogar. El animal sigue con su titular y no se creó ninguna publicación.`,
          now,
        },
        tx,
      );
      return { ok: true, ownershipId: null, listingCaseId: null, pet };
    }

    // 1b-4. Reads under the lock, then the rules in the design's order. The
    // org row is the transaction's, not the session's, and taken FOR SHARE;
    // the owner row is taken FOR UPDATE.
    const actingOrg = await repo.lockOrgForShare(organization.id, tx);
    const ownerRow = await repo.lockLiveOwnerRow(petId, titularUserId, tx);
    const liveShelterCustodyCount = await repo.countLiveShelterCustody(petId, tx);
    const gate = validateAcceptPreconditions({
      ...answerSnapshot(locked, organization.id),
      actingOrg: actingOrg ? { orgType: actingOrg.orgType, verified: actingOrg.verified } : null,
      titularOwnerRowLive: ownerRow !== null,
      liveShelterCustodyCount,
      pet: {
        status: pet.status,
        inCustodyDispute: pet.inCustodyDispute,
        rabiesObservationStatus: pet.rabiesObservationStatus,
        adoptionIneligibleUntil: pet.adoptionIneligibleUntil,
      },
      now,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
    // The gate refused a null org above; the events below sign with the value
    // the transaction read, never the session's.
    const orgVerified = actingOrg?.verified ?? false;

    // 5. The org's custody row, beside the titular's owner row. Nothing closes.
    const custody = await repo.insertShelterCustody({ petId, orgId: organization.id, now }, tx);

    // 6. Eligibility + its event; the attachment rule opens the listing case.
    const { listingCaseId } = await repo.markEligibleAndOpenListing(
      {
        petId,
        userId: actor.user.id,
        orgId: organization.id,
        orgVerified,
        now,
      },
      tx,
    );

    // 7. Publish — repository writer, inside this tx.
    await repo.publishListing({ petId, now }, tx);

    // 8. The consent fact, attached to the request while it is still open.
    await repo.insertSponsorshipStarted(
      {
        petId,
        requestCaseId: locked.id,
        requestCasePublicCode: locked.publicCode,
        ownershipId: custody.id,
        listingCaseId,
        consentedByUserId: titularUserId,
        recordedByUserId: actor.user.id,
        orgId: organization.id,
        orgVerified,
        now,
      },
      tx,
    );

    // 9. Last: the request has been answered.
    await repo.closeRequestCase(
      {
        caseId: locked.id,
        reason: "resolved",
        closedByUserId: actor.user.id,
        decision: "accepted",
        organizationId: organization.id,
        timelineNote: `${organization.displayName} aceptó la solicitud y acompaña la adopción. El animal sigue viviendo con su titular; la organización no lo tiene en su poder.`,
        now,
      },
      tx,
    );

    return { ok: true, ownershipId: custody.id, listingCaseId, pet };
  });

  if (!outcome.ok) return { ok: false, error: outcome.error };

  const titularUserId = pre.openedByUserId;
  const notifications: NewNotification[] = [
    input.decision === "accept"
      ? {
          userId: titularUserId,
          notificationType: "rehome_request_accepted",
          severity: "success",
          title: `${organization.displayName} aceptó acompañar la adopción de ${outcome.pet.name}`,
          body: `${outcome.pet.name} ya figura en la búsqueda de hogar de ${organization.displayName}. Sigue viviendo con vos: podés dar de baja el acompañamiento cuando quieras.`,
          dedupeKey: `rehome:accepted:${pre.id}:${titularUserId}`,
          ctaLabel: "Ver solicitud",
          ctaUrl: `/casos/${pre.publicCode}`,
          relatedPetId: outcome.pet.id,
          relatedCaseId: pre.id,
          category: "custody",
        }
      : {
          userId: titularUserId,
          notificationType: "rehome_request_declined",
          severity: "info",
          title: `${organization.displayName} no va a acompañar la adopción de ${outcome.pet.name}`,
          body: "La organización rechazó la solicitud. Podés enviar una nueva solicitud a otra organización cuando quieras.",
          dedupeKey: `rehome:declined:${pre.id}:${titularUserId}`,
          ctaLabel: "Ver solicitud",
          ctaUrl: `/casos/${pre.publicCode}`,
          relatedPetId: outcome.pet.id,
          relatedCaseId: pre.id,
          category: "custody",
        },
  ];

  return {
    ok: true,
    value: {
      caseId: pre.id,
      casePublicCode: pre.publicCode,
      petId: outcome.pet.id,
      petPublicToken: outcome.pet.publicToken,
      decision: input.decision,
      ownershipId: outcome.ownershipId,
      listingCaseId: outcome.listingCaseId,
    },
    notifications,
  };
}

/**
 * The accept transaction, with mitigation 2 mapped. The step-3 read is under
 * the CASE lock, not a pet lock: a custody row opened by another path (intake,
 * a decomiso, a transfer) can commit between that read and the step-5 insert,
 * and then `ownerships_one_active_org_shelter_custody_per_pet` fires. Postgres
 * has rolled back every step by then; the org reads step 3's own sentence.
 */
async function runAnswerTransaction(
  deps: Pick<Deps, "transaction">,
  body: (tx: unknown) => Promise<TxOutcome>,
): Promise<TxOutcome> {
  try {
    return await deps.transaction<TxOutcome>(body);
  } catch (err) {
    if (isOrgCustodyCollision(err)) return { ok: false, error: CUSTODY_PRESENT_ERROR };
    throw err;
  }
}

function answerSnapshot(row: RequestCase, actingOrganizationId: string) {
  return {
    caseKind: row.caseKind,
    caseStatus: row.status,
    caseReceiverOrganizationId: row.receiverOrganizationId,
    actingOrganizationId,
  };
}
