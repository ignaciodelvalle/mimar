// ENO event outbox rules — maps EventType to outbox target(s) with SLA hours.
//
// Each rule declares:
//   - target_kind: which delivery channel to use (matches outbox_target_kind DB enum)
//   - slaHours(payload): returns the SLA window in hours, or null when this
//     event+payload combination does NOT warrant an outbox row.
//   - buildSnapshot (optional): produce a custom payload snapshot; defaults to
//     the full event payload when omitted.
//
// OUTBOX_RULES is a Partial<Record<EventType, OutboxRule[]>> — only event types
// that have at least one outbox target appear here. All other event types are
// silent (no outbox row).
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.3

import type { EventType } from "@/db/schema";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

/**
 * Returns the ENO catalog disease for a given diseases.ts disease_code, or
 * null if the code is not in the ENO catalog (non-ENO disease or unknown code).
 *
 * Uses the canonical `diseaseCodeToEnoCode` bridge from
 * `src/modules/surveillance/domain/eno-catalog.ts`
 * so the form-code → ENO-code mapping is shared with `lib/eno-trigger.ts`.
 */
function getEnoForDiseaseCode(diseaseCode: string) {
  return getEnoDisease(diseaseCodeToEnoCode(diseaseCode));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutboxTargetKind =
  | "govt_webhook"
  | "eno_authority"
  | "audit_export"
  | "internal_dashboard";

export interface OutboxRule {
  /** Which delivery channel this rule targets. */
  target_kind: OutboxTargetKind;

  /**
   * Returns the SLA window in hours for this event/payload, or null when this
   * rule should NOT produce an outbox row (the event does not require
   * notification to this target kind for this payload shape).
   */
  slaHours(payload: Record<string, unknown>): number | null;

  /**
   * Optional: produce a custom snapshot for the outbox row. When omitted,
   * enqueueOutboxForEvent stores the full event payload as-is.
   */
  buildSnapshot?: (payload: Record<string, unknown>) => Record<string, unknown>;

  /**
   * Optional: the case FAMILY this row belongs to ("rabies"), or null when the
   * rule cannot name a case. A family row is keyed per (animal, target
   * jurisdiction) — enoCaseKey below — and rows sharing a (target_kind, key)
   * are ONE record: the second writer links its event into the existing row
   * instead of inserting (enqueueOutboxForEvent; unique index
   * outbox_eno_case_unique, migration 0247). PO, 2026-09-25: "A Case may not be
   * duplicated; all information related to a single event must be
   * concentrated in a single record."
   */
  caseFamily?: (payload: Record<string, unknown>) => EnoCaseFamily | null;

  /**
   * Optional: WHEN the legal clock starts, read from the payload (PO S5,
   * 2026-09-26: the deadline runs from the occurrence, not from data entry).
   * Null/absent = the event's own `occurredAt`, else the enqueue instant. The
   * enqueue never lets the start pass "now".
   */
  clockStartsAt?: (payload: Record<string, unknown>) => Date | null;
}

export type EnoCaseFamily = "rabies";

/** The jurisdiction an ENO row is bound for — the authority that must be told. */
export type EnoTarget = {
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
};

/**
 * The target's catalogue row, snapshotted beside the names (localidades-por-id
 * D3). `localityId` null = no single row; `placeMethod` null = not recorded.
 */
export type TargetPlace = { localityId: string | null; placeMethod: string | null };

// ---------------------------------------------------------------------------
// Case keys
// ---------------------------------------------------------------------------

const RABIES_ENO_CODE: EnoCaseFamily = "rabies";

/**
 * The case key — ONE per (animal, authority that must be told).
 *
 * Rabies is fatal: an animal carries at most one rabies case, so the
 * diagnosis, the outbreak signal it derives and the positive close of that
 * animal's observation are the same case whatever order they arrive in.
 *
 * The TARGET JURISDICTION is part of the key because a bite counts where it
 * happened (PO rule): the row is routed to the bite case's own jurisdiction
 * (lib/events/eno-target-jurisdiction.ts), and each authority that must be
 * told gets its own record — a CABA bite by a Córdoba pet notifies CABA; two
 * bites in two jurisdictions are two rows, each deduplicated within itself.
 *
 * Every other ENO disease stays unkeyed on purpose: a dog can have
 * leptospirosis twice, and a per-animal key would fold two episodes into one.
 */
export function enoCaseKey(family: EnoCaseFamily, petId: string, target: EnoTarget): string {
  return `${family}:pet:${petId}:${target.jurisdictionProvince ?? ""}|${target.jurisdictionLocality ?? ""}`;
}

/** Shorthand for the rabies family. */
export function rabiesEnoCaseKey(petId: string, target: EnoTarget): string {
  return enoCaseKey(RABIES_ENO_CODE, petId, target);
}

/** A payload date field as a Date, or null when absent or unparseable. */
function payloadDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRabiesDiseaseCode(diseaseCode: unknown): boolean {
  return typeof diseaseCode === "string" && diseaseCodeToEnoCode(diseaseCode) === RABIES_ENO_CODE;
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * Rule for clinical_info_logged → sub_kind='disease_diagnosis'.
 *
 * Fires only when:
 *   1. payload.sub_kind === 'disease_diagnosis'
 *   2. payload.disease_code is in the ENO catalog
 *
 * SLA = disease.notifyHours from ENO_DISEASES_AR.
 */
const clinicalInfoLoggedGovtWebhook: OutboxRule = {
  target_kind: "govt_webhook",
  slaHours(payload) {
    if (payload.sub_kind !== "disease_diagnosis") return null;
    const diseaseCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
    if (!diseaseCode) return null;
    const disease = getEnoForDiseaseCode(diseaseCode);
    if (!disease) return null;
    return disease.notifyHours;
  },
  caseFamily(payload) {
    if (payload.sub_kind !== "disease_diagnosis") return null;
    return isRabiesDiseaseCode(payload.disease_code) ? RABIES_ENO_CODE : null;
  },
  // The diagnosis date — also what an amended diagnosis is re-evaluated from.
  clockStartsAt: (payload) => payloadDate(payload.diagnosis_date),
};

/**
 * Rule for outbreak_signal → govt_webhook.
 *
 * Fires only for the signal a VET'S DIAGNOSIS derives
 * (`triggered_by === 'direct_diagnosis'`) whose disease_code maps to the ENO
 * catalog. PO S1 (2026-09-26): a signal the symptom MATCHER derives — from an
 * owner's libreta entry or a witness's welfare report — is a suspicion. It
 * still pages the authority in-app (routeOutbreakSignalNotifications) and
 * counts on the surveillance surfaces, but it mints NO legal ENO row: the
 * legal notification comes only from a vet/lab diagnosis or a vet-confirmed
 * rabies close. A legacy signal with no `triggered_by` is a matcher signal
 * (the schema's own read default).
 *
 * The 24 h window is the notification-to-authority window of the signal path,
 * uniform for every ENO disease.
 */
const outbreakSignalGovtWebhook: OutboxRule = {
  target_kind: "govt_webhook",
  slaHours(payload) {
    if (payload.triggered_by !== "direct_diagnosis") return null;
    const diseaseCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
    if (!diseaseCode) return null;
    const disease = getEnoForDiseaseCode(diseaseCode);
    if (!disease) return null;
    return 24;
  },
  // Only the signal a DIAGNOSIS derives is the diagnosis's case — it is the
  // same act restated (source_disease_diagnosis_event_id). A symptom-cluster
  // signal is a suspicion about a population, not a case, and stays unkeyed.
  caseFamily(payload) {
    if (payload.triggered_by !== "direct_diagnosis") return null;
    return isRabiesDiseaseCode(payload.disease_code) ? RABIES_ENO_CODE : null;
  },
};

/**
 * Rule for rabies_observation_ended → govt_webhook (PO decision 1A).
 *
 * A POSITIVE close of a rabies observation is a notifiable rabies case, the
 * same disease a `disease_diagnosis` of rabies_confirmed puts in the Cola ENO.
 * Before this rule the close paged the authorities in-app and left no row in
 * the legal queue — no SLA, nothing for /gob/outbox to show — while the
 * veterinarian's screen said confirming positive notifies public health.
 *
 * Fires only for `outcome === 'positive_rabies'`. Negative, dead and lost to
 * follow-up are not a case: nothing to notify.
 *
 * SLA = the ENO catalog's rabies `notifyHours`, the same number the diagnosis
 * path uses — read from the catalog, never restated here.
 *
 * The snapshot is BUILT, not copied: `disease_code` is added so the Cola ENO
 * row names the disease and its legal window (describeEnoNotification reads
 * it), and `closure_notes` is dropped — it is PA-gated clinical prose
 * (payload-privacy.ts) and this payload is bound for an external authority.
 */
const rabiesObservationEndedGovtWebhook: OutboxRule = {
  target_kind: "govt_webhook",
  slaHours(payload) {
    if (payload.outcome !== "positive_rabies") return null;
    return getEnoDisease(RABIES_ENO_CODE)?.notifyHours ?? null;
  },
  buildSnapshot(payload) {
    return {
      disease_code: RABIES_ENO_CODE,
      outcome: payload.outcome,
      closed_by_role: payload.closed_by_role,
      observation_started_event_id: payload.observation_started_event_id,
      bite_event_id: payload.bite_event_id ?? null,
      death_event_id: payload.death_event_id ?? null,
    };
  },
  caseFamily(payload) {
    return payload.outcome === "positive_rabies" ? RABIES_ENO_CODE : null;
  },
};

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

export const OUTBOX_RULES: Partial<Record<EventType, OutboxRule[]>> = {
  clinical_info_logged: [clinicalInfoLoggedGovtWebhook],
  outbreak_signal: [outbreakSignalGovtWebhook],
  rabies_observation_ended: [rabiesObservationEndedGovtWebhook],
};
