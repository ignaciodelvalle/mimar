// Use-case: cancel a cross-org custody transfer (sender org side).
//
// Migrated from app/actions/cross-org-transfer.ts::cancelCrossOrgTransferAction.
// Auth (requireCapability('org.transfer.propose')) is handled by the caller.
//
// Orchestrates:
//   1. Sender org token match
//   2. Load case by publicCode + open check + openedByOrganizationId check
//   3. Resolve receiverOrgId for notification (canonical column, payload fallback)
//   4. ATOMIC tx:
//      a. insertPetEvent(note_added, "Cancelada por el sender: ...")
//      b. closeCase(cancelled)
//      c. collect receiver coordinator notifications (if receiverOrgId known)
//   5. Return UseCaseResult<{ publicCode }> + notifications

import { validateOrgTokenMatch } from "../domain/cross-org-rules";
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

export type CancelCrossOrgTransferInput = {
  senderOrgToken: string;
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function cancelCrossOrgTransfer(
  input: CancelCrossOrgTransferInput,
  deps: Deps,
): Promise<
  UseCaseResult<{
    publicCode: string;
    caseId: string;
    petId: string;
    senderOrgId: string;
    receiverOrgId: string | null;
  }>
> {
  const { repo, actor, transaction } = deps;
  const { user, organization } = actor;

  // 1. Sender org token match.
  const tokenMatch = validateOrgTokenMatch(
    organization.publicToken,
    input.senderOrgToken,
    "sender",
  );
  if (!tokenMatch.ok) return tokenMatch;

  // 2. Load case + open check + sender auth.
  const caseRow = await repo.findCaseByPublicCode(input.casePublicCode);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.status !== "open") {
    return { ok: false, error: "Este caso ya no está abierto." };
  }
  if (caseRow.openedByOrganizationId !== organization.id) {
    return { ok: false, error: "Solo la organización que propuso puede cancelar." };
  }

  // 3. Resolve receiverOrgId for notification: canonical column first, payload fallback.
  let receiverOrgId: string | null | undefined = caseRow.receiverOrganizationId;
  if (!receiverOrgId) {
    const [proposalEvent] = await repo.proposalEventsForCase(caseRow.id);
    if (proposalEvent) {
      receiverOrgId = (proposalEvent.payload as { to_organization_id?: string }).to_organization_id;
    }
  }

  const reasonNote =
    [input.reason, input.message?.trim()].filter(Boolean).join(" — ") ||
    "Cancelada por la organización emisora";

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
          payload: { category: "system", text: `Cancelada por el sender: ${reasonNote}` },
          caseId: caseRow.id,
        },
        tx as Parameters<typeof repo.insertPetEvent>[1],
      );

      await repo.closeCase(
        { caseId: caseRow.id, reason: "cancelled", closedByUserId: user.id },
        tx as Parameters<typeof repo.closeCase>[1],
      );

      if (receiverOrgId) {
        const receiverCoords = await repo.orgCoordinatorAdminUserIds(
          receiverOrgId,
          tx as Parameters<typeof repo.orgCoordinatorAdminUserIds>[1],
        );
        // CTA must live inside the receiver's org portal: org members cannot
        // read custody_transfer_handshake cases via /casos (canReadCase has no
        // branch for that kind), so a /casos/{code} link would dead-end them.
        const receiverOrgToken = await repo.orgPublicTokenById(
          receiverOrgId,
          tx as Parameters<typeof repo.orgPublicTokenById>[1],
        );
        for (const r of receiverCoords) {
          pendingNotifications.push({
            userId: r.userId,
            notificationType: "cross_org_transfer_cancelled_receiver",
            severity: "info",
            title: "Propuesta de transferencia cancelada",
            body: `${organization.displayName} canceló la propuesta. Motivo: ${reasonNote}`,
            relatedCaseId: caseRow.id,
            relatedPetId: caseRow.primaryPetId,
            ctaLabel: "Ver transferencias",
            ctaUrl: receiverOrgToken ? `/org/${receiverOrgToken}/transferencias/recibidas` : "/org",
          });
        }
      }
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo cancelar la transferencia: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return {
    ok: true,
    value: {
      publicCode: caseRow.publicCode,
      caseId: caseRow.id,
      petId: caseRow.primaryPetId as string,
      senderOrgId: organization.id,
      receiverOrgId: receiverOrgId ?? null,
    },
    notifications: pendingNotifications,
  };
}
