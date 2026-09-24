// Use-case: accept a cross-org custody transfer (receiver org side).
//
// Migrated from app/actions/cross-org-transfer.ts::acceptCrossOrgTransferAction.
// Auth (requireCapability('org.transfer.accept')) is handled by the caller.
// org token match + canonical receiver resolution + drift detection in this use-case.
//
// Orchestrates:
//   1. Receiver org token match
//   2. Load case by publicCode + validate kind/status/pet
//   3. Load proposal events (LIMIT 2) + duplicate-proposal guard
//   4. Canonical sender + drift detection (validateSenderOrgScope)
//   5. Canonical receiver + drift detection (validateReceiverOrgScope) — SECURITY BOUNDARY
//   6. Pre-tx: findOpenCustodyEpisode + findActiveFosterRow (foster cascade)
//   7. ATOMIC tx (guards first, under the pet advisory lock: case still open,
//      no open custody dispute (M-10), source still holds, not a sponsorship
//      (REQ-15), one live org custody):
//      a. foster cascade (if active foster): closeFosterOwnership +
//         insertPetEvent(foster_ended, UPFRONT UUID) — emitted BEFORE
//         custody_transferred so its payload can reference the foster_ended id
//      b. insertPetEvent(custody_transferred, authorRole=shelter, honoring
//         from_role/to_role carried by the proposal)
//      c. end source ownership — role-aware: endShelterCustody OR
//         endOwnerOwnershipForOrg depending on the proposal's from_role
//      d. insertShelterCustody(receiver, role=to_role)
//      e. closeCase(handshake, resolved)
//      f. closeCase(custody_episode, resolved) if open
//      g. collect sender coordinator notifications + receiver user notification
//         + foster user notification (if a foster was closed)
//   8. Return UseCaseResult<{ publicCode }> + notifications
//
// ROLE HONORING (2026-07-05): the direct custody handoff (transferCustody) now
// routes through this consented flow instead of a unilateral flip. It carries
// `from_role` (source ownership role) and `to_role` (destination role) in the
// custody_transfer_proposed payload. This use-case reads them and honors both
// the temporary-custody (shelter_custody) and permanent-owner (owner) outcomes.
// Legacy / return-to-owner proposals omit the roles and default to
// shelter_custody, preserving prior behavior exactly.

import { randomUUID } from "node:crypto";

import { ORG_CUSTODY_TAKEN_ERROR, isOrgCustodyCollision } from "@/lib/infra/org-custody";

import {
  OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR,
  SPONSORED_CUSTODY_TRANSFER_ERROR,
  validateDuplicateProposalGuard,
  validateOrgTokenMatch,
  validateReceiverOrgScope,
  validateSenderOrgScope,
  validateSourceNotSponsored,
} from "../domain/cross-org-rules";
import type { TransfersRepository } from "../infrastructure/transfers-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

type Deps = {
  repo: typeof TransfersRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type AcceptCrossOrgTransferInput = {
  receiverOrgToken: string;
  casePublicCode: string;
};

// ---------------------------------------------------------------------------
// Sponsored custody guard (rehome-by-titular, REQ-15)
// ---------------------------------------------------------------------------

/**
 * The sender's live shelter_custody row may have been opened by a titular's
 * consent: the animal lives with its family, and only the titular ends that
 * arrangement. The propose path refuses this too, but a sponsorship can be
 * accepted AFTER the proposal was made, so the check that holds is this one,
 * on the row re-read under the lock.
 *
 * Refusing — rather than ending the sponsorship inside the hand-off, as a
 * decomiso does — is deliberate: ending it here would leave the receiver
 * holding custody beside the titular's owner row with no started event
 * naming that row, and the titular's withdraw (keyed on the spine) could
 * never find it. REQ-10's unconditional route back would be gone.
 *
 * An `owner`-role source (santuario / decomiso org) is never a sponsorship.
 */
async function refuseIfSponsoredCustody(
  repo: Deps["repo"],
  args: { petId: string; fromRole: "shelter_custody" | "owner"; sourceCustodyId: string },
  tx: unknown,
): Promise<void> {
  if (args.fromRole !== "shelter_custody") return;
  const sponsorship = await repo.findOpenSponsorship(
    args.petId,
    tx as Parameters<typeof repo.findOpenSponsorship>[1],
  );
  const rule = validateSourceNotSponsored({
    sourceCustodyId: args.sourceCustodyId,
    openSponsorship: sponsorship,
  });
  if (!rule.ok) throw new Error(rule.error);
}

// ---------------------------------------------------------------------------
// Open custody dispute guard (M-10)
// ---------------------------------------------------------------------------

/**
 * Propose refuses a pet under an open custody dispute; accept never did — and a
 * handshake stays open for 30 days. A dispute opened inside that window let the
 * animal change institution mid-case, and the dispute's resolution then named
 * as "previous holder" an institution that was never party to it.
 * Misattribution in an append-only spine cannot be corrected, so the guard has
 * to hold HERE, under the lock, before any custody write. Opening a dispute
 * does not cancel pending handshakes either, so nothing upstream closes this.
 *
 * The P2P twin got this as TR-C1 (CRITICAL, fixed); the cross-org twin never
 * did. It reads the same pet snapshot the twin re-runs under ITS lock, but uses
 * ONLY the dispute arm: `validatePetStatusForTransfer` is deliberately NOT
 * reused, because its `lost` arm would refuse a shelter handing a
 * still-unclaimed found animal to another shelter — the normal case here.
 */
async function refuseIfDisputed(repo: Deps["repo"], petId: string, tx: unknown): Promise<void> {
  const petSnapshot = await repo.findPetStatusById(
    petId,
    tx as Parameters<typeof repo.findPetStatusById>[1],
  );
  if (!petSnapshot) {
    throw new Error("La mascota ya no existe. La transferencia no es válida.");
  }
  if (petSnapshot.inCustodyDispute) {
    throw new Error(OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function acceptCrossOrgTransfer(
  input: AcceptCrossOrgTransferInput,
  deps: Deps,
): Promise<
  UseCaseResult<{
    publicCode: string;
    caseId: string;
    petId: string;
    senderOrgId: string;
    receiverOrgId: string;
  }>
> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Receiver org token match.
  const tokenMatch = validateOrgTokenMatch(
    organization.publicToken,
    input.receiverOrgToken,
    "receiver",
  );
  if (!tokenMatch.ok) return tokenMatch;

  // 2. Load case.
  const caseRow = await repo.findCaseByPublicCode(input.casePublicCode);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.caseKind !== "custody_transfer_handshake") {
    return { ok: false, error: "Este caso no es un handshake de transferencia." };
  }
  if (caseRow.status !== "open") {
    return { ok: false, error: "Este caso ya no está abierto." };
  }
  if (!caseRow.primaryPetId) {
    return { ok: false, error: "Caso sin mascota asociada." };
  }

  // 3. Load proposal events (LIMIT 2) + duplicate-proposal guard.
  const proposalEvents = await repo.proposalEventsForCase(caseRow.id);
  const dupGuard = validateDuplicateProposalGuard(proposalEvents.length);
  if (!dupGuard.ok) return dupGuard;
  const [proposalEvent] = proposalEvents;
  const proposalPayload = proposalEvent.payload as {
    from_organization_id?: string;
    to_organization_id?: string;
    reason?: string;
    from_role?: "shelter_custody" | "owner";
    to_role?: "shelter_custody" | "owner";
    notes?: string | null;
  };
  // Roles carried by the proposal. Legacy / return-to-owner proposals omit them
  // and default to shelter_custody (prior behavior).
  const fromRole = proposalPayload.from_role ?? "shelter_custody";
  const toRole = proposalPayload.to_role ?? "shelter_custody";

  // 4. Canonical sender resolution + drift detection.
  const senderResult = validateSenderOrgScope({
    caseOpenedByOrganizationId: caseRow.openedByOrganizationId,
    payloadFromOrganizationId: proposalPayload.from_organization_id,
  });
  if (!senderResult.ok) return senderResult;
  const { canonicalSenderOrgId } = senderResult.value;

  // 5. Canonical receiver resolution + drift detection — SECURITY BOUNDARY.
  const receiverResult = validateReceiverOrgScope({
    caseReceiverOrganizationId: caseRow.receiverOrganizationId,
    payloadToOrganizationId: proposalPayload.to_organization_id,
    callerOrgId: organization.id,
  });
  if (!receiverResult.ok) return receiverResult;

  // 6. Pre-tx: find open custody_episode + active foster row (cascade).
  const custodyCase = await repo.findOpenCustodyEpisode(caseRow.primaryPetId);
  const fosterRow = await repo.findActiveFosterRow(caseRow.primaryPetId);
  // Upfront UUID for foster_ended — needed BEFORE the custody_transferred
  // payload is built (CHECK-constraint ordering: foster_ended referenced by id).
  const fosterEndedEventId = fosterRow ? randomUUID() : null;

  const pendingNotifications: NewNotification[] = [];

  // 7. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const now = new Date();

      // CONCURRENCY GUARD (parity with owner-accept-return, D3): take the pet's
      // advisory lock and re-check the case is STILL open UNDER the lock BEFORE
      // any destructive custody write. The pre-tx `caseRow.status === "open"`
      // check above is a stale read — a concurrent reject/cancel/expire may have
      // closed the case after it. Without this the custody flip (event insert +
      // shelter-custody end/start) executes against an already-closed case, and
      // the closeCase call below cannot undo those writes (its result was always
      // discarded anyway). The loser aborts here and the tx rolls back untouched.
      await repo.acquirePetAdvisoryLock(
        caseRow.primaryPetId as string,
        tx as Parameters<typeof repo.acquirePetAdvisoryLock>[1],
      );
      const currentStatus = await repo.caseStatusById(
        caseRow.id,
        tx as Parameters<typeof repo.caseStatusById>[1],
      );
      if (currentStatus !== "open") {
        throw new Error("Este caso ya no está abierto.");
      }

      // CUSTODY-DISPUTE GUARD (M-10) — under the lock, see refuseIfDisputed.
      await refuseIfDisputed(repo, caseRow.primaryPetId as string, tx);

      // SOURCE-CUSTODY GUARD (TR-H1): re-verify the source org STILL HOLDS the
      // custody row we are about to end, under the lock. The case being open is
      // not enough — a concurrent return-to-owner (or any release) could have
      // ended the source's shelter_custody/owner row after the pre-tx read.
      // endShelterCustody/endOwnerOwnershipForOrg silently no-op when the source
      // no longer holds, but insertShelterCustody(receiver) would land anyway →
      // a phantom custodian (there is no unique-active-shelter index to catch
      // it). Abort here instead so nothing is written.
      const sourceCustody =
        fromRole === "owner"
          ? await repo.findActiveOwnerOwnershipForOrg(
              caseRow.primaryPetId as string,
              canonicalSenderOrgId,
              tx as Parameters<typeof repo.findActiveOwnerOwnershipForOrg>[2],
            )
          : await repo.findActiveShelterCustody(
              caseRow.primaryPetId as string,
              canonicalSenderOrgId,
              tx as Parameters<typeof repo.findActiveShelterCustody>[2],
            );
      if (!sourceCustody) {
        throw new Error(
          "La organización de origen ya no tiene la custodia de esta mascota. La transferencia no es válida.",
        );
      }

      // SPONSORED CUSTODY IS NOT THE ORG'S TO HAND OFF (rehome-by-titular,
      // REQ-15) — see refuseIfSponsoredCustody below. Under the lock, on the
      // row just re-read.
      await refuseIfSponsoredCustody(
        repo,
        { petId: caseRow.primaryPetId as string, fromRole, sourceCustodyId: sourceCustody.id },
        tx,
      );

      // ONE LIVE ORG CUSTODY PER PET (0195). When the destination is
      // shelter_custody, the receiver's insert below collides with any live
      // org custody this flow does not close. The shelter_custody-source branch
      // closes the sender's — and the index guarantees that was the only one.
      // The owner-source branch closes the sender's `owner` row only, so a
      // THIRD org's live custody (a found-pet intake) stays and the insert
      // would hit the index. Refuse here, under the lock, with the sentence
      // the member reads; the catch below maps the index if it fires anyway.
      if (toRole === "shelter_custody") {
        const held = await repo.findLiveOrgShelterCustody(
          caseRow.primaryPetId as string,
          tx as Parameters<typeof repo.findLiveOrgShelterCustody>[1],
        );
        if (held && held.ownerOrganizationId !== canonicalSenderOrgId) {
          throw new Error(ORG_CUSTODY_TAKEN_ERROR);
        }
      }

      // Foster cascade — close the active foster + emit foster_ended FIRST
      // (upfront UUID) so custody_transferred can reference it. A fostered pet
      // handed off via the direct-custody front door used to have its foster
      // closed at flip time; that cascade now lands here, at accept.
      if (fosterRow && fosterEndedEventId) {
        await repo.closeFosterOwnership(
          fosterRow.id,
          now,
          tx as Parameters<typeof repo.closeFosterOwnership>[2],
        );
        await repo.insertPetEvent(
          {
            id: fosterEndedEventId,
            petId: caseRow.primaryPetId as string,
            eventType: "foster_ended",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId: user.id,
            authorRole: "shelter",
            authorOrganizationId: canonicalSenderOrgId,
            authorVerified: organization.verified,
            payload: {
              foster_user_id: fosterRow.ownerUserId,
              reason: "other",
              notes: "Transferencia de custodia a otra organización.",
            },
          },
          tx as Parameters<typeof repo.insertPetEvent>[1],
        );
      }

      await repo.insertPetEvent(
        {
          petId: caseRow.primaryPetId as string,
          eventType: "custody_transferred",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified: organization.verified,
          payload: {
            from_user_id: null,
            from_organization_id: canonicalSenderOrgId,
            to_user_id: null,
            to_organization_id: organization.id,
            from_role: fromRole,
            to_role: toRole,
            reason: proposalPayload.reason ?? "org_to_org_handoff",
            matched_against_pet_id: null,
            foster_ended_event_id: fosterEndedEventId,
            notes: proposalPayload.notes ?? null,
          },
          caseId: caseRow.id,
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      // End the source ownership — role-aware. shelter_custody sources use the
      // existing path; a permanent-owner (santuario/decomiso) source ends its
      // `owner`-role row.
      if (fromRole === "owner") {
        await repo.endOwnerOwnershipForOrg(
          caseRow.primaryPetId as string,
          canonicalSenderOrgId,
          tx as Parameters<typeof repo.endOwnerOwnershipForOrg>[2],
        );
      } else {
        await repo.endShelterCustody(
          caseRow.primaryPetId as string,
          canonicalSenderOrgId,
          tx as Parameters<typeof repo.endShelterCustody>[2],
        );
      }

      await repo.insertShelterCustody(
        {
          petId: caseRow.primaryPetId as string,
          ownerOrganizationId: organization.id,
          role: toRole,
          startedAt: now,
        },
        tx as Parameters<typeof repo.insertShelterCustody>[1],
      );

      await repo.closeCase(
        { caseId: caseRow.id, reason: "resolved", closedByUserId: user.id },
        tx as Parameters<typeof repo.closeCase>[1],
      );

      if (custodyCase) {
        await repo.closeCase(
          { caseId: custodyCase.id, reason: "resolved", closedByUserId: user.id },
          tx as Parameters<typeof repo.closeCase>[1],
        );
      }

      // Sender coordinators notification.
      const senderCoords = await repo.orgCoordinatorAdminUserIds(
        canonicalSenderOrgId,
        tx as Parameters<typeof repo.orgCoordinatorAdminUserIds>[1],
      );
      for (const r of senderCoords) {
        pendingNotifications.push({
          userId: r.userId,
          notificationType: "cross_org_transfer_accepted_sender",
          severity: "success",
          title: "Tu transferencia fue aceptada",
          body: `${organization.displayName} recibió la custodia. La transferencia está completa.`,
          ctaLabel: "Ver caso",
          ctaUrl: `/casos/${caseRow.publicCode}`,
          relatedCaseId: caseRow.id,
          relatedPetId: caseRow.primaryPetId,
        });
      }

      // Receiver user notification.
      pendingNotifications.push({
        userId: user.id,
        notificationType: "cross_org_transfer_accepted_receiver",
        severity: "success",
        title: "Transferencia confirmada",
        body: `La pet pasó formalmente a custodia de ${organization.displayName}.`,
        ctaLabel: "Ver caso",
        ctaUrl: `/casos/${caseRow.publicCode}`,
        relatedCaseId: caseRow.id,
        relatedPetId: caseRow.primaryPetId,
      });

      // Foster user notification — their tránsito was closed by the accepted
      // handoff (best-effort; only when a foster was actually active).
      if (fosterRow?.ownerUserId) {
        pendingNotifications.push({
          userId: fosterRow.ownerUserId,
          notificationType: "foster_ended_by_transfer",
          severity: "info",
          title: "La mascota que tenías en tránsito cambió de refugio",
          body: `El tránsito que tenías a cargo se cerró porque la mascota fue transferida a ${organization.displayName}.`,
          relatedPetId: caseRow.primaryPetId,
          ctaLabel: "Ver historial",
          ctaUrl: "/cuenta/transitos/historial",
        });
      }
    });
  } catch (err) {
    if (
      isOrgCustodyCollision(err) ||
      (err instanceof Error && err.message === ORG_CUSTODY_TAKEN_ERROR)
    ) {
      return { ok: false, error: ORG_CUSTODY_TAKEN_ERROR };
    }
    if (err instanceof Error && err.message === SPONSORED_CUSTODY_TRANSFER_ERROR) {
      return { ok: false, error: SPONSORED_CUSTODY_TRANSFER_ERROR };
    }
    // M-10: the member reads propose's sentence verbatim, not wrapped in
    // "No se pudo aceptar la transferencia:" — same passthrough as REQ-15's.
    if (err instanceof Error && err.message === OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR) {
      return { ok: false, error: OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR };
    }
    return {
      ok: false,
      error: `No se pudo aceptar la transferencia: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return {
    ok: true,
    value: {
      publicCode: caseRow.publicCode,
      caseId: caseRow.id,
      petId: caseRow.primaryPetId as string,
      senderOrgId: canonicalSenderOrgId,
      receiverOrgId: organization.id,
    },
    notifications: pendingNotifications,
  };
}
