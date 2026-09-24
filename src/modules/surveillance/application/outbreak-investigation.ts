// Use-cases: outbreak investigation open/note/escalate/close (spec §H, §I).
//
// Migrated from app/actions/outbreak-investigation.ts.
// Auth (requireAdminOrGovtOrRedirect) handled by caller (actions.ts).
//
// CRITICAL auth scope (spec §I):
//   - isInScope: national case (no province) → any govt; else province match AND
//     (no locality OR locality match). admin = universal.
//   - All 4 actions enforce isInScope for govt actors — REJECT out-of-jurisdiction.
//
// AUDIT_LOG: All 4 actions write inside tx with v1_noop:true (where applicable).
//
// Legal frame: Ley 15.465/60 + Decreto 3640/64.
// External notification (SNVS/SENASA/zoonosis) NOT integrated — v1_noop=true.

import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import { isEnoCode } from "../domain/eno-catalog";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InvestigationNoteEntryType =
  | "classification"
  | "lab_result"
  | "control_action"
  | "contact_tracing"
  | "final_report"
  | "external_notification"
  | "system";

type Actor = {
  profile: { id: string; role: "admin" | "govt" };
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
};

type CaseRow = {
  id: string;
  publicCode: string;
  status: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedReason: string | null;
};

export type OutbreakInvestigationDeps = {
  repo: Pick<
    SurveillanceRepository,
    | "findOpenInvestigationsForDisease"
    | "findInvestigationByCode"
    | "findFinalReport"
    | "insertCaseEvent"
    | "insertOutbreakAuditLog"
  >;
  openCase: (
    input: {
      kind: string;
      primarySubjectKind: string;
      primaryPetId: null;
      jurisdictionCountry: string;
      jurisdictionProvince: string | null;
      jurisdictionLocality: string | null;
      openedByUserId: string;
      openedReason: OpenedReason;
    },
    tx: unknown,
  ) => Promise<{ id: string; publicCode: string }>;
  closeCase: (
    input: { caseId: string; reason: "resolved" | "cancelled"; closedByUserId: string },
    tx: unknown,
  ) => Promise<void>;
  escalateCase: (caseId: string, tx: unknown) => Promise<void>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  notifyOutbreakOpened: (args: {
    casePublicCode: string;
    caseId: string;
    diseaseCode: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    openedByUserId: string;
  }) => Promise<void>;
  revalidate: (path: string) => void;
};

// ---------------------------------------------------------------------------
// Shared scope guard — mirrors original app/actions/outbreak-investigation.ts
// ---------------------------------------------------------------------------

/**
 * Exported for tests ONLY — production callers are the four actions below.
 *
 * It is exported because __tests__/jurisdiction-subsumption-class.test.ts used
 * to lock this rule against a hand-written COPY of the predicate pasted into
 * the test file: the copy could stay green while this function drifted, which
 * is the opposite of what an authorization-scope test is for (audit 2026-08-12).
 * A guard worth testing is worth importing.
 */
export function isInScope(
  caseRow: {
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  },
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>,
): boolean {
  // National-scope case (no province) — any govt may act.
  if (!caseRow.jurisdictionProvince) return true;
  // Located case: province must match, and the operator must cover the case's
  // locality. Subsumption-aware — a whole-province assignment (e.g. whole-CABA)
  // covers every barrio in it, so a case tagged to a barrio is in scope. A case
  // with no locality (province-wide) matches any operator in that province.
  return jurisdictions.some(
    (j) =>
      j.province === caseRow.jurisdictionProvince &&
      (!caseRow.jurisdictionLocality ||
        isWholeProvinceLocality(j.province, j.locality) ||
        j.locality === caseRow.jurisdictionLocality),
  );
}

// ---------------------------------------------------------------------------
// openOutbreakInvestigation (spec §H)
// ---------------------------------------------------------------------------

export type OpenOutbreakInvestigationInput = {
  diseaseCode: string;
  reason: string;
  linkedSignalEventId?: string | null;
  actor: Actor;
};

export type OpenOutbreakInvestigationResult = UseCaseResult<{ publicCode: string }>;

export async function openOutbreakInvestigation(
  input: OpenOutbreakInvestigationInput,
  deps: OutbreakInvestigationDeps,
): Promise<OpenOutbreakInvestigationResult> {
  const { repo, transaction, notifyOutbreakOpened, revalidate } = deps;
  const { actor } = input;

  // 1. Validate disease code.
  const diseaseCode = input.diseaseCode?.trim();
  if (!diseaseCode || !isEnoCode(diseaseCode)) {
    return { ok: false, error: "El código de enfermedad no está en el catálogo ENO." };
  }

  // 2. Validate reason.
  if (!input.reason?.trim() || input.reason.trim().length < 10) {
    return { ok: false, error: "El motivo debe tener al menos 10 caracteres." };
  }

  // 3. Resolve jurisdiction.
  let jurisdictionProvince: string | null = null;
  let jurisdictionLocality: string | null = null;

  if (actor.profile.role === "govt") {
    if (actor.jurisdictions.length === 0) {
      return {
        ok: false,
        error: "No tenés jurisdicciones activas asignadas. Contactá al administrador.",
      };
    }
    jurisdictionProvince = actor.jurisdictions[0].province;
    jurisdictionLocality = actor.jurisdictions[0].locality;
  }

  // 4. Dedupe check.
  const openedReasonPrefix = `manual [${diseaseCode}]:`;
  const existing = await repo.findOpenInvestigationsForDisease(
    diseaseCode,
    jurisdictionProvince,
    jurisdictionLocality,
  );
  const duplicate = existing.find((r) =>
    (r as unknown as CaseRow).openedReason?.startsWith(openedReasonPrefix),
  );
  if (duplicate) {
    return {
      ok: false,
      error: `Ya existe una investigación abierta para ${diseaseCode} en esta jurisdicción (${duplicate.publicCode}).`,
    };
  }

  // The prose this produces is byte-identical to the pre-cutover template —
  // `openedReasonPrefix` above and surveillance-repository's LIKE both depend
  // on it. See opened-reason-prose.ts.
  const openedReason: OpenedReason = {
    code: "outbreak_investigation_manual",
    diseaseCode,
    note: input.reason.trim(),
  };
  let createdPublicCode = "";

  try {
    await transaction(async (tx) => {
      const caseRow = await deps.openCase(
        {
          kind: "outbreak_investigation",
          primarySubjectKind: "general",
          primaryPetId: null,
          jurisdictionCountry: "AR",
          jurisdictionProvince,
          jurisdictionLocality,
          openedByUserId: actor.profile.id,
          openedReason,
        },
        tx,
      );
      createdPublicCode = caseRow.publicCode;

      await repo.insertCaseEvent(
        {
          caseId: caseRow.id,
          entryType: "case_opened",
          recordedByUserId: actor.profile.id,
          payload: {
            disease_code: diseaseCode,
            reason: input.reason.trim(),
            linked_signal_event_id: input.linkedSignalEventId ?? null,
          },
          notes: input.linkedSignalEventId
            ? `Signal vinculada: ${input.linkedSignalEventId}`
            : null,
        },
        tx as Parameters<typeof repo.insertCaseEvent>[1],
      );

      if (input.linkedSignalEventId?.trim()) {
        await repo.insertCaseEvent(
          {
            caseId: caseRow.id,
            entryType: "signal_link",
            recordedByUserId: actor.profile.id,
            payload: { signal_event_id: input.linkedSignalEventId.trim() },
            notes: "Señal epidemiológica vinculada al abrir la investigación.",
          },
          tx as Parameters<typeof repo.insertCaseEvent>[1],
        );
      }

      await repo.insertOutbreakAuditLog(
        {
          actorUserId: actor.profile.id,
          action: "outbreak_investigation_opened",
          payload: {
            case_id: caseRow.id,
            case_public_code: caseRow.publicCode,
            disease_code: diseaseCode,
            jurisdiction_province: jurisdictionProvince,
            jurisdiction_locality: jurisdictionLocality,
            linked_signal_event_id: input.linkedSignalEventId ?? null,
            v1_noop: true,
          },
        },
        tx as Parameters<typeof repo.insertOutbreakAuditLog>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo abrir la investigación: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // Post-tx best-effort notification.
  notifyOutbreakOpened({
    casePublicCode: createdPublicCode,
    caseId: createdPublicCode,
    diseaseCode,
    jurisdictionProvince,
    jurisdictionLocality,
    openedByUserId: actor.profile.id,
  }).catch(() => undefined);

  revalidate("/gob/vigilancia/investigaciones");

  return { ok: true, value: { publicCode: createdPublicCode }, notifications: [] };
}

// ---------------------------------------------------------------------------
// addInvestigationNote (spec §I)
// ---------------------------------------------------------------------------

export type AddInvestigationNoteInput = {
  casePublicCode: string;
  entryType: InvestigationNoteEntryType;
  notes: string;
  payload?: Record<string, unknown>;
  actor: Actor;
};

export type AddInvestigationNoteResult = UseCaseResult<void>;

export async function addInvestigationNote(
  input: AddInvestigationNoteInput,
  deps: OutbreakInvestigationDeps,
): Promise<AddInvestigationNoteResult> {
  const { repo, transaction, revalidate } = deps;
  const { actor } = input;

  // 1. Validate notes length.
  if (!input.notes?.trim() || input.notes.trim().length < 5) {
    return { ok: false, error: "La nota debe tener al menos 5 caracteres." };
  }

  // 2. Load case.
  const caseRow = await repo.findInvestigationByCode(input.casePublicCode);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.status === "closed") {
    return { ok: false, error: "No se pueden agregar notas a una investigación cerrada." };
  }

  // 3. Scope check.
  if (actor.profile.role === "govt") {
    if (!isInScope(caseRow, actor.jurisdictions)) {
      return { ok: false, error: "Esta investigación no está en tu jurisdicción." };
    }
  }

  try {
    await transaction(async (tx) => {
      await repo.insertCaseEvent(
        {
          caseId: caseRow.id,
          entryType: input.entryType,
          recordedByUserId: actor.profile.id,
          payload: input.payload ?? {},
          notes: input.notes.trim(),
        },
        tx as Parameters<typeof repo.insertCaseEvent>[1],
      );

      await repo.insertOutbreakAuditLog(
        {
          actorUserId: actor.profile.id,
          action: "outbreak_investigation_note_added",
          payload: {
            case_id: caseRow.id,
            case_public_code: input.casePublicCode,
            entry_type: input.entryType,
          },
        },
        tx as Parameters<typeof repo.insertOutbreakAuditLog>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo guardar la nota: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  revalidate(`/gob/vigilancia/investigaciones/${input.casePublicCode}`);

  return { ok: true, value: undefined, notifications: [] };
}

// ---------------------------------------------------------------------------
// escalateInvestigation (spec §I)
// ---------------------------------------------------------------------------

export type EscalateInvestigationInput = {
  casePublicCode: string;
  reason: string;
  actor: Actor;
};

export type EscalateInvestigationResult = UseCaseResult<void>;

export async function escalateInvestigation(
  input: EscalateInvestigationInput,
  deps: OutbreakInvestigationDeps,
): Promise<EscalateInvestigationResult> {
  const { repo, transaction, revalidate } = deps;
  const { actor } = input;

  // 1. Validate reason.
  if (!input.reason?.trim() || input.reason.trim().length < 10) {
    return { ok: false, error: "El motivo de escalada debe tener al menos 10 caracteres." };
  }

  // 2. Load case.
  const caseRow = await repo.findInvestigationByCode(input.casePublicCode);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.status !== "open") {
    return { ok: false, error: "Solo se pueden escalar investigaciones en estado abierto." };
  }

  // 3. Scope check.
  if (actor.profile.role === "govt") {
    if (!isInScope(caseRow, actor.jurisdictions)) {
      return { ok: false, error: "Esta investigación no está en tu jurisdicción." };
    }
  }

  try {
    await transaction(async (tx) => {
      await deps.escalateCase(caseRow.id, tx);

      await repo.insertCaseEvent(
        {
          caseId: caseRow.id,
          entryType: "case_escalated",
          recordedByUserId: actor.profile.id,
          payload: { reason: input.reason.trim() },
          notes: input.reason.trim(),
        },
        tx as Parameters<typeof repo.insertCaseEvent>[1],
      );

      await repo.insertOutbreakAuditLog(
        {
          actorUserId: actor.profile.id,
          action: "outbreak_investigation_escalated",
          payload: {
            case_id: caseRow.id,
            case_public_code: input.casePublicCode,
            reason: input.reason.trim(),
          },
        },
        tx as Parameters<typeof repo.insertOutbreakAuditLog>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo escalar la investigación: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  revalidate(`/gob/vigilancia/investigaciones/${input.casePublicCode}`);
  revalidate("/gob/vigilancia/investigaciones");

  return { ok: true, value: undefined, notifications: [] };
}

// ---------------------------------------------------------------------------
// closeInvestigation (spec §I)
// ---------------------------------------------------------------------------

export type CloseInvestigationInput = {
  casePublicCode: string;
  outcome: "resolved" | "dismissed";
  reason: string;
  finalReportText?: string | null;
  actor: Actor;
};

export type CloseInvestigationResult = UseCaseResult<void>;

export async function closeInvestigation(
  input: CloseInvestigationInput,
  deps: OutbreakInvestigationDeps,
): Promise<CloseInvestigationResult> {
  const { repo, transaction, revalidate } = deps;
  const { actor } = input;

  // 1. Validate reason.
  if (!input.reason?.trim() || input.reason.trim().length < 10) {
    return { ok: false, error: "El motivo de cierre debe tener al menos 10 caracteres." };
  }

  // 2. Load case.
  const caseRow = await repo.findInvestigationByCode(input.casePublicCode);
  if (!caseRow) return { ok: false, error: "Caso no encontrado." };
  if (caseRow.status === "closed") {
    return { ok: false, error: "Esta investigación ya está cerrada." };
  }

  // 3. Scope check.
  if (actor.profile.role === "govt") {
    if (!isInScope(caseRow, actor.jurisdictions)) {
      return { ok: false, error: "Esta investigación no está en tu jurisdicción." };
    }
  }

  // 4. Resolved outcome requires final report.
  if (input.outcome === "resolved") {
    const hasFinalReport = await repo.findFinalReport(caseRow.id);
    if (!hasFinalReport && !input.finalReportText?.trim()) {
      return {
        ok: false,
        error:
          "Para cerrar como resuelta, registrá primero un informe epidemiológico final (o ingresá el texto del informe en este formulario).",
      };
    }
  }

  const auditAction =
    input.outcome === "resolved"
      ? "outbreak_investigation_closed_resolved"
      : "outbreak_investigation_closed_dismissed";

  try {
    await transaction(async (tx) => {
      if (input.outcome === "resolved" && input.finalReportText?.trim()) {
        await repo.insertCaseEvent(
          {
            caseId: caseRow.id,
            entryType: "final_report",
            recordedByUserId: actor.profile.id,
            payload: { inline: true },
            notes: input.finalReportText.trim(),
          },
          tx as Parameters<typeof repo.insertCaseEvent>[1],
        );
      }

      await repo.insertCaseEvent(
        {
          caseId: caseRow.id,
          entryType: "case_closed",
          recordedByUserId: actor.profile.id,
          payload: { outcome: input.outcome, reason: input.reason.trim() },
          notes: input.reason.trim(),
        },
        tx as Parameters<typeof repo.insertCaseEvent>[1],
      );

      await deps.closeCase(
        {
          caseId: caseRow.id,
          reason: input.outcome === "resolved" ? "resolved" : "cancelled",
          closedByUserId: actor.profile.id,
        },
        tx,
      );

      await repo.insertOutbreakAuditLog(
        {
          actorUserId: actor.profile.id,
          action: auditAction,
          payload: {
            case_id: caseRow.id,
            case_public_code: input.casePublicCode,
            outcome: input.outcome,
            reason: input.reason.trim(),
            v1_noop: true,
          },
        },
        tx as Parameters<typeof repo.insertOutbreakAuditLog>[1],
      );
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo cerrar la investigación: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  revalidate(`/gob/vigilancia/investigaciones/${input.casePublicCode}`);
  revalidate("/gob/vigilancia/investigaciones");

  return { ok: true, value: undefined, notifications: [] };
}
