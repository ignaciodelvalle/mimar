// Use-case: direct org-to-org custody handoff (custody.transfer).
//
// TRUST-MODEL FIX (2026-07-05): this path used to be a UNILATERAL cross-org
// custody flip — the source org atomically closed its ownership and opened a
// new one on the destination org with the only destination check being
// `verified=true`, and NO acceptance step. That let one org dump a pet plus its
// full medical/legal history on an org that never agreed to receive it.
//
// It now OPENS the same receiver-consent handshake the cross-org transfer flow
// uses (custody_transfer_proposed → acceptCrossOrgTransfer). The ownership flip,
// foster cascade, and custody_episode close all happen at ACCEPT time, inside
// acceptCrossOrgTransfer — never here. This use-case only proposes.
//
// It keeps its distinct front door vs proposeCrossOrgTransfer:
//   - source auth via findPetUnderOrg (accepts an `owner` OR `shelter_custody`
//     source ownership — the permanent-owner santuario/decomiso source), not
//     just shelter_custody;
//   - no free-text reason (defaults to org_to_org_handoff);
//   - the destination role (shelter_custody vs owner) chosen by the source is
//     carried in the proposal payload as `to_role` and honored at accept.
//
// Auth (requireCapability('custody.transfer')) is handled by the caller.
// Auth scope: pet ownership MUST match caller's active org — implicit-org
// security boundary enforced by repo.findPetUnderOrg scoped to organization.id.
//
// Orchestrates:
//   1. Destination validation (non-empty, not same as source)
//   2. Pet lookup scoped to caller org (findPetUnderOrg) — auth boundary
//   3. Source role validation (must be shelter_custody or owner)
//   4. Silent role coercion for the requested destination role (parity quirk)
//   4b. Source custody must not be a rehome sponsorship (REQ-15) — the twin
//      door's guard, which this door was missing until 2026-08-25
//   5. Destination org lookup + verified check
//   6. No open handshake / no open dispute guards
//   7. ATOMIC tx: openHandshakeCase + insertPetEvent(custody_transfer_proposed,
//      carrying from_role + to_role) + collect receiver coordinator/admin
//      notifications + sender confirmation
//   8. Return UseCaseResult<{ publicCode, ... }> + notifications

import { validateSourceNotSponsored } from "../domain/cross-org-rules";
import {
  resolveNewRole,
  validateDestinationNotSource,
  validateTransferableSourceRole,
} from "../domain/direct-transfer-rules";
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

export type TransferCustodyInput = {
  petPublicToken: string;
  destinationOrgId: string;
  newRoleRaw: string;
  notes?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function transferCustody(
  input: TransferCustodyInput,
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

  // 1. Destination validation.
  if (!input.destinationOrgId) {
    return { ok: false, error: "Falta la organización destino." };
  }
  const destNotSrcGuard = validateDestinationNotSource(organization.id, input.destinationOrgId);
  if (!destNotSrcGuard.ok) return destNotSrcGuard;

  // 2. Pet lookup scoped to caller org (implicit-org security boundary).
  const petRow = await repo.findPetUnderOrg(input.petPublicToken, organization.id);
  if (!petRow) {
    return {
      ok: false,
      error: "Mascota no encontrada o no está bajo custodia de tu organización.",
    };
  }

  // 3. Source role validation.
  const srcRoleGuard = validateTransferableSourceRole(petRow.ownershipRole);
  if (!srcRoleGuard.ok) return srcRoleGuard;

  // 4. Silent role coercion (parity quirk — no error on invalid newRole).
  const toRole = resolveNewRole(input.newRoleRaw);
  const fromRole = petRow.ownershipRole as "shelter_custody" | "owner";

  // 4b. That source custody must not be a rehome sponsorship (REQ-15). Same
  // rule and same sentence as proposeCrossOrgTransfer's step 4b, and placed
  // where that one places it: after the source row is resolved, before a
  // receiver is bothered.
  //
  // THIS PATH HAD NO SUCH CHECK UNTIL 2026-08-25, and it is the one that ran.
  // The guard was written onto proposeCrossOrgTransfer — the door someone was
  // thinking about — and a second org-to-org hand-off door existed all along,
  // with its own front (findPetUnderOrg instead of findActiveShelterCustody,
  // no free-text reason, destination role chosen by the sender). Measured on
  // staging: pet DIM-JRSF-9775 carried a live sponsorship whose spine
  // `payload.ownership_id` was exactly the id of its single live
  // `shelter_custody` row, and this use-case still opened case CAS-NBGE-CS3C
  // (`opened_reason_code: custody_handoff_direct` — the fingerprint of this
  // file). The guard would have refused had it been here.
  //
  // The role branch mirrors accept-cross-org-transfer's `refuseIfSponsoredCustody`:
  // an `owner`-role source (santuario / decomiso) is never a sponsorship, and
  // the predicate is keyed on the spine's `ownership_id`, so the query would
  // only ever return a row that cannot match.
  if (fromRole === "shelter_custody") {
    const notSponsored = validateSourceNotSponsored({
      sourceCustodyId: petRow.ownershipId,
      openSponsorship: await repo.findOpenSponsorship(petRow.pet.id),
    });
    if (!notSponsored.ok) return notSponsored;
  }

  // 5. Destination org lookup + verified check.
  const destination = await repo.findReceiverOrg(input.destinationOrgId);
  if (!destination) return { ok: false, error: "Organización destino no encontrada." };
  if (!destination.verified) {
    return { ok: false, error: "La organización destino aún no está verificada." };
  }

  // 6. No open handshake / no open dispute on this pet (consent invariants).
  const openHandshake = await repo.findOpenHandshakeCase(petRow.pet.id);
  if (openHandshake) {
    return {
      ok: false,
      error: "Ya hay una propuesta de transferencia pendiente para esta mascota.",
    };
  }
  const openDispute = await repo.findOpenDispute(petRow.pet.id);
  if (openDispute) {
    return {
      ok: false,
      error: "No podés transferir una mascota con disputa de custodia en curso.",
    };
  }

  const notes = input.notes?.trim() || null;
  const pendingNotifications: NewNotification[] = [];
  let createdPublicCode = "";
  let createdCaseId = "";

  // 7. Atomic transaction — open the handshake + emit the proposal. NO custody
  //    flip and NO foster cascade here; both happen at ACCEPT time.
  try {
    await transaction(async (tx) => {
      const now = new Date();

      const caseRow = await repo.openHandshakeCase(
        {
          petId: petRow.pet.id,
          jurisdictionProvince: petRow.pet.jurisdictionProvince,
          jurisdictionLocality: petRow.pet.jurisdictionLocality,
          openedByUserId: user.id,
          openedByOrganizationId: organization.id,
          receiverOrganizationId: destination.id,
          // The writer that started all of this: it had no regex rule for
          // months, so it rendered "Apertura automática — direct custody
          // handoff to_role=owner" on the change of legal responsible.
          openedReason: { code: "custody_handoff_direct", toRole },
        },
        tx as Parameters<typeof repo.openHandshakeCase>[1],
      );
      createdPublicCode = caseRow.publicCode;
      createdCaseId = caseRow.id;

      await repo.insertPetEvent(
        {
          petId: petRow.pet.id,
          eventType: "custody_transfer_proposed",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified: organization.verified,
          payload: {
            from_user_id: null,
            from_organization_id: organization.id,
            to_user_id: null,
            to_organization_id: destination.id,
            from_role: fromRole,
            to_role: toRole,
            reason: "org_to_org_handoff",
            matched_against_pet_id: null,
            proposed_at: now.toISOString(),
            notes,
          },
          caseId: caseRow.id,
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      // Receiver coordinator + admin notifications — a proposal is now PENDING,
      // not a completed handoff. They must accept before ownership changes.
      const recipients = await repo.orgCoordinatorAdminUserIds(
        destination.id,
        tx as Parameters<typeof repo.orgCoordinatorAdminUserIds>[1],
      );
      for (const r of recipients) {
        pendingNotifications.push({
          userId: r.userId,
          notificationType: "cross_org_transfer_proposed_receiver",
          severity: "warning",
          title: `Propuesta de transferencia entrante para ${petRow.pet.name}`,
          body: `${organization.displayName} propone transferirte a ${petRow.pet.name} (${
            toRole === "shelter_custody" ? "custodia temporal" : "dueño permanente"
          }). Tenés 30 días para aceptar o rechazar.`,
          ctaLabel: "Ver propuesta",
          ctaUrl: `/casos/${caseRow.publicCode}`,
          relatedCaseId: caseRow.id,
          relatedPetId: petRow.pet.id,
        });
      }

      // Sender confirmation notification.
      pendingNotifications.push({
        userId: user.id,
        notificationType: "cross_org_transfer_proposed_sender",
        severity: "info",
        title: `Propuesta enviada para ${petRow.pet.name}`,
        body: `${destination.displayName} fue notificada. La transferencia se completa cuando la acepten.`,
        ctaLabel: "Ver propuesta",
        ctaUrl: `/casos/${caseRow.publicCode}`,
        relatedCaseId: caseRow.id,
        relatedPetId: petRow.pet.id,
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
      petId: petRow.pet.id,
      senderOrgId: organization.id,
      receiverOrgId: destination.id,
    },
    notifications: pendingNotifications,
  };
}
