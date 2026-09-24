// Use-case: rejectDecomisoHandoff — receiver org member rejects the handoff.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.3
//
// Auth (requireCapability('org.transfer.accept') scoped to receiver org) is handled
// by the caller. This use-case receives a pre-authorized actor context.
//
// Key differences from reject cross-org:
//   - Case kind is custody_episode (not custody_transfer_handshake).
//   - The case is NOT closed — govt retains the open episode.
//   - No ownership flip — pet stays in govt transitional custody.
//
// Transaction steps:
//   1. Emit note_added(category='system') with rejection reason.
//   2. Clear receiverOrganizationId on the case (marks proposal as cancelled).
//   3. Notify govt (decomiso_handoff_rejected_govt).
//   4. Audit log: decomiso_handoff_rejected.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { auditLog, cases, type db, organizationMemberships, organizations, petEvents } from "@/db";
import type { Case } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { NewNotification } from "../domain/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RejectDecomisoHandoffInput = {
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
};

export type RejectDecomisoHandoffContext = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

// ---------------------------------------------------------------------------
// Pre-tx validation (runs before opening the transaction)
// ---------------------------------------------------------------------------

export async function validateRejectDecomisoHandoff(
  input: RejectDecomisoHandoffInput,
  ctx: RejectDecomisoHandoffContext,
  dbInstance: typeof db,
): Promise<
  | {
      ok: true;
      caseRow: Case;
      govtOrgId: string;
      reasonNote: string;
    }
  | { ok: false; error: string }
> {
  const [caseRow] = await dbInstance
    .select()
    .from(cases)
    .where(eq(cases.publicCode, input.casePublicCode))
    .limit(1);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.caseKind !== "custody_episode") {
    return { ok: false, error: "Este caso no es un episodio de custodia." };
  }
  if (caseRow.status !== "open") {
    return {
      ok: false,
      error: "Este caso ya no está abierto. El handoff ya fue procesado o cancelado.",
    };
  }
  if (!caseRow.primaryPetId) {
    return { ok: false, error: "Caso sin mascota asociada." };
  }

  // Discriminator: opener must be a sanitary_authority org.
  const [openerOrg] = await dbInstance
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      orgType: organizations.orgType,
    })
    .from(organizations)
    .where(eq(organizations.id, caseRow.openedByOrganizationId as string))
    .limit(1);
  if (!openerOrg || openerOrg.orgType !== "sanitary_authority") {
    return { ok: false, error: "Este caso no corresponde a un decomiso de autoridad sanitaria." };
  }

  // Receiver authorization.
  const canonicalReceiverOrgId = caseRow.receiverOrganizationId;
  if (!canonicalReceiverOrgId) {
    return {
      ok: false,
      error: "Este decomiso no tiene destinatario activo. Puede que ya haya sido reasignado.",
    };
  }
  if (canonicalReceiverOrgId !== ctx.organization.id) {
    return { ok: false, error: "El decomiso no fue dirigido a tu organización." };
  }
  const reasonNote =
    [input.reason, input.message?.trim()].filter(Boolean).join(" — ") ||
    "Rechazado sin motivo especificado";

  return { ok: true, caseRow, govtOrgId: openerOrg.id, reasonNote };
}

// ---------------------------------------------------------------------------
// In-tx body
// ---------------------------------------------------------------------------

type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function rejectDecomisoHandoffInTx(
  caseRow: Case,
  govtOrgId: string,
  reasonNote: string,
  ctx: RejectDecomisoHandoffContext,
  tx: TxType,
): Promise<{ ok: true; pendingNotifications: NewNotification[] }> {
  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  // 5. Emit note_added(category='system').
  const notePayload = validateEventPayload("note_added", {
    category: "system" as const,
    text: `Handoff rechazado por el receptor (${ctx.organization.displayName}): ${reasonNote}`,
  });
  await tx.insert(petEvents).values({
    petId: caseRow.primaryPetId as string,
    eventType: "note_added",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: ctx.user.id,
    authorRole: "shelter",
    authorOrganizationId: ctx.organization.id,
    authorVerified: ctx.organization.verified,
    payload: notePayload,
    caseId: caseRow.id,
  });

  // 6. Clear receiverOrganizationId — episode stays open, govt retains custody.
  await tx
    .update(cases)
    .set({ receiverOrganizationId: null, updatedAt: now })
    .where(eq(cases.id, caseRow.id));

  // 7. Notify govt coordinators.
  const govtCoords = await tx
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, govtOrgId),
        inArray(organizationMemberships.role, ["admin", "coordinator"]),
        isNull(organizationMemberships.leftAt),
      ),
    );
  for (const coord of govtCoords) {
    pendingNotifications.push({
      userId: coord.userId,
      notificationType: "decomiso_handoff_rejected_govt",
      severity: "info",
      title: "Handoff de decomiso rechazado",
      body: `${ctx.organization.displayName} rechazó la propuesta de custodia del caso ${caseRow.publicCode}. Motivo: ${reasonNote}. El animal sigue en custodia oficial — podés reasignar a otro refugio.`,
      ctaLabel: "Ver caso",
      ctaUrl: `/casos/${caseRow.publicCode}`,
      relatedCaseId: caseRow.id,
      relatedPetId: caseRow.primaryPetId,
    });
  }

  // 8. Audit log.
  await tx.insert(auditLog).values({
    actorUserId: ctx.user.id,
    action: "decomiso_handoff_rejected",
    payload: {
      case_id: caseRow.id,
      case_public_code: caseRow.publicCode,
      pet_id: caseRow.primaryPetId,
      govt_org_id: govtOrgId,
      receiver_org_id: ctx.organization.id,
      reason: reasonNote,
    },
  });

  return { ok: true, pendingNotifications };
}
