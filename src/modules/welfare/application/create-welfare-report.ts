// Use-case: create a public welfare report (anonymous or authenticated).
//
// Migrated from app/actions/welfare.ts::createWelfareReportAction.
// Auth (supabase.auth.getUser) and edge rate-limit (welfare_anon bucket)
// are handled by the caller (actions.ts). This use-case receives resolved
// inputs: reporterUserId (null=anon), pre-uploaded attachment refs, and a
// generateReferenceCode factory for the retry loop.
//
// Orchestrates (parity: exact order from original):
//   1. Resolve subjectPetId from token (if subjectKind=registered_pet).
//   2. Resolve isOwner flag (auth user + registered_pet only).
//   3. Derive reporterRole / authorRole.
//   4. insertReportWithRetry (5-attempt 23505 loop via repo).
//   5. ATOMIC tx:
//      a. insertAttachments (if any).
//      b. openCase(welfare_denuncia) → caseRow.
//      c. linkCase (welfareReports.case_id update).
//      d. insertPetEvent bridge (abandonment_reported|maltreatment_reported
//         + optional symptom_observed) — registered_pet only.
//   6. POST-COMMIT best-effort (anon only): computeFlagReasons → setFlagged.
//   7. signal.
//   8. Return redirect target.
//
// Spec R1 audit_log contract: public create writes NO audit_log row.
// (Verified against original — no insertAudit call here.)

import { validateEventPayload } from "@/lib/events/event-schemas";
import type { EventPlace } from "@/lib/events/place-payload";
import type { OpenedReason, OpenedReasonParams } from "@/src/modules/cases/domain/opened-reason";
import {
  MALTREATMENT_KINDS,
  deriveAuthorRole,
  derivePrimarySubjectKind,
  deriveReporterRole,
} from "../domain/report-classification";
import type { WelfareSymptomSurveillance } from "../domain/symptom-surveillance-port";
import type { WelfareRepository } from "../infrastructure/welfare-repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Attachment = {
  storagePath: string;
  mimeType: string;
  fileSize: number;
  originalFilename: string | null;
};

type OpenCaseInput = {
  kind: string;
  primarySubjectKind: string;
  primaryPetId: string | null;
  locationLat: string | null;
  locationLng: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** The catalogue row the door resolved (localidades-por-id); null = unresolved. */
  localityId?: string | null;
  placeMethod?: string | null;
  openedByUserId: string | null;
  openedReason: OpenedReason;
  welfareReportId: string;
};

type ComputeFlagReasonsInput = {
  reportId: string;
  description: string;
  severity: string;
  subjectKind: string;
  attachmentCount: number;
  dwellTimeMs?: number;
  honeypotValue?: string;
};

export type CreateWelfareReportInput = {
  /** Pre-inserted report ID (from the action's insertReportWithRetry call). */
  reportId: string;
  /** Reference code from the pre-insert (used for redirect + signal). */
  referenceCode: string;
  kind: string;
  severity: string;
  description: string;
  subjectKind: string;
  /** Pre-resolved pet ID (null when not a registered_pet or token not found). */
  subjectPetId: string | null;
  /** Whether the reporter is the active owner of the subject pet (pre-resolved). */
  isOwnerOfSubjectPet: boolean;
  subjectDescription: string | null;
  locationAddress: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /**
   * The place as entered and as resolved (lib/place/denuncia-place.ts). Rides
   * the pet-event bridge so the typed locality is never lost.
   */
  eventPlace?: EventPlace | null;
  /** Drizzle numeric() columns serialize as strings. */
  locationLat: string | null;
  locationLng: string | null;
  occurredAt: Date | null;
  reporterContactEmail: string | null;
  reporterContactPhone: string | null;
  observedSymptoms: string | null;
  /** Already-uploaded attachment refs (paths, mime, size). */
  attachments: Attachment[];
  uploadedPaths: string[];
  reporterUserId: string | null;
  dwellTimeMs: number | undefined;
  honeypotValue: string;
  /** Client-generated UUID for idempotency on the pet-event bridge inserts. */
  clientIdempotencyKey: string | null;
};

type Deps = {
  repo: Pick<
    WelfareRepository,
    "insertAttachments" | "linkCase" | "insertPetEvent" | "insertPetEventIdempotent" | "setFlagged"
  >;
  openCase: (input: OpenCaseInput) => Promise<{ id: string; publicCode: string }>;
  computeFlagReasons: (input: ComputeFlagReasonsInput) => Promise<string[]>;
  signal: (input: {
    reportId: string;
    kind: string;
    severity: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    hasContact: boolean;
  }) => Promise<void>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /**
   * PO S7: "síntomas observados" run the matcher and raise a SIGNAL (no legal
   * ENO row, no owner alert). See ../domain/symptom-surveillance-port.ts.
   */
  surveillance: WelfareSymptomSurveillance;
};

export type CreateWelfareReportResult =
  | { ok: true; reportId: string; referenceCode: string; redirectTo: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function createWelfareReport(
  input: CreateWelfareReportInput,
  deps: Deps,
): Promise<CreateWelfareReportResult> {
  const { repo, openCase, computeFlagReasons, signal, transaction } = deps;
  const {
    reportId,
    referenceCode,
    kind,
    severity,
    description,
    subjectKind,
    subjectPetId,
    isOwnerOfSubjectPet,
    jurisdictionProvince,
    jurisdictionLocality,
    locationLat,
    locationLng,
    occurredAt,
    reporterContactEmail,
    reporterContactPhone,
    observedSymptoms,
    attachments,
    reporterUserId,
    dwellTimeMs,
    honeypotValue,
    clientIdempotencyKey,
    eventPlace,
  } = input;

  // Derive roles from pre-resolved ownership
  const reporterRole = deriveReporterRole(isOwnerOfSubjectPet);
  const authorRole = deriveAuthorRole(isOwnerOfSubjectPet);

  // Atomic tx: attachments + openCase + linkCase + pet_event bridge
  // PO S7: the authority notices of any symptom signal, sent after COMMIT.
  let flushSignals: () => Promise<void> = async () => {};

  try {
    await transaction(async (tx) => {
      // 4a. Attachment rows
      if (attachments.length > 0) {
        await repo.insertAttachments(
          attachments.map((a) => ({
            welfareReportId: reportId,
            uploadedByUserId: reporterUserId ?? null,
            storagePath: a.storagePath,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            originalFilename: a.originalFilename,
          })),
          tx as Parameters<typeof repo.insertAttachments>[1],
        );
      }

      // 4b. Open welfare_denuncia case
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
        // The case is keyed to the place the door resolved, so the id-path
        // gates see its row (P3). No place given = nothing recorded.
        ...(eventPlace
          ? {
              localityId: eventPlace.resolved?.locality_id ?? null,
              placeMethod: eventPlace.resolved?.method ?? "unresolved",
            }
          : {}),
        openedByUserId: reporterUserId ?? null,
        openedReason: {
          code: "welfare_report_citizen",
          referenceCode,
          // `kind`/`severity` arrive as bare `string` on this use-case's input;
          // welfare/actions.ts validates both against WELFARE_KINDS /
          // WELFARE_SEVERITIES before calling. Narrowing the port itself is a
          // separate change. A value that somehow escaped validation fails the
          // read-side parse and renders from prose, so it degrades, not breaks.
          kind: kind as OpenedReasonParams<"welfare_report_citizen">["kind"],
          severity: severity as OpenedReasonParams<"welfare_report_citizen">["severity"],
        },
        welfareReportId: reportId,
      });

      // 4c. Link case to the report
      await repo.linkCase(reportId, caseRow.id, tx as Parameters<typeof repo.linkCase>[2]);

      // 4d. Pet-event bridge (registered_pet only)
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
            reporter_role: reporterRole,
            description,
            ...(eventPlace ? { place: eventPlace } : {}),
          });
          await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "abandonment_reported",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: reporterUserId ?? null,
              authorRole,
              payload,
              locationLat,
              locationLng,
              caseId: caseRow.id,
              // The unique index is on (pet_id, event_type, client_idempotency_key),
              // so the same key on different event_type values occupies distinct slots.
              clientIdempotencyKey,
            },
            tx as Parameters<typeof repo.insertPetEventIdempotent>[1],
          );
        } else if (bridgeKind === "maltreatment") {
          const payload = validateEventPayload("maltreatment_reported", {
            welfare_report_id: reportId,
            reporter_role: reporterRole,
            description,
            severity,
            kind,
            ...(eventPlace ? { place: eventPlace } : {}),
          });
          await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "maltreatment_reported",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: reporterUserId ?? null,
              authorRole,
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
          const match = await deps.surveillance.match(subjectPetId, observedSymptoms, tx);
          const payload = validateEventPayload("symptom_observed", {
            source: "welfare_report",
            welfare_report_id: reportId,
            reporter_role: reporterRole,
            free_text: observedSymptoms,
            matched_symptom_codes: match.matchedSymptomCodes,
            alerted_disease_codes: match.alertedDiseaseCodes,
            severity_self_assessed: null,
            onset_at: null,
          });
          const symptom = await repo.insertPetEventIdempotent(
            {
              petId: subjectPetId,
              eventType: "symptom_observed",
              occurredAt: eventOccurredAt,
              recordedAt: now,
              recordedByUserId: reporterUserId ?? null,
              authorRole,
              payload,
              locationLat,
              locationLng,
              caseId: caseRow.id,
              clientIdempotencyKey,
            },
            tx as Parameters<typeof repo.insertPetEventIdempotent>[1],
          );
          // A replay of the same report emits nothing twice.
          if (!symptom.wasNoop && symptom.eventId) {
            flushSignals = await deps.surveillance.emitSignals(
              {
                petId: subjectPetId,
                symptomEventId: symptom.eventId,
                match,
                place: eventPlace ?? null,
                now,
              },
              tx,
            );
          }
        }
      }
    });
  } catch {
    // Tx failed — caller (action) is responsible for storage cleanup.
    return {
      ok: false,
      error:
        "La denuncia se guardó pero no se pudieron registrar los archivos adjuntos. Intentá de nuevo.",
    };
  }

  // 5. Post-commit auto-flag (anon only, best-effort)
  // Spec R1: authenticated submissions SKIP entirely.
  // audit_log: public create writes NONE — no insertAudit call (parity confirmed).
  if (!reporterUserId) {
    try {
      const flagReasons = await computeFlagReasons({
        reportId,
        description,
        severity,
        subjectKind,
        attachmentCount: attachments.length,
        dwellTimeMs,
        honeypotValue,
      });
      if (flagReasons.length > 0) {
        await repo.setFlagged(reportId, { flaggedAt: new Date(), flagReasons });
      }
    } catch (err) {
      console.error("[welfare] auto-flag heuristics failed (non-fatal):", err);
    }
  }

  // Post-commit: the symptom signals' authority notices (PO S7). Best-effort
  // by construction — the report is already committed.
  try {
    await flushSignals();
  } catch (err) {
    console.error("[welfare] symptom-signal notices failed (report kept):", err);
  }

  // 6. Signal (best-effort legacy hook)
  await signal({
    reportId,
    kind,
    severity,
    jurisdictionProvince,
    jurisdictionLocality,
    hasContact: Boolean(reporterContactEmail || reporterContactPhone),
  });

  // 7. Redirect target
  const redirectTo = reporterUserId
    ? "/denuncias/mias"
    : `/denuncias/codigo/${referenceCode}?nueva=1`;

  return { ok: true, reportId, referenceCode, redirectTo };
}
