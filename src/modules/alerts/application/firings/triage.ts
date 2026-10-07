// Triage use-cases — admin-only mutations driven by the inbox row actions.
//
// Auth guards are lifted to the thin shim (app/actions/alert-firings.ts).
// Use-cases receive the authenticated userId + inputs and perform zero auth checks.
// revalidatePath is also lifted to the shim (Next.js concern, not business logic).
//
// AUDIT (plan maestro A12, 2026-10-07). Every use case below writes one
// `alert_firing_triaged` audit row, actor = the acting admin, in the SAME
// transaction as the firing change (a rollback takes both). Decision K-D4 kept
// the trail in the firing's *_by columns only, and two transitions had none:
// a seguimiento note had no author, and "contactar autoridad" notified every
// govt of a jurisdiction without recording who escalated.
//
// State transitions:
//   acknowledgeFiring          disparada → reconocida
//   openInvestigationFiring    (active_zoonosis only) reconocida → en_investigacion
//   registerFollowupFiring     (non-zoonosis) append a note, no state change
//   contactAuthorityFiring     → autoridad_contactada (+ outbox notifications)
//   resolveFiring              → resuelta
//   dismissFiring              → descartada

import { eq } from "drizzle-orm";

import { type AlertFiring, type AlertFiringStatus, alertFirings, db, notifications } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { type AuditExecutor, writeAuditLog } from "@/lib/infra/audit-log";
import {
  type AlertFiringTransition,
  investigationDiseaseCode,
  metricOpensInvestigation,
  nextStatus,
} from "@/lib/metrics/alert-firing";
import { openOutbreakInvestigationAction } from "@/src/modules/surveillance/actions";

import type { FiringActionResult } from "./types";

// ---------------------------------------------------------------------------
// Private constants & helpers (verbatim from original)
// ---------------------------------------------------------------------------

// es-AR metric labels (kept here so actions can build investigation reasons /
// notification copy without importing the page). Mirrors ALERT_METRIC_LABEL.
const METRIC_LABEL_ES: Record<string, string> = {
  active_zoonosis: "Casos de zoonosis activos",
  eno_sla_ontime_pct: "SLA ENO en tiempo",
  queue_oldest_days: "Días sin atender (cola)",
  sterilization_coverage_pct: "Cobertura de esterilización",
  microchip_penetration_pct: "Penetración de microchip",
  open_welfare_reports: "Denuncias de maltrato abiertas",
};

function jurisdictionLabel(province: string | null, locality: string | null): string {
  if (province && locality) return `${locality}, ${province}`;
  if (province) return province;
  return "nivel nacional";
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Load a firing by id (admin scope — no row-level filter beyond existence),
 * LOCKED for the rest of the transaction. Every use case below reads its
 * firing this way and decides inside the same transaction, so two concurrent
 * clicks serialise: the second one sees the first one's status and notes, and
 * can neither write a second audit row claiming the same from_status nor
 * overwrite a seguimiento note it never read.
 */
async function lockFiring(tx: Tx, id: string): Promise<AlertFiring | null> {
  const [row] = await tx
    .select()
    .from(alertFirings)
    .where(eq(alertFirings.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** Apply a validated transition; returns the resolved next status or an error. */
function resolveTransition(
  firing: AlertFiring,
  transition: AlertFiringTransition,
): { next: NonNullable<ReturnType<typeof nextStatus>> } | { error: string } {
  const next = nextStatus(firing.status, transition);
  if (next === null) {
    return { error: `Transición inválida desde "${firing.status}".` };
  }
  return { next };
}

/**
 * The one audit row each triage action writes. `locality_id` is the place key
 * the audit_log province stamp reads (migration 0269), so a jurisdiction's
 * trail finds the alerts triaged there; omitted when the firing names none.
 */
async function auditTriage(
  executor: AuditExecutor,
  userId: string,
  firing: AlertFiring,
  transition: AlertFiringTransition | "followup",
  toStatus: AlertFiringStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeAuditLog(executor, {
    action: "alert_firing_triaged",
    actorUserId: userId,
    payload: {
      firing_id: firing.id,
      transition,
      from_status: firing.status,
      to_status: toStatus,
      metric_key: firing.metricKey,
      ...(firing.localityId ? { locality_id: firing.localityId } : {}),
      ...extra,
    },
  });
}

/** A seguimiento line: when and WHO, then the text. */
export function followupNoteLine(at: Date, userId: string, note: string): string {
  return `[${at.toISOString()} · ${userId}] ${note}`;
}

// ---------------------------------------------------------------------------
// Triage use-cases
// ---------------------------------------------------------------------------

/** Reconocer — disparada → reconocida. Sets acknowledged_at/by. */
export async function acknowledgeFiring(
  userId: string,
  firingId: string,
): Promise<FiringActionResult> {
  return db.transaction(async (tx): Promise<FiringActionResult> => {
    const firing = await lockFiring(tx, firingId);
    if (!firing) return { error: "Alerta no encontrada" };

    const t = resolveTransition(firing, "acknowledge");
    if ("error" in t) return t;

    await tx
      .update(alertFirings)
      .set({ status: t.next, acknowledgedAt: new Date(), acknowledgedBy: userId })
      .where(eq(alertFirings.id, firingId));
    await auditTriage(tx, userId, firing, "acknowledge", t.next);
    return { ok: true };
  });
}

/**
 * Abrir investigación — reconocida → en_investigacion. ONLY for active_zoonosis
 * (the only disease-mapped metric, decision K-D2). Pre-calls
 * openOutbreakInvestigationAction and stores the returned publicCode as
 * investigation_code. Non-zoonosis metrics must use registerFollowupFiring.
 */
export async function openInvestigationFiring(
  userId: string,
  firingId: string,
): Promise<FiringActionResult> {
  return db.transaction(async (tx): Promise<FiringActionResult> => {
    const firing = await lockFiring(tx, firingId);
    if (!firing) return { error: "Alerta no encontrada" };

    if (!metricOpensInvestigation(firing.metricKey)) {
      return {
        error: "Esta métrica no abre un expediente. Usá “Registrar seguimiento” en su lugar.",
      };
    }

    const diseaseCode = investigationDiseaseCode(firing.metricKey);
    if (!diseaseCode) return { error: "No hay enfermedad mapeada para esta métrica." };

    const t = resolveTransition(firing, "open_investigation");
    if ("error" in t) return t;

    const metricLabel = METRIC_LABEL_ES[firing.metricKey] ?? firing.metricKey;
    const where = jurisdictionLabel(firing.jurisdictionProvince, firing.jurisdictionLocality);

    // Reuse the full investigations flow — opens the expediente + notifies
    // govts. It runs on its own connection WHILE this row stays locked, so a
    // second click waits here and then sees en_investigacion: one expediente
    // per firing, not one per click. (The expediente is not undone if the
    // update below fails — same as before the lock.)
    const opened = await openOutbreakInvestigationAction({
      diseaseCode,
      reason: `Alerta ${metricLabel} en ${where}`,
      linkedSignalEventId: null,
    });
    if ("error" in opened) return { error: opened.error };

    await tx
      .update(alertFirings)
      .set({ status: t.next, investigationCode: opened.publicCode })
      .where(eq(alertFirings.id, firingId));
    await auditTriage(tx, userId, firing, "open_investigation", t.next, {
      investigation_code: opened.publicCode,
    });
    return { ok: true };
  });
}

/**
 * Registrar seguimiento — append a note to the firing WITHOUT opening an
 * expediente. The "investigation" alternative for non-disease-mapped metrics
 * (decision K-D2). Does NOT change status (it remains reconocida) — the note is
 * the lightweight record. Returns an error for zoonosis (use openInvestigation).
 */
export async function registerFollowupFiring(
  userId: string,
  firingId: string,
  note: string,
): Promise<FiringActionResult> {
  const trimmed = note.trim();
  if (!trimmed) return { error: "Escribí una nota de seguimiento." };

  return db.transaction(async (tx): Promise<FiringActionResult> => {
    const firing = await lockFiring(tx, firingId);
    if (!firing) return { error: "Alerta no encontrada" };

    if (metricOpensInvestigation(firing.metricKey)) {
      return {
        error: "Esta métrica abre un expediente. Usá “Abrir investigación”.",
      };
    }

    // Firing must be acknowledged first (a note belongs to a worked alert).
    if (firing.status !== "reconocida" && firing.status !== "en_investigacion") {
      return { error: "Reconocé la alerta antes de registrar un seguimiento." };
    }

    // The author rides on the note itself (the column is free text and a note
    // has no *_by column) AND on the audit row, which is the queryable record.
    // Merged onto the LOCKED row's notes: a concurrent seguimiento is kept.
    const stamped = followupNoteLine(new Date(), userId, trimmed);
    const merged = firing.notes ? `${firing.notes}\n${stamped}` : stamped;

    await tx.update(alertFirings).set({ notes: merged }).where(eq(alertFirings.id, firingId));
    await auditTriage(tx, userId, firing, "followup", firing.status, { note: trimmed });
    return { ok: true };
  });
}

/**
 * Contactar autoridad — resolve the govt profiles of the firing's jurisdiction
 * via govt_assignments (findAuthoritiesForJurisdiction, which falls back to
 * admins when no govt covers the locality), send an in-app outbox notification,
 * and transition to autoridad_contactada. Sets contacted_govt_user_id (first
 * resolved recipient) + contacted_at.
 */
export async function contactAuthorityFiring(
  userId: string,
  firingId: string,
): Promise<FiringActionResult> {
  // Notifications, transition and audit row commit together: no govt is
  // notified of an escalation the register does not attribute to anybody.
  return db.transaction(async (tx): Promise<FiringActionResult> => {
    const firing = await lockFiring(tx, firingId);
    if (!firing) return { error: "Alerta no encontrada" };

    const t = resolveTransition(firing, "contact_authority");
    if ("error" in t) return t;

    // A jurisdiction is required to resolve an authority. Global metrics
    // (queue_oldest_days) have no province — cannot route a local authority.
    if (!firing.jurisdictionProvince || !firing.jurisdictionLocality) {
      return {
        error: "Esta alerta no tiene jurisdicción local; no hay autoridad a contactar.",
      };
    }

    const recipients = await findAuthoritiesForJurisdiction({
      province: firing.jurisdictionProvince,
      locality: firing.jurisdictionLocality,
      // The firing's catalogue row (localidades-por-id D3).
      localityId: firing.localityId ?? null,
    });
    if (recipients.length === 0) {
      return { error: "No encontramos autoridades para esta jurisdicción." };
    }

    const metricLabel = METRIC_LABEL_ES[firing.metricKey] ?? firing.metricKey;
    const where = jurisdictionLabel(firing.jurisdictionProvince, firing.jurisdictionLocality);

    // In-app outbox notification (v1 channel — decision K-D5).
    await tx.insert(notifications).values(
      recipients.map((recipientId) => ({
        userId: recipientId,
        notificationType: "alert_authority_contacted",
        title: `Alerta sanitaria: ${metricLabel}`,
        body: `Un administrador escaló una alerta de "${metricLabel}" en ${where}. Revisá la situación en tu jurisdicción.`,
        severity: "warning" as const,
        category: "admin",
        ctaLabel: "Ver vigilancia",
        ctaUrl: "/gob/vigilancia",
      })),
    );

    await tx
      .update(alertFirings)
      .set({
        status: t.next,
        contactedGovtUserId: recipients[0],
        contactedAt: new Date(),
      })
      .where(eq(alertFirings.id, firingId));

    await auditTriage(tx, userId, firing, "contact_authority", t.next, {
      recipients: recipients.length,
      first_recipient_user_id: recipients[0],
    });
    return { ok: true };
  });
}

/** Resolver — close the firing with notes → resuelta. */
export async function resolveFiring(
  userId: string,
  firingId: string,
  notes: string,
): Promise<FiringActionResult> {
  return _closeFiring(userId, firingId, "resolve", notes);
}

/** Descartar — close the firing with notes → descartada. */
export async function dismissFiring(
  userId: string,
  firingId: string,
  notes: string,
): Promise<FiringActionResult> {
  return _closeFiring(userId, firingId, "dismiss", notes);
}

async function _closeFiring(
  userId: string,
  firingId: string,
  transition: "resolve" | "dismiss",
  notes: string,
): Promise<FiringActionResult> {
  return db.transaction(async (tx): Promise<FiringActionResult> => {
    const firing = await lockFiring(tx, firingId);
    if (!firing) return { error: "Alerta no encontrada" };

    const t = resolveTransition(firing, transition);
    if ("error" in t) return t;

    const trimmed = notes.trim();
    const merged = trimmed
      ? firing.notes
        ? `${firing.notes}\n[cierre] ${trimmed}`
        : `[cierre] ${trimmed}`
      : firing.notes;

    await tx
      .update(alertFirings)
      .set({
        status: t.next,
        notes: merged,
        resolvedAt: new Date(),
        resolvedBy: userId,
      })
      .where(eq(alertFirings.id, firingId));
    await auditTriage(tx, userId, firing, transition, t.next, trimmed ? { note: trimmed } : {});
    return { ok: true };
  });
}
