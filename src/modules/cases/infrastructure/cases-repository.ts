// CasesRepository — Drizzle wrapper for all cases write operations.
// Wraps the same DB logic as lib/case-helpers.ts with identical parity quirks:
//   - closeCase/escalateCase idempotency: already-closed/merged → return existing
//   - public_code generator uses the SAME executor as the insert
//   - reopenCase runs on db ONLY (no tx param) — preserved exactly
//   - All methods accept optional tx for atomicity with caller's pet_event
//
// Returns Drizzle Case rows — callers already type them as Case.
// No auth logic — auth lives at the action / use-case edge.

import { and, eq, inArray, notInArray } from "drizzle-orm";

import { type Case, type NewCase, cases, db } from "@/db";
import { generatePrefixedToken } from "@/lib/infra/publicToken";
import type { CaseKind } from "@/src/modules/cases/domain/case-kinds";
import type { OpenedReason, OpenedReasonAudit } from "@/src/modules/cases/domain/opened-reason";
import { openedReasonProse } from "@/src/modules/cases/domain/opened-reason-prose";

// ---------------------------------------------------------------------------
// Type aliases (matching lib/case-helpers.ts exactly)
// ---------------------------------------------------------------------------

type CaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

const MAX_CODE_RETRIES = 5;

// ---------------------------------------------------------------------------
// OpenCaseInput (byte-identical interface to lib/case-helpers.ts)
// ---------------------------------------------------------------------------

export interface OpenCaseInput {
  kind: CaseKind;
  primarySubjectKind: "registered_pet" | "unowned_animal" | "location" | "general";
  primaryPetId?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  applicantUserId?: string | null;
  jurisdictionCountry?: string;
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
  /** Structural locality-attribution FK (migration 0147): ar_localities uuid PK. */
  localityId?: string | null;
  openedByUserId?: string | null;
  openedByOrganizationId?: string | null;
  /** custody_transfer_handshake only: canonical receiver org id. */
  receiverOrganizationId?: string | null;
  /**
   * Why this case is being opened. THE FENCE.
   *
   * A closed union, so a writer cannot invent a reason or pass a bare string:
   * both are `tsc` errors here, at the write boundary, before any row exists.
   * That is the whole point of this type — transfer-custody.ts passed a
   * template string for months and nothing caught it.
   *
   * Writing dual-writes: byte-identical legacy prose into `opened_reason`
   * (>= 10 chars, satisfying the CHECK) PLUS the code and params. See
   * resolveOpenedReasonColumns.
   */
  openedReason: OpenedReason;
  /**
   * Internal ids that belong in the AUDIT prose but must never reach
   * `opened_reason_params`. Only the three writers whose prose embeds a UUID
   * need this (foster_proposal_sent, pet_marked_lost, microchip_replaced).
   */
  openedReasonAudit?: OpenedReasonAudit;
  welfareReportId?: string | null;
  adoptionApplicationId?: string | null;
  custodyDisputeId?: string | null;
  parentListingCaseId?: string | null;
}

/**
 * Decide the three `opened_reason*` columns for a case-open.
 *
 * Pure and exported so the dual-write contract is testable without a DB — it
 * is the single most consequential decision in the case-open path.
 *
 * A structured reason writes BOTH representations, and the prose it writes is
 * byte-identical to what the writer emitted before the cutover. That is
 * load-bearing: `opened_reason` is still a live SQL query key (outbreak dedupe
 * runs `LIKE 'manual [code]:%'` against it), and identical prose means both
 * cohorts match one query and a rollback renders every row correctly.
 */
export function resolveOpenedReasonColumns(
  openedReason: OpenedReason,
  audit: OpenedReasonAudit = {},
): { openedReason: string; openedReasonCode: string; openedReasonParams: unknown } {
  const { code, ...params } = openedReason;
  return {
    openedReason: openedReasonProse(openedReason, audit),
    openedReasonCode: code,
    // `{}` rather than null for param-less codes: the pair CHECK
    // (cases_opened_reason_structured_pair) makes "code without params"
    // unrepresentable at rest.
    openedReasonParams: params,
  };
}

export interface CloseCaseInput {
  caseId: string;
  reason: "resolved" | "cancelled" | "auto_expired";
  closedByUserId?: string | null;
}

// ---------------------------------------------------------------------------
// CasesRepository
// ---------------------------------------------------------------------------

export class CasesRepository {
  // -------------------------------------------------------------------------
  // public_code generator (CAS-XXXX-XXXX)
  // -------------------------------------------------------------------------

  /**
   * Allocate a new unique CAS-XXXX-XXXX code. Retries on the very rare
   * collision with the unique index. The base entropy is ~8.5e11 — five
   * retries is plenty.
   *
   * Accepts an optional executor so it can run inside a transaction
   * alongside the `cases` INSERT it's about to feed.
   */
  async generateUniqueCasePublicCode(executor: CaseExecutor = db): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
      const candidate = generatePrefixedToken("CAS");
      const [existing] = await executor
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.publicCode, candidate))
        .limit(1);
      if (!existing) return candidate;
    }
    throw new Error("generateUniqueCasePublicCode: exhausted retries");
  }

  // -------------------------------------------------------------------------
  // openCase
  // -------------------------------------------------------------------------

  /**
   * Insert a new case row. Throws if the insert would violate any
   * CHECK constraint (opened_reason length, subject consistency, etc.).
   * The caller is responsible for picking an appropriate kind and for
   * setting up the jurisdiction from the subject pet (or the location).
   *
   * Pass `executor` (the tx from `db.transaction`) to land the case row
   * atomically with the triggering pet_event in the same transaction.
   */
  async openCase(input: OpenCaseInput, executor: CaseExecutor = db): Promise<Case> {
    const publicCode = await this.generateUniqueCasePublicCode(executor);
    const values: NewCase = {
      publicCode,
      caseKind: input.kind,
      status: "open",
      primarySubjectKind: input.primarySubjectKind,
      primaryPetId: input.primaryPetId ?? null,
      // Canonical write (P3 Phase C). Legacy primary_location_lat/lng dropped in 0102.
      // cases_subject_location_consistency now references location_lat/lng directly.
      locationLat: input.locationLat ?? null,
      locationLng: input.locationLng ?? null,
      applicantUserId: input.applicantUserId ?? null,
      jurisdictionCountry: input.jurisdictionCountry ?? "AR",
      jurisdictionProvince: input.jurisdictionProvince ?? null,
      jurisdictionLocality: input.jurisdictionLocality ?? null,
      localityId: input.localityId ?? null,
      openedByUserId: input.openedByUserId ?? null,
      openedByOrganizationId: input.openedByOrganizationId ?? null,
      receiverOrganizationId: input.receiverOrganizationId ?? null,
      ...resolveOpenedReasonColumns(input.openedReason, input.openedReasonAudit),
      welfareReportId: input.welfareReportId ?? null,
      adoptionApplicationId: input.adoptionApplicationId ?? null,
      custodyDisputeId: input.custodyDisputeId ?? null,
      parentListingCaseId: input.parentListingCaseId ?? null,
    };
    const [row] = await executor.insert(cases).values(values).returning();
    return row;
  }

  // -------------------------------------------------------------------------
  // closeCase
  // -------------------------------------------------------------------------

  /**
   * UPDATE `cases` setting status='closed', closed_reason, closed_at,
   * closed_by_user_id. Idempotent: closing an already-closed case is a
   * no-op (returns the existing row).
   *
   * Concurrency: the terminal-status guard is folded INTO the UPDATE's WHERE
   * (`status NOT IN ('closed','merged')`) rather than living only in the
   * pre-read above. Two concurrent closers can both pass the pre-read (both
   * see "open"); without the predicate on the UPDATE itself both would write,
   * clobbering the true closer's reason/actor and letting each caller believe
   * it won the close (duplicate downstream effects). With the predicate, only
   * the first committer's UPDATE matches a row — the loser's UPDATE matches
   * zero rows, and we re-read to return the now-closed row so the result stays
   * idempotent while signalling (empty rowcount) that this call did NOT close it.
   */
  async closeCase(input: CloseCaseInput, executor: CaseExecutor = db): Promise<Case | null> {
    const [existing] = await executor
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .limit(1);
    if (!existing) return null;
    if (existing.status === "closed" || existing.status === "merged") {
      return existing;
    }
    const updatedRows = await executor
      .update(cases)
      .set({
        status: "closed",
        closedReason: input.reason,
        closedAt: new Date(),
        closedByUserId: input.closedByUserId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, input.caseId), notInArray(cases.status, ["closed", "merged"])))
      .returning();
    if (updatedRows.length === 0) {
      // Lost the race: another closer committed between our pre-read and this
      // UPDATE. Re-read and return the now-closed row (idempotent), but this
      // caller is NOT the winner and must not run close-dependent downstream.
      const [current] = await executor
        .select()
        .from(cases)
        .where(eq(cases.id, input.caseId))
        .limit(1);
      return current ?? null;
    }
    return updatedRows[0];
  }

  /**
   * `closeCase`, pero diciendo si ESTE llamador fue el que cerró.
   *
   * POR QUÉ EXISTE (2026-08-10). `closeCase` resuelve la carrera bien — el
   * guard va dentro del WHERE del UPDATE, así que sólo el primero escribe — y su
   * propio comentario advierte que "this caller is NOT the winner and must not
   * run close-dependent downstream". Pero devuelve `Case | null` en los dos
   * casos: ganador y perdedor reciben una fila cerrada, indistinguibles.
   *
   * Con efectos secundarios idempotentes eso alcanza, y por eso los ~12
   * llamadores existentes están bien. No alcanza cuando el efecto es un evento
   * en `case_events`, que es **append-only por trigger**: el perdedor insertaría
   * un segundo `case_closed` con otro motivo y otro actor, imposible de borrar o
   * corregir, mientras `closed_by_user_id` guarda sólo al primero. El expediente
   * terminaría contando dos cierres de un caso que se cerró una vez.
   *
   * Método nuevo en vez de cambiar la firma: los llamadores existentes no
   * necesitan esto y tocarlos sería mover doce sitios para ganar nada.
   */
  async closeCaseOwned(
    input: CloseCaseInput,
    executor: CaseExecutor = db,
  ): Promise<{ won: boolean; case: Case | null }> {
    const [existing] = await executor
      .select()
      .from(cases)
      .where(eq(cases.id, input.caseId))
      .limit(1);
    if (!existing) return { won: false, case: null };
    if (existing.status === "closed" || existing.status === "merged") {
      return { won: false, case: existing };
    }

    const updatedRows = await executor
      .update(cases)
      .set({
        status: "closed",
        closedReason: input.reason,
        closedAt: new Date(),
        closedByUserId: input.closedByUserId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(cases.id, input.caseId), notInArray(cases.status, ["closed", "merged"])))
      .returning();

    if (updatedRows.length === 0) {
      const [current] = await executor
        .select()
        .from(cases)
        .where(eq(cases.id, input.caseId))
        .limit(1);
      return { won: false, case: current ?? null };
    }
    return { won: true, case: updatedRows[0] };
  }

  // -------------------------------------------------------------------------
  // escalateCase
  // -------------------------------------------------------------------------

  /**
   * UPDATE `cases` setting status='escalated'. Only acts when the current
   * status is 'open'. Idempotent: already-escalated or non-open cases are
   * returned unchanged.
   *
   * Pass `executor` (the tx from `db.transaction`) to run escalation
   * atomically with the associated case_event insert and audit row in the
   * same transaction.
   */
  async escalateCase(caseId: string, executor: CaseExecutor = db): Promise<Case | null> {
    const [existing] = await executor.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!existing) return null;
    if (existing.status !== "open") return existing;
    const [updated] = await executor
      .update(cases)
      .set({ status: "escalated", updatedAt: new Date() })
      .where(eq(cases.id, caseId))
      .returning();
    return updated;
  }

  // -------------------------------------------------------------------------
  // reopenCase — only used by adoption_reversed (L4)
  // -------------------------------------------------------------------------

  /**
   * UPDATE `cases` setting status='open', clearing closed fields.
   * Runs on `db` ONLY — no tx param (preserved from lib/case-helpers exactly).
   * Idempotent: already-open case returns the existing row.
   */
  async reopenCase(caseId: string): Promise<Case | null> {
    const [existing] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!existing) return null;
    if (existing.status === "open") return existing;
    const [updated] = await db
      .update(cases)
      .set({
        status: "open",
        closedReason: null,
        closedAt: null,
        closedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId))
      .returning();
    return updated;
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Open cases for a pet. Used by `decideAttachment` to know what to
   * attach a new event to. Caps at 50 because a pet with more than that
   * would already be in trouble.
   */
  async findOpenCasesForPet(petId: string): Promise<Array<{ id: string; caseKind: CaseKind }>> {
    const rows = await db
      .select({ id: cases.id, caseKind: cases.caseKind })
      .from(cases)
      .where(and(eq(cases.primaryPetId, petId), inArray(cases.status, ["open", "escalated"])))
      .limit(50);
    return rows as Array<{ id: string; caseKind: CaseKind }>;
  }

  /**
   * One open case for (pet, kind). Returns null when none. The partial
   * unique index in the schema guarantees at most one match for
   * non-multi-applicant kinds.
   */
  async findOpenCaseForPetAndKind(
    petId: string,
    kind: CaseKind,
    executor: CaseExecutor = db,
  ): Promise<Case | null> {
    const [row] = await executor
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, kind),
          inArray(cases.status, ["open", "escalated"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * For adoption_application — finds an open case for (pet, kind, applicant).
   * Returns null when none. Scoped per applicant: the partial unique index
   * `cases_open_adoption_app_per_applicant_idx` allows one open
   * adoption_application case PER (pet, applicant) — multiple applicants may
   * each have their own concurrent open case for the same pet.
   *
   * Pass `executor` (the tx from `db.transaction`) so the lookup participates
   * in the same transaction as the caller's pet_event insert.
   */
  async findOpenAdoptionApplicationCase(
    petId: string,
    applicantUserId: string,
    executor: CaseExecutor = db,
  ): Promise<Case | null> {
    const [row] = await executor
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "adoption_application"),
          eq(cases.applicantUserId, applicantUserId),
          inArray(cases.status, ["open", "escalated"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * For adoption_listing — finds an open case for (pet, kind, org).
   *
   * Pass `executor` (the tx from `db.transaction`) so the lookup participates
   * in the same transaction as the caller's pet_event insert.
   */
  async findOpenAdoptionListingCase(
    petId: string,
    orgId: string,
    executor: CaseExecutor = db,
  ): Promise<Case | null> {
    const [row] = await executor
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "adoption_listing"),
          eq(cases.openedByOrganizationId, orgId),
          inArray(cases.status, ["open", "escalated"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
