// Use-case: reject a cross-org custody transfer (receiver org side).
//
// Migrated from app/actions/cross-org-transfer.ts::rejectCrossOrgTransferAction.
// Auth (requireCapability('org.transfer.accept')) is handled by the caller.
//
// Orchestrates:
//   1. Receiver org token match
//   2. Load case by publicCode + open check
//   3. Load proposal event + canonical receiver resolution (validateReceiverOrgScope)
//   4. ATOMIC tx:
//      a. insertPetEvent(note_added, "Rechazada por el receptor: ...")
//      b. closeCase(cancelled)
//      c. collect sender coordinator notifications
//   5. Return UseCaseResult<{ publicCode }> + notifications

import {
  validateOrgTokenMatch,
  validateReceiverOrgScope,
  validateSenderOrgScope,
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

export type RejectCrossOrgTransferInput = {
  receiverOrgToken: string;
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function rejectCrossOrgTransfer(
  input: RejectCrossOrgTransferInput,
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
  if (caseRow.status !== "open") {
    return { ok: false, error: "Este caso ya no está abierto." };
  }

  // 3. Load proposal event + resolve sender + canonical receiver auth.
  const [proposalEvent] = await repo.proposalEventsForCase(caseRow.id);
  if (!proposalEvent) return { ok: false, error: "Propuesta original no encontrada." };
  const proposalPayload = proposalEvent.payload as {
    from_organization_id?: string;
    to_organization_id?: string;
  };

  const senderResult = validateSenderOrgScope({
    caseOpenedByOrganizationId: caseRow.openedByOrganizationId,
    payloadFromOrganizationId: proposalPayload.from_organization_id,
  });
  if (!senderResult.ok) return senderResult;
  const { canonicalSenderOrgId } = senderResult.value;

  const receiverResult = validateReceiverOrgScope({
    caseReceiverOrganizationId: caseRow.receiverOrganizationId,
    payloadToOrganizationId: proposalPayload.to_organization_id,
    callerOrgId: organization.id,
  });
  if (!receiverResult.ok) return receiverResult;

  const reasonNote =
    [input.reason, input.message?.trim()].filter(Boolean).join(" — ") ||
    "Rechazada sin motivo especificado";

  const pendingNotifications: NewNotification[] = [];

  // 4. Atomic transaction.
  try {
    await transaction(async (tx) => {
      const now = new Date();

      await repo.insertPetEvent(
        {
          petId: caseRow.primaryPetId as string,
          eventType: "note_added",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified: organization.verified,
          payload: { category: "system", text: `Rechazada por el receptor: ${reasonNote}` },
          caseId: caseRow.id,
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      await repo.closeCase(
        { caseId: caseRow.id, reason: "cancelled", closedByUserId: user.id },
        tx as Parameters<typeof repo.closeCase>[1],
      );

      const senderCoords = await repo.orgCoordinatorAdminUserIds(
        canonicalSenderOrgId,
        tx as Parameters<typeof repo.orgCoordinatorAdminUserIds>[1],
      );
      for (const r of senderCoords) {
        pendingNotifications.push({
          userId: r.userId,
          notificationType: "cross_org_transfer_rejected_sender",
          severity: "info",
          title: "Tu propuesta de transferencia fue rechazada",
          body: `${organization.displayName} rechazó la propuesta. Motivo: ${reasonNote}`,
          ctaLabel: "Ver caso",
          ctaUrl: `/casos/${caseRow.publicCode}`,
          relatedCaseId: caseRow.id,
          relatedPetId: caseRow.primaryPetId,
        });
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo rechazar la transferencia: ${err instanceof Error ? err.message : "error desconocido"}`,
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
