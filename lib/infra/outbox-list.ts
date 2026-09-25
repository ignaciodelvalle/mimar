// Outbox list helpers — pure logic for the admin outbox list and detail pages.
//
// All functions here are pure and testable without a DB connection.
// The actual Drizzle query lives in the page components to keep this file
// importable in test environments.

import type { OutboxStatus } from "@/db";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BreachCue = "delivered" | "ok" | "breach" | "failed" | "merged";

/** What the legal queue shows per row beside the deadline: which disease, and the statutory window. */
export type EnoNotificationDetail = {
  /** es-AR disease label from the ENO catalog (e.g. "Rabia"). */
  diseaseLabel: string;
  /** The catalog's statutory notification window, in hours — the number the SLA was minted from. */
  legalHours: number;
};

/**
 * Read the disease behind an outbox row from its `payload_snapshot`.
 *
 * The enqueue path (lib/events/event-outbox-enqueue.ts) snapshots the FULL
 * event payload unless the rule defines `buildSnapshot` — the other rules do
 * not, so an ENO row from a diagnosis carries the event's own `disease_code`
 * (a diseases.ts code); the
 * rabies-close rule (`rabiesObservationEndedGovtWebhook`) does, and ADDS a
 * `disease_code` to its built snapshot precisely so this reader finds one
 * (lib/events/event-outbox-rules.test.ts pins that round trip). Either way it is
 * bridged to the ENO catalog the same way the SLA was computed at enqueue
 * time (lib/events/event-outbox-rules.ts: diseaseCodeToEnoCode → getEnoDisease),
 * so the "plazo legal" shown here is the window the row's `sla_due_at` was
 * minted from, never a second opinion.
 *
 * Null when the snapshot carries no recognisable disease (a non-ENO row, a
 * legacy snapshot, a malformed payload) — the caller renders "—", never
 * invents a disease.
 */
export function describeEnoNotification(payloadSnapshot: unknown): EnoNotificationDetail | null {
  if (typeof payloadSnapshot !== "object" || payloadSnapshot === null) return null;
  const code = (payloadSnapshot as Record<string, unknown>).disease_code;
  if (typeof code !== "string" || code.length === 0) return null;
  const disease = getEnoDisease(diseaseCodeToEnoCode(code));
  if (!disease) return null;
  return { diseaseLabel: disease.label, legalHours: disease.notifyHours };
}

export interface OutboxListFilters {
  status?: string;
  target_kind?: string;
  breach?: string;
  province?: string;
}

/**
 * Builds the DB update payload for the retry-now admin action.
 * Pure helper — lives here (not in `app/admin/outbox/actions.ts`) because
 * the actions file is `"use server"` and can only export async functions.
 */
export function buildRetryPayload(): { nextRetryAt: Date; status: "pending" } {
  return {
    nextRetryAt: new Date(),
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Pure predicates
// ---------------------------------------------------------------------------

/**
 * Returns true when an outbox row is in SLA breach:
 * status must be 'pending' AND slaDueAt must be in the past.
 */
export function isSlaBreached(status: OutboxStatus, slaDueAt: Date): boolean {
  if (status !== "pending") return false;
  return slaDueAt.getTime() < Date.now();
}

/**
 * Honest status wording for an external-authority row whose transmission has
 * no receiving endpoint yet (C2 language contract, 2026-07-22 — PO-locked
 * phrasing; promoted from footnote to STATUS on 2026-08-02, G7).
 *
 * One constant feeds both the status label and the delivery note so the two
 * renderings can never drift apart.
 */
export const ENO_PENDING_TRANSMISSION_STATUS =
  "Registrada y auditada — transmisión a la autoridad pendiente de endpoint receptor";

/**
 * ENO honest-delivery note (C2 language contract, 2026-07-22 — PO-locked).
 *
 * Our outbox pipeline genuinely generates, queues, SLA-tracks and audit-logs
 * every notification (AGENTS.md: "Measures OUR outbox pipeline, not external
 * delivery"). But a row completes its pipeline leg with status 'delivered' —
 * which a reader parses as "the recipient received this", when no external
 * receiving endpoint exists yet. These notes state reality instead of implying
 * transmission, and deliberately never say "próximamente" (the pipeline is real
 * and running TODAY; only the external leg is missing).
 *
 * CORRECTION 2026-08-04 (copy audit). This used to return null for every kind
 * except eno_authority, on the written claim that "govt_webhook/audit_export/
 * internal_dashboard all resolve to a real, already-built destination with no
 * such gap". That claim was FALSE, and the file it cited proves it:
 * `deliverOutboxRow` (lib/infra/outbox-drainer.ts) routes ALL FOUR kinds into
 * the same v1 branch, whose audit payload literally carries `v1_noop: true` and
 * `"real receiver not yet implemented"`. Three quarters of the console kept
 * saying "Entregado" for rows that were never sent anywhere.
 *
 * This is the day's recurring shape and worth naming: a fix lands on one
 * instance, and the comment written alongside it asserts the rest of the class
 * is fine without anyone having checked.
 *
 * The eno_authority wording is PO-locked (C2 language contract) and is
 * reproduced verbatim; the siblings get their own destination-accurate
 * phrasing rather than being folded into it.
 */
const PENDING_TRANSMISSION_BY_KIND: Record<string, string> = {
  eno_authority: ENO_PENDING_TRANSMISSION_STATUS,
  govt_webhook: "Registrada y auditada — envío al webhook pendiente de receptor",
  audit_export: "Registrada y auditada — exportación pendiente de destino",
  internal_dashboard: "Registrada y auditada — sin publicación a tablero (v1)",
};

export function externalDeliveryNote(targetKind: string): string | null {
  const status = PENDING_TRANSMISSION_BY_KIND[targetKind];
  return status ? `${status}.` : null;
}

/**
 * G7 (2026-08-02, widened 2026-08-04): TRUE for exactly the rows whose
 * "Entregado" label is a lie — status 'delivered' on a target_kind with no
 * external receiving endpoint. In v1 that is ALL FOUR kinds, not just
 * eno_authority: `deliverOutboxRow` sends every one of them down the same
 * no-op branch. 'delivered' means OUR outbox pipeline processed and
 * audit-logged the row — nobody received anything.
 *
 * Anchored on externalDeliveryNote so the endpoint-less class has ONE
 * definition: when a real receiver ships for a kind, drop it from
 * PENDING_TRANSMISSION_BY_KIND and both the status and the note follow.
 * Never true for pending/failed — those labels are honest as-is.
 */
export function isPendingExternalTransmission(status: OutboxStatus, targetKind: string): boolean {
  return status === "delivered" && externalDeliveryNote(targetKind) !== null;
}

/**
 * Maps an outbox status to a human-readable Spanish label.
 *
 * Pass the row's `targetKind` whenever a CONCRETE row is being labeled: a
 * 'delivered' eno_authority row then reads the honest pending-transmission
 * state instead of "Entregado" (G7 — externalDeliveryNote documents why
 * "Entregado" is a lie for that class). Omitting `targetKind` is only valid
 * for kind-agnostic contexts (the status <select> options in
 * lib/ui/outbox-filter-axes.ts), where no row exists to be honest about.
 */
export function buildStatusLabel(status: OutboxStatus, targetKind?: string): string {
  if (targetKind !== undefined && isPendingExternalTransmission(status, targetKind)) {
    // Per-kind, not the ENO string for everyone: the four destinations differ,
    // and a govt_webhook row reading "transmisión a la autoridad" would trade
    // one inaccuracy for another.
    return PENDING_TRANSMISSION_BY_KIND[targetKind] ?? ENO_PENDING_TRANSMISSION_STATUS;
  }
  switch (status) {
    case "delivered":
      return "Entregado";
    case "failed":
      return "Fallido";
    case "pending":
      return "Pendiente";
    // A legacy duplicate folded into its case record (migration 0247).
    case "merged":
      return "Unificado en otro registro";
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}

/**
 * Returns a traffic-light cue value for a row based on its status and SLA deadline.
 *
 * Cue values (rendered in page.tsx as emoji or color classes):
 *   "delivered" — row is delivered (green)
 *   "ok"        — pending and within SLA (amber)
 *   "breach"    — pending and past SLA (red)
 *   "failed"    — terminal failure (black/error)
 */
export function buildBreachCue(status: OutboxStatus, slaDueAt: Date): BreachCue {
  switch (status) {
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "merged":
      return "merged";
    case "pending":
      return isSlaBreached(status, slaDueAt) ? "breach" : "ok";
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive) as BreachCue;
    }
  }
}

// ---------------------------------------------------------------------------
// Filter predicate (JS-side filtering after DB fetch, like auditoria pattern)
// ---------------------------------------------------------------------------

/**
 * Applies in-memory filters to a list of outbox rows.
 * DB fetches LIMIT 200 ordered by created_at DESC; this does JS-side narrowing.
 */
export function applyOutboxFilters<
  T extends {
    status: OutboxStatus;
    targetKind: string;
    slaDueAt: Date;
    targetJurisdictionProvince: string | null;
  },
>(rows: T[], filters: OutboxListFilters): T[] {
  return rows.filter((row) => {
    if (filters.status && row.status !== filters.status) return false;
    if (filters.target_kind && row.targetKind !== filters.target_kind) return false;
    if (filters.province && row.targetJurisdictionProvince !== filters.province) return false;
    if (filters.breach === "yes" && !isSlaBreached(row.status, row.slaDueAt)) return false;
    if (filters.breach === "no" && isSlaBreached(row.status, row.slaDueAt)) return false;
    return true;
  });
}
