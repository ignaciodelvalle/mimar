// Use-case: propose a cross-org custody transfer (sender org side).
//
// Migrated from app/actions/cross-org-transfer.ts::proposeCrossOrgTransferAction.
// Auth (requireCapability('org.transfer.propose')) is handled by the caller.
// org token match is validated HERE as a domain rule (security boundary).
//
// Orchestrates:
//   1. Org token match guard
//   2. Reason + notes validation
//   3. Pet lookup + sender active shelter_custody check
//   4. Receiver-not-sender guard
//   5. Receiver org lookup + verified+active check
//   6. No open handshake check, no open dispute check
//   7. ATOMIC tx: openHandshakeCase + insertPetEvent(custody_transfer_proposed) +
//      collect receiver coordinator notifications + sender notification
//   8. Return UseCaseResult<{ publicCode }> + notifications

import type { OpenedReasonParams } from "@/src/modules/cases/domain/opened-reason";
import {
  OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR,
  validateCrossOrgReason,
  validateOrgTokenMatch,
  validateReceiverNotSender,
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

export type ProposeCrossOrgTransferInput = {
  senderOrgToken: string;
  petPublicToken: string;
  receiverOrgId: string;
  reason: string;
  notes?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function proposeCrossOrgTransfer(
  input: ProposeCrossOrgTransferInput,
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

  // 1. Org token match (edge-level auth guard).
  const tokenMatch = validateOrgTokenMatch(
    organization.publicToken,
    input.senderOrgToken,
    "sender",
  );
  if (!tokenMatch.ok) return tokenMatch;

  // 2. Reason + notes validation.
  const notes = input.notes?.trim() || null;
  const reasonResult = validateCrossOrgReason({ reason: input.reason, notes });
  if (!reasonResult.ok) return reasonResult;

  // 3. Pet lookup.
  const pet = await repo.findPetByToken(input.petPublicToken);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };

  // 4. Sender must hold active shelter_custody on the pet.
  const senderCustody = await repo.findActiveShelterCustody(pet.id, organization.id);
  if (!senderCustody) {
    return { ok: false, error: "Tu organización no tiene custodia activa sobre esta mascota." };
  }

  // 4b. That custody must not be a rehome sponsorship (rehome-by-titular,
  // REQ-15): a row a titular's consent opened is not the org's to hand off.
  // Readable refusal here, before a receiver is bothered; the accept re-checks
  // under its lock, because a sponsorship can start after this proposal.
  const notSponsored = validateSourceNotSponsored({
    sourceCustodyId: senderCustody.id,
    openSponsorship: await repo.findOpenSponsorship(pet.id),
  });
  if (!notSponsored.ok) return notSponsored;

  // 5. Receiver-not-sender guard.
  const notSelfGuard = validateReceiverNotSender(organization.id, input.receiverOrgId);
  if (!notSelfGuard.ok) return notSelfGuard;

  // 6. Receiver org must exist + verified + active.
  const receiver = await repo.findReceiverOrg(input.receiverOrgId);
  if (!receiver) return { ok: false, error: "Organización destinataria no encontrada." };
  if (!receiver.verified || receiver.status !== "active") {
    return { ok: false, error: "La organización destinataria no está verificada activa." };
  }

  // 7. No open handshake on this pet.
  const openHandshake = await repo.findOpenHandshakeCase(pet.id);
  if (openHandshake) {
    return {
      ok: false,
      error: "Ya hay una propuesta de transferencia pendiente para esta mascota.",
    };
  }

  // 8. No open custody dispute. Readable refusal here, before a receiver is
  // bothered; the accept re-checks under its lock (M-10), because a dispute can
  // be opened during the 30-day handshake window.
  const openDispute = await repo.findOpenDispute(pet.id);
  if (openDispute) {
    return { ok: false, error: OPEN_CUSTODY_DISPUTE_TRANSFER_ERROR };
  }

  const pendingNotifications: NewNotification[] = [];
  let createdPublicCode = "";
  let createdCaseId = "";

  // 9. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const caseRow = await repo.openHandshakeCase(
        {
          petId: pet.id,
          jurisdictionProvince: pet.jurisdictionProvince,
          jurisdictionLocality: pet.jurisdictionLocality,
          openedByUserId: user.id,
          openedByOrganizationId: organization.id,
          receiverOrganizationId: receiver.id,
          openedReason: {
            code: "cross_org_transfer_proposed",
            // validateCrossOrgReason (line ~83) already checked this against
            // CROSS_ORG_ALLOWED_REASONS; the input type is just still `string`.
            reason: input.reason as OpenedReasonParams<"cross_org_transfer_proposed">["reason"],
          },
        },
        tx as Parameters<typeof repo.openHandshakeCase>[1],
      );
      createdPublicCode = caseRow.publicCode;
      createdCaseId = caseRow.id;

      await repo.insertPetEvent(
        {
          petId: pet.id,
          eventType: "custody_transfer_proposed",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified: organization.verified,
          payload: {
            from_user_id: null,
            from_organization_id: organization.id,
            to_user_id: null,
            to_organization_id: receiver.id,
            reason: input.reason,
            notes,
            matched_against_pet_id: null,
            proposed_at: new Date().toISOString(),
          },
          caseId: caseRow.id,
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      // Receiver coordinator + admin notifications.
      const recipients = await repo.orgCoordinatorAdminUserIds(
        receiver.id,
        tx as Parameters<typeof repo.orgCoordinatorAdminUserIds>[1],
      );
      for (const r of recipients) {
        pendingNotifications.push({
          userId: r.userId,
          notificationType: "cross_org_transfer_proposed_receiver",
          severity: "warning",
          title: `Propuesta de transferencia entrante para ${pet.name}`,
          body: `${organization.displayName} propone transferirte la custodia de ${pet.name}. Tenés 30 días para aceptar o rechazar.`,
          ctaLabel: "Ver propuesta",
          ctaUrl: `/casos/${caseRow.publicCode}`,
          relatedCaseId: caseRow.id,
          relatedPetId: pet.id,
        });
      }

      // Sender confirmation notification.
      pendingNotifications.push({
        userId: user.id,
        notificationType: "cross_org_transfer_proposed_sender",
        severity: "info",
        title: `Propuesta enviada para ${pet.name}`,
        body: `${receiver.displayName} fue notificada. Tenés 30 días antes de auto-expirar.`,
        ctaLabel: "Ver propuesta",
        ctaUrl: `/casos/${caseRow.publicCode}`,
        relatedCaseId: caseRow.id,
        relatedPetId: pet.id,
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo proponer la transferencia: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return {
    ok: true,
    value: {
      publicCode: createdPublicCode,
      caseId: createdCaseId,
      petId: pet.id,
      senderOrgId: organization.id,
      receiverOrgId: receiver.id,
    },
    notifications: pendingNotifications,
  };
}
