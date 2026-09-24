// Use-case: create an org-side welfare report (professional, critical severity).
//
// Migrated from app/actions/welfare.ts::createOrgWelfareReportAction.
// Auth (requireUserOrRedirect + org-membership+verified+role gate scoped to
// THE orgToken's org) is handled by the caller (actions.ts).
// This use-case receives a resolved OrgMember principal.
//
// Differences vs. public create (parity from original):
//   - severity FORCED to 'critical' (OA2).
//   - reporterOrganizationId populated.
//   - skips moderation auto-flag (OA7).
//   - OA9 multi-source escalation: query + mutate OTHER open welfare cases
//     for the same pet in the SAME tx; system note on the ORIGINAL case.
//   - OA4 fan-out POST-tx: govt authorities ∪ institutional admins (deduped Set).
//   - audit_log insert inside tx: welfare_report_submitted_by_org.
//
// Orchestrates (parity: exact order from original):
//   1. Resolve subjectPetId from token (if subjectKind=registered_pet).
//   2. insertReportWithRetry (5-attempt 23505 loop via repo).
//   3. ATOMIC tx:
//      a. insertAttachments.
//      b. openCase(welfare_denuncia) → caseRow (openedByOrganizationId set).
//      c. linkCase.
//      d. Pet-event bridge (registered_pet only).
//      e. OA9: findOpenOtherWelfareCasesForPet → insertPetEvent(note_added,
//         authorRole=system, recordedByUserId=null) on the ORIGINAL case.
//      f. Build notifications (govt ∪ admin deduped) + reporter confirmation.
//      g. insertAudit(welfare_report_submitted_by_org).
//   4. POST-tx insertNotifications (best-effort).
//   5. signal.
//   6. Return redirect target.

import { validateEventPayload } from "@/lib/events/event-schemas";
import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import { MALTREATMENT_KINDS, derivePrimarySubjectKind } from "../domain/report-classification";
import type { WelfareRepository } from "../infrastructure/welfare-repository";
import type { NewNotification } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Attachment = {
  storagePath: string;
  mimeType: string;
  fileSize: number;
  originalFilename: string | null;
};

type OrgMember = {
  userId: string;
  orgId: string;
  orgDisplayName: string;
  orgVerified: boolean;
  memberRole: string;
};

type OpenCaseInput = {
  kind: string;
  primarySubjectKind: string;
  primaryPetId: string | null;
  locationLat: string | null;
  locationLng: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedByUserId: string;
  openedByOrganizationId: string;
  openedReason: OpenedReason;
  welfareReportId: string;
};

export type CreateOrgWelfareReportInput = {
  /** Pre-inserted report ID (from the action's insertReportWithRetry call). */
  reportId: string;
  /** Reference code from the pre-insert (used for notifications + signal). */
  referenceCode: string;
  kind: string;
  severity: string; // will be overridden to 'critical' (OA2)
  description: string;
  subjectKind: string;
  /** Pre-resolved pet ID (null when not a registered_pet or token not found). */
  subjectPetId: string | null;
  subjectDescription: string | null;
  locationAddress: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** Drizzle numeric() columns serialize as strings. */
  locationLat: string | null;
  locationLng: string | null;
  occurredAt: Date | null;
  observedSymptoms: string | null;
  /** Already-uploaded attachment refs (paths, mime, size). */
  attachments: Attachment[];
  uploadedPaths: string[];
  orgMember: OrgMember;
  orgToken?: string;
  /** Client-generated UUID for idempotency on the pet-event bridge inserts. */
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<
    WelfareRepository,
    | "insertAttachments"
    | "linkCase"
    | "insertPetEvent"
    | "insertPetEventIdempotent"
    | "insertAudit"
    | "insertNotifications"
    | "findOpenOtherWelfareCasesForPet"
    | "findInstitutionalAdmins"
  >;
  openCase: (input: OpenCaseInput) => Promise<{ id: string; publicCode: string }>;
  findGovtRecipients: (opts: {
    province: string;
    locality: string;
  }) => Promise<string[]>;
  signal: (input: {
    reportId: string;
    kind: string;
    severity: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    hasContact: boolean;
  }) => Promise<void>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type CreateOrgWelfareReportResult =
  | { ok: true; reportId: string; referenceCode: string; redirectTo: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createOrgWelfareReport(
  input: CreateOrgWelfareReportInput,
  deps: Deps,
): Promise<CreateOrgWelfareReportResult> {
  const { repo, openCase, findGovtRecipients, signal, transaction } = deps;
  const {
    reportId,
    referenceCode,
    kind,
    description,
    subjectKind,
    subjectPetId,
    jurisdictionProvince,
    jurisdictionLocality,
    locationLat,
    locationLng,
    occurredAt,
    observedSymptoms,
    attachments,
    orgMember,
    orgToken,
    clientIdempotencyKey,
  } = input;

  // OA2: severity ALWAYS forced to 'critical' (server authoritative).
  const severity = "critical" as const;

  // Atomic tx
  const pendingNotifications: NewNotification[] = [];
  try {
    await transaction(async (tx) => {
      // 3a. Attachment rows
      if (attachments.length > 0) {
        await repo.insertAttachments(
          attachments.map((a) => ({
            welfareReportId: reportId,
            uploadedByUserId: orgMember.userId,
            storagePath: a.storagePath,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            originalFilename: a.originalFilename,
          })),
          tx as Parameters<typeof repo.insertAttachments>[1],
        );
      }

      // 3b. Open case
      const primarySubjectKind = derivePrimarySubjectKind(
        subjectKind,
        subjectPetId,
        locationLat,
        locationLng,
      );
      const caseRow = await openCase({
        kind: "welfare_denuncia",
        primarySubjectKind,
        primaryPetId: primarySubjectKind === "registered_pet" ? subjectPetId : null,
        locationLat: primarySubjectKind === "location" ? locationLat : null,
        locationLng: primarySubjectKind === "location" ? locationLng : null,
        jurisdictionProvince,
        jurisdictionLocality,
        openedByUserId: orgMember.userId,
        openedByOrganizationId: orgMember.orgId,
        openedReason: {
          code: "welfare_report_org",
          referenceCode,
          orgDisplayName: orgMember.orgDisplayName,
        },
        welfareReportId: reportId,
      });

      // 3c. Link case
      await repo.linkCase(reportId, caseRow.id, tx as Parameters<typeof repo.linkCase>[2]);

      // 3d. Pet-event bridge (registered_pet only; org reports always use role=witness/shelter)
      if (subjectKind === "registered_pet" && subjectPetId) {
        const eventOccurredAt = occurredAt ?? new Date();
        const now = new Date();

        const bridgeKind =
          kind === "abandonment"
            ? "abandonment"
            : MALTREATMENT_KINDS.has(kind as never)
              ? "maltreatment"
              : null;

        if (bridgeKind === "abandonment") {
          const payload = validateEventPayload("abandonment_reported", {
            welfare_report_id: reportId,
            reporter_role: "witness",
            description,
          });
          await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "abandonment_reported",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: orgMember.userId,
              authorRole: "shelter",
              authorOrganizationId: orgMember.orgId,
              payload,
              locationLat,
              locationLng,
              caseId: caseRow.id,
              clientIdempotencyKey,
            },
            tx as Parameters<typeof repo.insertPetEventIdempotent>[1],
          );
        } else if (bridgeKind === "maltreatment") {
          const payload = validateEventPayload("maltreatment_reported", {
            welfare_report_id: reportId,
            reporter_role: "witness",
            description,
            severity,
            kind,
          });
          await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "maltreatment_reported",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: orgMember.userId,
              authorRole: "shelter",
              authorOrganizationId: orgMember.orgId,
              payload,
              locationLat,
              locationLng,
              caseId: caseRow.id,
              clientIdempotencyKey,
            },
            tx as Parameters<typeof repo.insertPetEventIdempotent>[1],
          );
        }

        if (observedSymptoms) {
          const payload = validateEventPayload("symptom_observed", {
            source: "welfare_report",
            welfare_report_id: reportId,
            reporter_role: "witness",
            free_text: observedSymptoms,
            matched_symptom_codes: [],
            alerted_disease_codes: [],
            severity_self_assessed: null,
            onset_at: null,
          });
          await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "symptom_observed",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: orgMember.userId,
              authorRole: "shelter",
              authorOrganizationId: orgMember.orgId,
              payload,
              locationLat,
              locationLng,
              caseId: caseRow.id,
              clientIdempotencyKey,
            },
            tx as Parameters<typeof repo.insertPetEventIdempotent>[1],
          );
        }

        // 3e. OA9: multi-source escalation — system note on the ORIGINAL case
        const otherOpenCases = await repo.findOpenOtherWelfareCasesForPet(
          subjectPetId,
          caseRow.id,
          tx as Parameters<typeof repo.findOpenOtherWelfareCasesForPet>[2],
        );
        if (otherOpenCases.length > 0) {
          const original = otherOpenCases[0];
          const notePayload = validateEventPayload("note_added", {
            category: "system",
            text: `Otra organización (${orgMember.orgDisplayName}) reportó un caso adicional sobre esta mascota. Ver caso ${caseRow.publicCode}. Múltiples fuentes elevan la prioridad.`,
          });
          await repo.insertPetEvent(
            {
              petId: subjectPetId,
              eventType: "note_added",
              occurredAt: now,
              recordedAt: now,
              recordedByUserId: null,
              authorRole: "system",
              payload: notePayload,
              caseId: original.caseId,
            },
            tx as Parameters<typeof repo.insertPetEvent>[1],
          );
        }
      }

      // 3f. Build notifications (OA4 fan-out: govt ∪ institutional admins, deduped)
      // Null jurisdiction is coerced, not skipped (2026-08-17) — the resolver is
      // always called so its admin fallback can run.
      const [govtRecipients, adminRecipients] = await Promise.all([
        findGovtRecipients({
          province: jurisdictionProvince ?? "",
          locality: jurisdictionLocality ?? "",
        }),
        repo.findInstitutionalAdmins(tx as Parameters<typeof repo.findInstitutionalAdmins>[0]),
      ]);

      const recipientSet = new Set<string>([...govtRecipients, ...adminRecipients]);
      for (const userId of recipientSet) {
        pendingNotifications.push({
          userId,
          notificationType: "welfare_org_side_critical_received",
          severity: "urgent",
          title: `Denuncia crítica de ${orgMember.orgDisplayName}`,
          body: `${orgMember.orgDisplayName} reportó un caso de maltrato${jurisdictionLocality ? ` en ${jurisdictionLocality}` : ""}. Reporte profesional con severidad crítica.`,
          ctaLabel: "Ver caso",
          ctaUrl: `/casos/${caseRow.publicCode}`,
          relatedCaseId: caseRow.id,
          relatedPetId: subjectPetId,
        });
      }

      // Reporter confirmation.
      //
      // The message used to assert "Las autoridades en jurisdicción ya fueron
      // notificadas" UNCONDITIONALLY — including when recipientSet was empty and
      // literally nobody had been notified. That is worse than silence: an
      // affirmative "ya está avisado" suppresses the manual workaround (phoning
      // the authority) that the reporter would otherwise reach for. The sentence
      // now follows the fact.
      const authoritiesNotified = recipientSet.size > 0;
      if (!authoritiesNotified) {
        await repo.insertAudit(
          {
            actorUserId: orgMember.userId,
            action: "notification_fanout_empty",
            payload: {
              route: "welfare_org_side_critical_received",
              province: jurisdictionProvince ?? "",
              locality: jurisdictionLocality ?? "",
              reason: "no_govt_no_admin",
              welfare_report_id: reportId,
              reference_code: referenceCode,
              case_id: caseRow.id,
            },
          },
          tx as Parameters<typeof repo.insertAudit>[1],
        );
      }
      pendingNotifications.push({
        userId: orgMember.userId,
        notificationType: "welfare_org_side_confirmed_reporter",
        severity: "info",
        title: "Recibimos tu denuncia profesional",
        body: authoritiesNotified
          ? `La denuncia ${referenceCode} entró al sistema con prioridad crítica. Las autoridades en jurisdicción ya fueron notificadas.`
          : `La denuncia ${referenceCode} entró al sistema con prioridad crítica y quedó registrada. Todavía no pudimos avisar a ninguna autoridad para esta jurisdicción: si es urgente, contactá directamente a la autoridad sanitaria de tu localidad.`,
        ctaLabel: "Ver caso",
        ctaUrl: `/casos/${caseRow.publicCode}`,
        relatedCaseId: caseRow.id,
      });

      // 3g. Audit log (REQUIRED — spec R2)
      await repo.insertAudit(
        {
          actorUserId: orgMember.userId,
          action: "welfare_report_submitted_by_org",
          payload: {
            organizationId: orgMember.orgId,
            organizationName: orgMember.orgDisplayName,
            welfareReportId: reportId,
            caseId: caseRow.id,
            subjectKind,
          },
        },
        tx as Parameters<typeof repo.insertAudit>[1],
      );
    });
  } catch (err) {
    // Caller (action) is responsible for storage cleanup on tx failure.
    return {
      ok: false,
      error: `No se pudo registrar la denuncia: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // 4. POST-tx: insertNotifications (best-effort)
  if (pendingNotifications.length > 0) {
    try {
      await repo.insertNotifications(
        pendingNotifications as Parameters<typeof repo.insertNotifications>[0],
      );
      // Web Push leg — urgent-only filtering happens inside the seam (the
      // critical-report fan-out above is severity "urgent"); best-effort,
      // never throws into the action path. Runs AFTER the tx committed.
      const { sendPushForNotifications } = await import("@/lib/infra/web-push");
      await sendPushForNotifications(pendingNotifications);
    } catch (e) {
      console.error("[welfare] notifications insert failed (action did succeed)", e);
    }
  }

  // 5. Signal (best-effort legacy hook)
  await signal({
    reportId,
    kind,
    severity,
    jurisdictionProvince,
    jurisdictionLocality,
    hasContact: true,
  });

  // 6. Redirect target
  const token = orgToken ?? "unknown";
  // Land on EMITIDOS — the tab that actually contains the report just
  // created — carrying its reference code so the hub can confirm it. The
  // bare hub URL defaulted to "Recibidos" (reports derived TO this org,
  // usually empty), so the professional's critical report vanished into a
  // blank screen with no code and no confirmation (9-role external run,
  // 2026-08-18).
  const redirectTo = `/org/${token}/maltrato/recibidos?tab=emitidos&creado=${encodeURIComponent(referenceCode)}`;

  return { ok: true, reportId, referenceCode, redirectTo };
}
