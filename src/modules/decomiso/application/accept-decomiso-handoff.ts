// Use-case: acceptDecomisoHandoff — receiver org member accepts the handoff.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.2
//
// Auth (requireCapability('org.transfer.accept') scoped to receiver org) is handled
// by the caller. This use-case receives a pre-authorized actor context.
//
// Transaction steps:
//   1. Load case by publicCode + validate kind/status/pet.
//   2. Discriminator: opener must be sanitary_authority.
//   3. Receiver authorization: canonicalReceiverOrgId === caller's org.
//   4. Load the latest proposal event (a reassign appends one) + drift detection.
//   5. ATOMIC tx (performed by caller — this function takes a tx parameter):
//      a. custody_transferred event (shelter_custody → shelter_custody, govt→receiver).
//      b. End govt's shelter_custody ownership.
//      c. Open receiver's shelter_custody ownership.
//      d. CLOSE the govt's custody_episode case (reason='resolved').
//      e. OPEN a new custody_episode for the receiver org (no receiverOrganizationId).
//      f. Build notifications (returned for post-tx flush).
//      g. Audit log: decomiso_handoff_accepted.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  auditLog,
  cases,
  type db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
} from "@/db";
import type { Case } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase as libCloseCase, openCase as libOpenCase } from "@/lib/infra/case-helpers";

import type { NewNotification } from "../domain/types";
import { lockHandoffCaseOrThrow } from "./lock-handoff-case";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcceptDecomisoHandoffInput = {
  casePublicCode: string;
};

export type AcceptDecomisoHandoffContext = {
  user: { id: string };
  organization: {
    id: string;
    publicToken: string;
    verified: boolean;
    displayName: string;
  };
};

type ValidateOk = {
  ok: true;
  caseRow: Case;
  govtOrgId: string;
  govtOrgName: string;
  proposalEvent: typeof petEvents.$inferSelect;
};

type ValidateErr = { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pre-tx validation (runs before opening the transaction)
// ---------------------------------------------------------------------------

export async function validateAcceptDecomisoHandoff(
  input: AcceptDecomisoHandoffInput,
  ctx: AcceptDecomisoHandoffContext,
  dbInstance: typeof db,
): Promise<ValidateOk | ValidateErr> {
  // Load the custody_episode case.
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

  // Receiver authorization: canonical column is source of truth.
  const canonicalReceiverOrgId = caseRow.receiverOrganizationId;
  if (!canonicalReceiverOrgId) {
    return { ok: false, error: "El caso no tiene destinatario asignado." };
  }
  if (canonicalReceiverOrgId !== ctx.organization.id) {
    return { ok: false, error: "El decomiso no fue dirigido a tu organización." };
  }

  // Load the LATEST custody_transfer_proposed — the live one.
  //
  // A case may legitimately carry several: every reassign appends a new
  // proposal toward the new receiver and never rewrites the old one (events
  // are append-only). The escalation cron models exactly this — it keys its
  // 7-day clock on MAX(occurred_at) — so the acceptance reads the same way.
  // Treating ">1" as corruption made every reassigned decomiso permanently
  // unacceptable (L-4). The drift checks below still guard the live one: it
  // must point at the case's canonical receiver.
  const [proposalEvent] = await dbInstance
    .select()
    .from(petEvents)
    .where(
      and(eq(petEvents.caseId, caseRow.id), eq(petEvents.eventType, "custody_transfer_proposed")),
    )
    .orderBy(desc(petEvents.occurredAt), desc(petEvents.recordedAt))
    .limit(1);
  if (!proposalEvent) return { ok: false, error: "Propuesta de handoff no encontrada." };

  // Drift detection.
  const proposalPayload = proposalEvent.payload as {
    from_organization_id?: string;
    to_organization_id?: string;
  };
  if (
    caseRow.openedByOrganizationId &&
    proposalPayload.from_organization_id &&
    caseRow.openedByOrganizationId !== proposalPayload.from_organization_id
  ) {
    console.error(
      `decomiso-handshake integrity: case ${caseRow.id} openedByOrganizationId (${caseRow.openedByOrganizationId}) does not match proposal from_organization_id (${proposalPayload.from_organization_id})`,
    );
    return { ok: false, error: "Inconsistencia entre el caso y la propuesta. Contactá soporte." };
  }
  if (
    caseRow.receiverOrganizationId &&
    proposalPayload.to_organization_id &&
    caseRow.receiverOrganizationId !== proposalPayload.to_organization_id
  ) {
    console.error(
      `decomiso-handshake integrity: case ${caseRow.id} receiverOrganizationId (${caseRow.receiverOrganizationId}) does not match proposal to_organization_id (${proposalPayload.to_organization_id})`,
    );
    return { ok: false, error: "Inconsistencia entre el caso y la propuesta. Contactá soporte." };
  }

  return {
    ok: true,
    caseRow,
    govtOrgId: openerOrg.id,
    govtOrgName: openerOrg.displayName,
    proposalEvent,
  };
}

// ---------------------------------------------------------------------------
// In-tx body
// ---------------------------------------------------------------------------

type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function acceptDecomisoHandoffInTx(
  caseRow: Case,
  govtOrgId: string,
  govtOrgName: string,
  ctx: AcceptDecomisoHandoffContext,
  tx: TxType,
): Promise<{ ok: true; receiverPublicCode: string; pendingNotifications: NewNotification[] }> {
  const now = new Date();
  const pendingNotifications: NewNotification[] = [];

  // THE PET ADVISORY LOCK (L-9) — the known gap `src/modules/rehome/README.md`
  // named as "the three decomiso writers". This hand-off closes the govt org's
  // custody row and opens the receiver's; a finalize or a titular's withdraw
  // takes the same `ownerships` row locks while holding this key, in the
  // opposite order — the 40P01 cycle. This function is the first call inside
  // its `db.transaction`, so this is the transaction's first statement.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${caseRow.primaryPetId as string}))`);

  // Re-check under a row lock what was validated before the transaction: the
  // case is still open and still addressed to THIS org. A reassign that
  // committed in between moved it away (lock-handoff-case.ts).
  await lockHandoffCaseOrThrow(tx, caseRow.id, ctx.organization.id);

  // 6. custody_transferred (shelter_custody → shelter_custody, govt→receiver).
  const transferPayload = validateEventPayload("custody_transferred", {
    from_user_id: null,
    from_organization_id: govtOrgId,
    to_user_id: null,
    to_organization_id: ctx.organization.id,
    from_role: "shelter_custody",
    to_role: "shelter_custody",
    reason: "org_to_org_handoff",
    matched_against_pet_id: null,
    foster_ended_event_id: null,
    notes: null,
  });
  await tx.insert(petEvents).values({
    petId: caseRow.primaryPetId as string,
    eventType: "custody_transferred",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: ctx.user.id,
    authorRole: "shelter",
    authorOrganizationId: ctx.organization.id,
    authorVerified: ctx.organization.verified,
    payload: transferPayload,
    caseId: caseRow.id,
  });

  // 7. End the govt's transitional shelter_custody ownership.
  await tx
    .update(ownerships)
    .set({ endedAt: now })
    .where(
      and(
        eq(ownerships.petId, caseRow.primaryPetId as string),
        eq(ownerships.ownerOrganizationId, govtOrgId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    );

  // 8. Open receiver's shelter_custody ownership.
  await tx.insert(ownerships).values({
    petId: caseRow.primaryPetId as string,
    ownerOrganizationId: ctx.organization.id,
    role: "shelter_custody",
    startedAt: now,
  });

  // 9. Close govt's custody_episode case.
  await libCloseCase({ caseId: caseRow.id, reason: "resolved", closedByUserId: ctx.user.id }, tx);

  // 10. Open a NEW custody_episode for the receiver org (spec §5.2 / DC10).
  const receiverEpisode = await libOpenCase(
    {
      kind: "custody_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: caseRow.primaryPetId,
      jurisdictionProvince: caseRow.jurisdictionProvince,
      jurisdictionLocality: caseRow.jurisdictionLocality,
      jurisdictionCountry: caseRow.jurisdictionCountry ?? "AR",
      openedByUserId: ctx.user.id,
      openedByOrganizationId: ctx.organization.id,
      openedReason: {
        code: "decomiso_handoff_accepted",
        // The PUBLIC code, never the internal case UUID.
        sourceCasePublicCode: caseRow.publicCode,
      },
    },
    tx,
  );

  // 11. Build notifications.
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
      notificationType: "decomiso_handoff_accepted_govt",
      severity: "success",
      title: "Decomiso aceptado por el refugio",
      body: `${ctx.organization.displayName} aceptó la custodia del decomiso (caso ${caseRow.publicCode}). El episodio de custodia del refugio quedó registrado como ${receiverEpisode.publicCode}.`,
      ctaLabel: "Ver caso",
      ctaUrl: `/casos/${receiverEpisode.publicCode}`,
      relatedCaseId: receiverEpisode.id,
      relatedPetId: caseRow.primaryPetId,
    });
  }

  pendingNotifications.push({
    userId: ctx.user.id,
    notificationType: "decomiso_handoff_accepted_receiver",
    severity: "success",
    title: "Custodia del decomiso confirmada",
    body: `Aceptaste la custodia del animal decomisado por ${govtOrgName}. El caso de custodia es ${receiverEpisode.publicCode}.`,
    ctaLabel: "Ver caso",
    ctaUrl: `/casos/${receiverEpisode.publicCode}`,
    relatedCaseId: receiverEpisode.id,
    relatedPetId: caseRow.primaryPetId,
  });

  // 12. Audit log.
  await tx.insert(auditLog).values({
    actorUserId: ctx.user.id,
    action: "decomiso_handoff_accepted",
    payload: {
      closed_govt_case_id: caseRow.id,
      closed_govt_case_public_code: caseRow.publicCode,
      opened_receiver_case_id: receiverEpisode.id,
      opened_receiver_case_public_code: receiverEpisode.publicCode,
      pet_id: caseRow.primaryPetId,
      govt_org_id: govtOrgId,
      receiver_org_id: ctx.organization.id,
    },
  });

  return { ok: true, receiverPublicCode: receiverEpisode.publicCode, pendingNotifications };
}
