// Triage use-cases — admin-only mutations driven by the inbox row actions.
//
// Auth guards are lifted to the thin shim (app/actions/alert-firings.ts).
// Use-cases receive the authenticated userId + inputs and perform zero auth checks.
// revalidatePath is also lifted to the shim (Next.js concern, not business logic).
//
// State transitions:
//   acknowledgeFiring          disparada → reconocida
//   openInvestigationFiring    (active_zoonosis only) reconocida → en_investigacion
//   registerFollowupFiring     (non-zoonosis) append a note, no state change
//   contactAuthorityFiring     → autoridad_contactada (+ outbox notifications)
//   resolveFiring              → resuelta
//   dismissFiring              → descartada

import { eq } from "drizzle-orm";

import { type AlertFiring, alertFirings, db, notifications } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
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

/** Load a firing by id (admin scope — no row-level filter beyond existence). */
async function loadFiring(id: string): Promise<AlertFiring | null> {
  const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id)).limit(1);
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

// ---------------------------------------------------------------------------
// Triage use-cases
// ---------------------------------------------------------------------------

/** Reconocer — disparada → reconocida. Sets acknowledged_at/by. */
export async function acknowledgeFiring(
  userId: string,
  firingId: string,
): Promise<FiringActionResult> {
  const firing = await loadFiring(firingId);
  if (!firing) return { error: "Alerta no encontrada" };

  const t = resolveTransition(firing, "acknowledge");
  if ("error" in t) return t;

  await db
    .update(alertFirings)
    .set({ status: t.next, acknowledgedAt: new Date(), acknowledgedBy: userId })
    .where(eq(alertFirings.id, firingId));

  return { ok: true };
}

/**
 * Abrir investigación — reconocida → en_investigacion. ONLY for active_zoonosis
 * (the only disease-mapped metric, decision K-D2). Pre-calls
 * openOutbreakInvestigationAction and stores the returned publicCode as
 * investigation_code. Non-zoonosis metrics must use registerFollowupFiring.
 */
export async function openInvestigationFiring(firingId: string): Promise<FiringActionResult> {
  const firing = await loadFiring(firingId);
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

  // Reuse the full investigations flow — opens the expediente + notifies govts.
  const opened = await openOutbreakInvestigationAction({
    diseaseCode,
    reason: `Alerta ${metricLabel} en ${where}`,
    linkedSignalEventId: null,
  });
  if ("error" in opened) return { error: opened.error };

  await db
    .update(alertFirings)
    .set({ status: t.next, investigationCode: opened.publicCode })
    .where(eq(alertFirings.id, firingId));

  return { ok: true };
}

/**
 * Registrar seguimiento — append a note to the firing WITHOUT opening an
 * expediente. The "investigation" alternative for non-disease-mapped metrics
 * (decision K-D2). Does NOT change status (it remains reconocida) — the note is
 * the lightweight record. Returns an error for zoonosis (use openInvestigation).
 */
export async function registerFollowupFiring(
  firingId: string,
  note: string,
): Promise<FiringActionResult> {
  const trimmed = note.trim();
  if (!trimmed) return { error: "Escribí una nota de seguimiento." };

  const firing = await loadFiring(firingId);
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

  const stamped = `[${new Date().toISOString()}] ${trimmed}`;
  const merged = firing.notes ? `${firing.notes}\n${stamped}` : stamped;

  await db.update(alertFirings).set({ notes: merged }).where(eq(alertFirings.id, firingId));

  return { ok: true };
}

/**
 * Contactar autoridad — resolve the govt profiles of the firing's jurisdiction
 * via govt_assignments (findAuthoritiesForJurisdiction, which falls back to
 * admins when no govt covers the locality), send an in-app outbox notification,
 * and transition to autoridad_contactada. Sets contacted_govt_user_id (first
 * resolved recipient) + contacted_at.
 */
export async function contactAuthorityFiring(firingId: string): Promise<FiringActionResult> {
  const firing = await loadFiring(firingId);
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
  });
  if (recipients.length === 0) {
    return { error: "No encontramos autoridades para esta jurisdicción." };
  }

  const metricLabel = METRIC_LABEL_ES[firing.metricKey] ?? firing.metricKey;
  const where = jurisdictionLabel(firing.jurisdictionProvince, firing.jurisdictionLocality);

  // In-app outbox notification (v1 channel — decision K-D5).
  await db.insert(notifications).values(
    recipients.map((userId) => ({
      userId,
      notificationType: "alert_authority_contacted",
      title: `Alerta sanitaria: ${metricLabel}`,
      body: `Un administrador escaló una alerta de "${metricLabel}" en ${where}. Revisá la situación en tu jurisdicción.`,
      severity: "warning" as const,
      category: "admin",
      ctaLabel: "Ver vigilancia",
      ctaUrl: "/gob/vigilancia",
    })),
  );

  await db
    .update(alertFirings)
    .set({
      status: t.next,
      contactedGovtUserId: recipients[0],
      contactedAt: new Date(),
    })
    .where(eq(alertFirings.id, firingId));

  return { ok: true };
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
  const firing = await loadFiring(firingId);
  if (!firing) return { error: "Alerta no encontrada" };

  const t = resolveTransition(firing, transition);
  if ("error" in t) return t;

  const trimmed = notes.trim();
  const merged = trimmed
    ? firing.notes
      ? `${firing.notes}\n[cierre] ${trimmed}`
      : `[cierre] ${trimmed}`
    : firing.notes;

  await db
    .update(alertFirings)
    .set({
      status: t.next,
      notes: merged,
      resolvedAt: new Date(),
      resolvedBy: userId,
    })
    .where(eq(alertFirings.id, firingId));

  return { ok: true };
}
