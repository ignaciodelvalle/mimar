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
};

/**
 * Rule for outbreak_signal → govt_webhook.
 *
 * Fires only when the signal's disease_code maps to a disease in the ENO
 * catalog (i.e., severity is 'critical' or 'high'). All ENO catalog diseases
 * warrant a 24-hour notification window regardless of notifyHours — the outbox
 * SLA here is the notification-to-authority window, which is uniformly 24h
 * for the outbreak-signal path (the signal itself is already a derived alert).
 *
 * Returns null for disease codes not in the ENO catalog.
 */
const outbreakSignalGovtWebhook: OutboxRule = {
  target_kind: "govt_webhook",
  slaHours(payload) {
    const diseaseCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
    if (!diseaseCode) return null;
    const disease = getEnoForDiseaseCode(diseaseCode);
    if (!disease) return null;
    // Outbreak signals from ENO diseases always warrant 24h govt notification.
    return 24;
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
const RABIES_ENO_CODE = "rabies";

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
};

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

export const OUTBOX_RULES: Partial<Record<EventType, OutboxRule[]>> = {
  clinical_info_logged: [clinicalInfoLoggedGovtWebhook],
  outbreak_signal: [outbreakSignalGovtWebhook],
  rabies_observation_ended: [rabiesObservationEndedGovtWebhook],
};
