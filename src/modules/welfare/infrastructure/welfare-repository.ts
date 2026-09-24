// WelfareRepository — thin Drizzle wrapper for welfare_reports and
// welfare_report_attachments writes/reads.
//
// Design decisions:
//   - All write methods accept an optional `executor` param (DbOrTx) to
//     support both top-level calls and participation in a db.transaction().
//   - The 23505 collision retry loop lives here (repo concern: pg error code
//     detection is infra, not domain).
//   - Case ops route through CasesRepository / lib/case-helpers — NOT
//     reimplemented here.
//   - No auth logic — auth lives at the action / use-case edge.
//   - Reads return Drizzle row shapes ($inferSelect) — callers expect them.

import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";

import {
  auditLog,
  caseEvents,
  db,
  govtAssignments,
  notifications,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
  welfareReportAttachments,
  welfareReports,
} from "@/db";
import type {
  NewAuditLogRow,
  NewWelfareReport,
  WelfareReport,
  WelfareReportAttachment,
} from "@/db/schema";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validatedEventValues } from "@/lib/events/validated-event-values";
import { isUniqueViolation } from "@/lib/infra/db-errors";

/**
 * Printed in the MPF denuncia's "GENERADO POR" field when the exporting
 * account has no resolvable profile row.
 *
 * It used to read "Autoridad DIM" — the INTERNAL codename, signed onto a
 * document filed with the Unidad Fiscal de Maltrato Animal. Two problems, not
 * one: the codename leaked, AND the label asserted an identity the system did
 * not actually have. The replacement names the role (which IS known: only an
 * admin/govt account can reach this export) and admits the gap, matching the
 * document's own "Sin firma PKI" candour. The exporter's user id is recorded
 * in audit_log either way — the traceability is real, only the display name
 * is missing.
 */
export const UNRESOLVED_EXPORTER_LABEL = "Autoridad interviniente (identidad no disponible)";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

type InsertReportValues = Omit<NewWelfareReport, "id">;

type InsertAttachmentValues = Omit<
  typeof welfareReportAttachments.$inferInsert,
  "id" | "createdAt"
>;

type StatusPatch = {
  status?: WelfareReport["status"];
  triagedAt?: Date | null;
  triagedByUserId?: string | null;
  closedAt?: Date | null;
  resolutionNotes?: string | null;
  moderationResolvedAt?: Date | null;
  moderationResolvedByUserId?: string | null;
  moderationEscalatedAt?: Date | null;
  moderationEscalatedByUserId?: string | null;
};

type FlaggedPatch = {
  flaggedAt: Date;
  flagReasons: string[];
};

type MpfExportAuditRow = {
  id: string;
  payload: Record<string, unknown>;
  performedAt: Date;
};

// ---------------------------------------------------------------------------
// WelfareRepository
// ---------------------------------------------------------------------------

export class WelfareRepository {
  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Insert a welfare_reports row, retrying up to 5 times on a unique-violation
   * (pg 23505) against reference_code. On each retry the caller-supplied
   * `codeGenerator` function is called to produce a fresh candidate code.
   *
   * Throws with message "unique code" after 5 exhausted attempts.
   */
  async insertReportWithRetry(
    values: InsertReportValues,
    executor: DbOrTx = db,
    codeGenerator?: () => string,
  ): Promise<{ id: string; referenceCode: string }> {
    let currentValues = { ...values };
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      try {
        const [row] = await executor
          .insert(welfareReports)
          .values(currentValues)
          .returning({ id: welfareReports.id, referenceCode: welfareReports.referenceCode });
        return { id: row.id, referenceCode: row.referenceCode };
      } catch (err) {
        // drizzle 0.45 wraps pg errors; isUniqueViolation walks the `.cause`
        // chain to find the real SQLSTATE 23505.
        const isUnique = isUniqueViolation(err);
        if (isUnique && attempts < maxAttempts - 1 && codeGenerator) {
          currentValues = { ...currentValues, referenceCode: codeGenerator() };
          attempts++;
          continue;
        }
        if (isUnique) {
          throw new Error("No se pudo generar un código único para la denuncia. Probá de nuevo.");
        }
        throw err;
      }
    }

    // Unreachable but satisfies TypeScript control flow.
    throw new Error("No se pudo generar un código único para la denuncia. Probá de nuevo.");
  }

  /**
   * Insert welfare_report_attachments rows. Accepts any executor (db or tx).
   */
  async insertAttachments(rows: InsertAttachmentValues[], executor: DbOrTx = db): Promise<void> {
    if (rows.length === 0) return;
    await executor.insert(welfareReportAttachments).values(rows);
  }

  /**
   * Update the welfare_reports.case_id column to link a case.
   * Called after openCase() returns the new case row.
   */
  async linkCase(reportId: string, caseId: string, executor: DbOrTx = db): Promise<void> {
    await executor.update(welfareReports).set({ caseId }).where(eq(welfareReports.id, reportId));
  }

  /**
   * Apply a status patch (status, triagedAt/By, closedAt, resolutionNotes,
   * moderationResolved) to a welfare report.
   *
   * Returns the number of rows actually updated, so a caller can COMPARE AND
   * SWAP: pass `expectedStatus` and the UPDATE only lands while the report is
   * still in the state the caller validated. Zero means someone else moved it
   * first — the caller must abort rather than append an audit row for a
   * transition that did not happen.
   *
   * Every welfare status transition is validated by a read
   * (`findById` → `statusTransitionAllowed`) that happens BEFORE this write and
   * outside its transaction. Without the guard that gap is a plain TOCTOU: two
   * concurrent "Iniciar seguimiento" clicks both read `open`, both pass, and
   * both commit — two `welfare_report_started` rows in the audit trail of a
   * Ley 14.346 case, plus the reporter notified twice. audit_log has no unique
   * index that would have caught it (and cannot easily have one: the report id
   * lives in a JSONB payload, not a column).
   */
  async updateStatus(
    reportId: string,
    patch: StatusPatch,
    executor: DbOrTx = db,
    opts: { expectedStatus?: WelfareReport["status"] } = {},
  ): Promise<number> {
    const rows = await executor
      .update(welfareReports)
      .set(patch as Partial<typeof welfareReports.$inferInsert>)
      .where(
        opts.expectedStatus === undefined
          ? eq(welfareReports.id, reportId)
          : and(eq(welfareReports.id, reportId), eq(welfareReports.status, opts.expectedStatus)),
      )
      .returning({ id: welfareReports.id });
    return rows.length;
  }

  /**
   * Set the moderation flag (flaggedAt + flagReasons) on a report.
   * Called post-commit, best-effort — callers must catch errors.
   */
  async setFlagged(reportId: string, patch: FlaggedPatch, executor: DbOrTx = db): Promise<void> {
    await executor
      .update(welfareReports)
      .set({ flaggedAt: patch.flaggedAt, flagReasons: patch.flagReasons })
      .where(eq(welfareReports.id, reportId));
  }

  /**
   * Set (or clear) the assignee on a welfare report.
   * No tx required — single update, no audit_log (parity: assign/unassign
   * write no audit_log row, preserved here).
   */
  async setAssignee(reportId: string, userId: string | null): Promise<void> {
    await db
      .update(welfareReports)
      .set({ assignedToUserId: userId })
      .where(eq(welfareReports.id, reportId));
  }

  /**
   * Set the org intervention state on a welfare report (UI-7). Used by
   * takeDerivedReport. Does NOT touch the welfare status enum or derivation
   * columns — only org_intervention_status / org_intervention_at.
   */
  async setOrgIntervention(
    reportId: string,
    patch: { orgInterventionStatus: "tomado" | "devuelto" | null; orgInterventionAt: Date | null },
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(welfareReports)
      .set({
        orgInterventionStatus: patch.orgInterventionStatus,
        orgInterventionAt: patch.orgInterventionAt,
      })
      .where(eq(welfareReports.id, reportId));
  }

  /**
   * Return a derived welfare report to the gov queue (UI-7). Sets
   * org_intervention_status='devuelto' + org_intervention_at, and clears
   * derived_to_organization_id so the gov derivation panel shows it actionable
   * again. The return reason lives in a case_events note (caller responsibility).
   */
  async returnDerivation(
    reportId: string,
    patch: { orgInterventionAt: Date },
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor
      .update(welfareReports)
      .set({
        orgInterventionStatus: "devuelto",
        orgInterventionAt: patch.orgInterventionAt,
        derivedToOrganizationId: null,
      })
      .where(eq(welfareReports.id, reportId));
  }

  /**
   * Append an audit_log row. The actorUserId MUST correspond to an existing
   * profiles row (NOT NULL FK with RESTRICT on delete).
   */
  async insertAudit(
    values: Omit<NewAuditLogRow, "id" | "performedAt">,
    executor: DbOrTx = db,
  ): Promise<void> {
    await executor.insert(auditLog).values(values as NewAuditLogRow);
  }

  /**
   * Insert notification rows. Always called post-tx (best-effort);
   * callers must catch errors. Uses the top-level db (not a tx).
   */
  async insertNotifications(rows: (typeof notifications.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) return;
    await db.insert(notifications).values(rows);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Find a welfare report by its primary key. Returns null when not found.
   */
  async findById(reportId: string): Promise<WelfareReport | null> {
    const [row] = await db
      .select()
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Find a welfare report by its reference_code. Returns null when not found.
   */
  async findByReferenceCode(referenceCode: string): Promise<WelfareReport | null> {
    const [row] = await db
      .select()
      .from(welfareReports)
      .where(eq(welfareReports.referenceCode, referenceCode))
      .limit(1);
    return row ?? null;
  }

  /**
   * OA9 multi-source escalation: find open/triaged/in_progress welfare
   * cases for the same pet, excluding the case we're currently creating
   * (excludeCaseId). Called inside the same tx as the insert.
   *
   * Returns an array of { welfareReportId, caseId } tuples. The caller
   * uses these to insert a system note_added pet_event on the ORIGINAL case.
   */
  async findOpenOtherWelfareCasesForPet(
    petId: string,
    excludeCaseId: string | null,
    executor: DbOrTx = db,
  ): Promise<{ welfareReportId: string; caseId: string }[]> {
    const rows = await executor
      .select({
        welfareReportId: welfareReports.id,
        caseId: welfareReports.caseId,
      })
      .from(welfareReports)
      .where(
        and(
          eq(welfareReports.subjectPetId, petId),
          // Only open/triaged/in_progress — not terminal
          // Using ne() is simpler than an inArray for the open statuses
          ne(welfareReports.status, "closed"),
          ne(welfareReports.status, "invalid"),
          ne(welfareReports.status, "duplicate"),
          // Must have a linked case to escalate on
          // (reports pre-dating cases system have caseId = null)
          ...(excludeCaseId ? [ne(welfareReports.caseId, excludeCaseId)] : []),
        ),
      );

    // Filter out rows without a caseId (pre-cases-system reports)
    return rows.filter((r): r is { welfareReportId: string; caseId: string } => r.caseId != null);
  }

  /**
   * Idempotency lookup for generateMpfExport: find the most recent
   * audit_log row of type `welfare_mpf_export_generated` for this report
   * within the last `sinceMs` milliseconds. Returns null when none exists.
   */
  async findRecentMpfExport(
    welfareReportId: string,
    sinceMs: number,
  ): Promise<MpfExportAuditRow | null> {
    const since = new Date(Date.now() - sinceMs);
    const rows = await db
      .select({
        id: auditLog.id,
        payload: auditLog.payload,
        performedAt: auditLog.performedAt,
      })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "welfare_mpf_export_generated"), gte(auditLog.performedAt, since)),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(10); // limit then filter — no JSON index on payload

    const match = rows.find(
      (r) =>
        typeof r.payload === "object" &&
        r.payload !== null &&
        (r.payload as Record<string, unknown>).welfareReportId === welfareReportId,
    );

    if (!match) return null;
    return {
      id: match.id,
      payload: match.payload as Record<string, unknown>,
      performedAt: match.performedAt,
    };
  }

  /**
   * Return all attachment rows for a welfare report.
   */
  async findAttachments(welfareReportId: string): Promise<WelfareReportAttachment[]> {
    return db
      .select()
      .from(welfareReportAttachments)
      .where(eq(welfareReportAttachments.welfareReportId, welfareReportId));
  }

  /**
   * Return the reporter's display name for MPF export.
   * Returns null when the report is anonymous (reporterUserId is null) or the
   * profile row is not found.
   */
  async findReporterName(reporterUserId: string | null): Promise<string | null> {
    if (!reporterUserId) return null;
    const [row] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, reporterUserId))
      .limit(1);
    return row?.displayName ?? null;
  }

  /**
   * Return the exporter's display name for MPF export.
   * Falls back to UNRESOLVED_EXPORTER_LABEL when the profile row is not found.
   */
  async findExporterName(exporterUserId: string): Promise<string> {
    const [row] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, exporterUserId))
      .limit(1);
    return row?.displayName ?? UNRESOLVED_EXPORTER_LABEL;
  }

  /**
   * Return minimal subject pet info (name + microchipId) for MPF export.
   * microchipId is sourced from the canonical pet_identifications table
   * (kind='microchip_iso', status='active') via a single LEFT JOIN.
   * Returns null when the report has no subjectPetId or the pet row is not found.
   */
  async findSubjectPet(
    subjectPetId: string | null,
  ): Promise<{ name: string; microchipId: string | null } | null> {
    if (!subjectPetId) return null;
    const [row] = await db
      .select({
        name: pets.name,
        microchipId: petIdentifications.code,
      })
      .from(pets)
      .leftJoin(
        petIdentifications,
        and(
          eq(petIdentifications.petId, pets.id),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.status, "active"),
        ),
      )
      .where(eq(pets.id, subjectPetId))
      .limit(1);
    if (!row) return null;
    return { name: row.name, microchipId: row.microchipId ?? null };
  }

  /**
   * Find a pet by its publicToken. Returns { id } when found, null otherwise.
   * Used by create-welfare-report / create-org-welfare-report to resolve
   * subjectPetToken → subjectPetId before the insert tx.
   */
  async findPetByToken(
    publicToken: string,
  ): Promise<{ id: string; seedTag: string | null } | null> {
    const [row] = await db
      .select({ id: pets.id, seedTag: pets.seedTag })
      .from(pets)
      .where(eq(pets.publicToken, publicToken))
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert a case_events row. Used by addReporterComment and any future
   * welfare-domain use-cases that write pet-independent case timeline entries.
   */
  async insertCaseEvent(
    values: {
      caseId: string;
      entryType: string;
      payload: Record<string, unknown>;
      notes?: string | null;
      recordedByUserId?: string | null;
      occurredAt?: Date;
    },
    executor: DbOrTx = db,
  ): Promise<{ id: string }> {
    const [row] = await executor
      .insert(caseEvents)
      .values({
        caseId: values.caseId,
        entryType: values.entryType,
        payload: values.payload,
        notes: values.notes ?? null,
        recordedByUserId: values.recordedByUserId ?? null,
        occurredAt: values.occurredAt ?? new Date(),
      })
      .returning({ id: caseEvents.id });
    if (!row) throw new Error("WelfareRepository.insertCaseEvent: insert returned no rows");
    return row;
  }

  /**
   * Check whether a user holds an active ownership of a pet (endedAt IS NULL).
   * Returns { id } when found (truthy), null when not.
   * Used to derive reporterRole (owner vs. witness) in create-welfare-report.
   */
  async findActiveOwnership(petId: string, userId: string): Promise<{ id: string } | null> {
    const [row] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, userId),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Return the user IDs of all active institutional admins (role=admin,
   * accountType=institutional, deactivatedAt IS NULL).
   * Used by create-org-welfare-report for OA4 fan-out notifications.
   * Accepts an optional executor so it can run inside the same tx.
   */
  async findInstitutionalAdmins(executor: DbOrTx = db): Promise<string[]> {
    const rows = await executor
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          eq(profiles.role, "admin"),
          eq(profiles.accountType, "institutional"),
          isNull(profiles.deactivatedAt),
        ),
      );
    return rows.map((r) => r.id);
  }

  /**
   * Insert a pet_event row. Accepts any executor (db or tx).
   * Used by create-welfare-report and create-org-welfare-report for the
   * pet-event bridge (abandonment_reported, maltreatment_reported,
   * symptom_observed, note_added).
   *
   * The payload is validated against the per-type Zod schema at this boundary
   * — an invalid payload throws EventPayloadValidationError before any row is
   * written (event-sourcing integrity review 2026-07-04 item 2).
   */
  async insertPetEvent(
    values: typeof petEvents.$inferInsert,
    executor: DbOrTx = db,
  ): Promise<void> {
    const validated = validatedEventValues(values);
    await executor.insert(petEvents).values(validated);
  }

  /**
   * Insert a pet event with idempotency-key deduplication.
   * Routes through insertEventIdempotent from lib/event-idempotency.
   * When clientIdempotencyKey is null/undefined, falls back to a plain insert.
   * Returns { wasNoop: true } when a conflict was detected (duplicate submission).
   *
   * The payload is validated inside the shared helper (validatedEventValues,
   * finding A08-7) — same contract as insertPetEvent above.
   */
  async insertPetEventIdempotent(
    values: typeof petEvents.$inferInsert,
    executor: DbOrTx = db,
  ): Promise<{ wasNoop: boolean }> {
    const { wasNoop } = await insertEventIdempotent(
      values,
      executor as Parameters<typeof insertEventIdempotent>[1],
    );
    return { wasNoop };
  }

  /**
   * Return all active (non-revoked) govt jurisdiction rows for `userId`.
   * Empty array for admins (callers use universal scope) or users with no
   * active assignments.
   *
   * Extracted from get-active-govt-scope.ts to keep the application layer
   * free of direct Drizzle / @/db imports (hexagonal purity).
   */
  async findGovtScopeForUser(
    userId: string,
  ): Promise<Array<{ province: string; locality: string }>> {
    const rows = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .innerJoin(profiles, eq(profiles.id, govtAssignments.userId))
      .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
    return rows;
  }
}
