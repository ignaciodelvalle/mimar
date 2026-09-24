// lib/metrics/alert-firing.ts — Pure domain for the alert-firing lifecycle (Paquete K).
//
// NO DB, NO I/O. Two responsibilities:
//   1. shouldOpenFiring(existingOpen, evaluation) → boolean
//      Decides whether a NEW firing should be opened when a subscription crosses
//      its threshold. At most ONE open firing per (subscription, jurisdiction):
//      if one is already open, don't spam a second.
//   2. nextStatus(current, transition) → AlertFiringStatus | null
//      Validated state machine. Returns the resulting status for a legal
//      transition, or null for an illegal one (e.g. resuelta → reconocida).
//
// Both are pure and unit-tested in lib/metrics/alert-firing.test.ts. The DB
// writer (app/actions/alert-firings.ts) consumes these decisions.

import {
  ALERT_FIRING_OPEN_STATUSES,
  type AlertDirection,
  type AlertFiringStatus,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Open-status predicate
// ---------------------------------------------------------------------------

const OPEN_STATUS_SET: ReadonlySet<AlertFiringStatus> = new Set(ALERT_FIRING_OPEN_STATUSES);

/** True when a firing status is non-terminal (still in the inbox). */
export function isOpenStatus(status: AlertFiringStatus): boolean {
  return OPEN_STATUS_SET.has(status);
}

// ---------------------------------------------------------------------------
// shouldOpenFiring — dedup gate
// ---------------------------------------------------------------------------

/** Minimal shape the dedup gate needs from an existing firing row. */
export type ExistingFiring = { status: AlertFiringStatus };

/**
 * The evaluation result for a single subscription in a single jurisdiction.
 * `breaching` is the canonical signal (computed by isBreaching upstream).
 */
export type FiringEvaluation = {
  breaching: boolean;
};

/**
 * Decide whether to open a new firing.
 *
 * Opens ONLY when:
 *   - the subscription is currently breaching, AND
 *   - there is no already-open firing for this (subscription, jurisdiction).
 *
 * `existingOpen` is the caller-resolved list of firings for this exact
 * (subscription, jurisdiction) tuple. If ANY of them is still open, we do not
 * open another — the admin works the existing one to closure first.
 */
export function shouldOpenFiring(
  existingOpen: readonly ExistingFiring[],
  evaluation: FiringEvaluation,
): boolean {
  if (!evaluation.breaching) return false;
  return !existingOpen.some((f) => isOpenStatus(f.status));
}

// ---------------------------------------------------------------------------
// nextStatus — validated state machine
// ---------------------------------------------------------------------------

/**
 * Triage transitions an admin can request from the inbox. Each maps to exactly
 * one target status; the legality depends on the CURRENT status (see the table).
 */
export type AlertFiringTransition =
  | "acknowledge" // disparada → reconocida
  | "open_investigation" // reconocida → en_investigacion
  | "contact_authority" // en_investigacion → autoridad_contactada
  | "resolve" // autoridad_contactada → resuelta
  | "dismiss"; // disparada | reconocida → descartada

/**
 * Allowed (currentStatus → transition → nextStatus) edges. Anything absent is
 * illegal and nextStatus returns null.
 *
 * NOTE on "resolve": v1 allows resolving from any open status EXCEPT directly
 * from disparada (an alert must at least be acknowledged first). The richest
 * happy path is acknowledge → investigate → contact → resolve, but an admin can
 * also resolve a reconocida/en_investigacion firing without contacting (e.g. a
 * false positive that nonetheless deserved a look). dismiss is reserved for the
 * earliest two states (nothing was actioned).
 */
const TRANSITIONS: Record<
  AlertFiringTransition,
  Partial<Record<AlertFiringStatus, AlertFiringStatus>>
> = {
  acknowledge: {
    disparada: "reconocida",
  },
  open_investigation: {
    reconocida: "en_investigacion",
  },
  contact_authority: {
    reconocida: "autoridad_contactada",
    en_investigacion: "autoridad_contactada",
  },
  resolve: {
    reconocida: "resuelta",
    en_investigacion: "resuelta",
    autoridad_contactada: "resuelta",
  },
  dismiss: {
    disparada: "descartada",
    reconocida: "descartada",
  },
};

/**
 * Resolve the next status for a transition request, or null if the transition
 * is illegal from `current` (e.g. resuelta → reconocida, or acknowledging an
 * already-acknowledged firing).
 */
export function nextStatus(
  current: AlertFiringStatus,
  transition: AlertFiringTransition,
): AlertFiringStatus | null {
  return TRANSITIONS[transition]?.[current] ?? null;
}

// ---------------------------------------------------------------------------
// Metric → action mapping (decision K-D2)
// ---------------------------------------------------------------------------

/**
 * Only disease-mapped metrics open a formal outbreak investigation. Today that
 * is exactly `active_zoonosis`. Every other metric uses "registrar seguimiento"
 * (a note appended to the firing) instead of an expediente.
 */
export function metricOpensInvestigation(metricKey: string): boolean {
  return metricKey === "active_zoonosis";
}

/**
 * The diseaseCode passed to openOutbreakInvestigationAction for an
 * investigation-eligible metric. active_zoonosis is a rolled-up count rather
 * than a single disease, so we anchor the investigation on rabies-suspected
 * (the canonical zoonosis trigger). Returns null for non-eligible metrics.
 */
export function investigationDiseaseCode(metricKey: string): string | null {
  if (metricKey === "active_zoonosis") return "rabies_suspected";
  return null;
}

// Re-export the direction type so callers building evaluations from a
// subscription don't need a second import.
export type { AlertDirection };
