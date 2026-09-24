// Pure rule functions derived from lifecycle declarations.
// No DB imports, no Next.js imports — this file is domain-only.
//
// All functions take a CaseKind and delegate to the lifecycle registry.
// Callers that needed these from lib/case-helpers (cascade markers) get
// them re-exported from the shim so signatures stay identical.

import type { EventType } from "@dim/contract/events";
import type { CaseKind } from "./case-kinds";
import { getLifecycle } from "./lifecycles/index";
import type { CaseStatus } from "./lifecycles/types";

// ---------------------------------------------------------------------------
// Lifecycle-derived predicates
// ---------------------------------------------------------------------------

/**
 * True if `eventType` is declared as a terminal event for `kind`.
 * Terminal events cause the case to close at INSERT time.
 */
export function isTerminalEvent(kind: CaseKind, eventType: EventType): boolean {
  const lifecycle = getLifecycle(kind);
  if (!lifecycle) return false;
  return (lifecycle.terminalEvents as readonly string[]).includes(eventType);
}

/**
 * True if inserting `eventType` with `payload` would open a case of `kind`.
 * Checks both the event type and any optional payload guard.
 */
export function opensCase(
  kind: CaseKind,
  eventType: EventType,
  payload: Record<string, unknown>,
): boolean {
  const lifecycle = getLifecycle(kind);
  if (!lifecycle) return false;
  return lifecycle.opensEvents.some(
    (trigger) =>
      trigger.eventType === eventType &&
      (trigger.whenPayload === undefined || trigger.whenPayload(payload)),
  );
}

/**
 * True if `kind` can be opened manually (by admin/govt) without an event.
 */
export function manualOpenAllowed(kind: CaseKind): boolean {
  const lifecycle = getLifecycle(kind);
  return lifecycle?.manualOpenAllowed ?? false;
}

/**
 * True if `kind` supports reopening from closed back to open.
 * Only adoption_listing is true in V1.
 */
export function reopenAllowed(kind: CaseKind): boolean {
  const lifecycle = getLifecycle(kind);
  return lifecycle?.reopenAllowed ?? false;
}

/**
 * The set of status values the lifecycle declares for `kind`.
 * Returns an empty array for unknown kinds.
 */
export function allowedStatuses(kind: CaseKind): readonly CaseStatus[] {
  const lifecycle = getLifecycle(kind);
  return lifecycle?.statusValues ?? [];
}

// ---------------------------------------------------------------------------
// Cascade marker helpers (re-exported by lib/case-helpers shim)
// ---------------------------------------------------------------------------
//
// Every cascade event payload must carry `triggered_by_event_id` so the
// UI can render "este foster_ended se generó automáticamente por la
// muerte del animal el ___". The constant lives here so all writers
// reference the same string.

export const CASCADE_TRIGGER_PAYLOAD_KEY = "triggered_by_event_id";

/**
 * Build the partial payload that flags an event as cascade-emitted.
 * Spread into the event payload at insert time.
 */
export function cascadeTriggerPayload(triggerEventId: string): Record<string, string> {
  return { [CASCADE_TRIGGER_PAYLOAD_KEY]: triggerEventId };
}

/**
 * Sanity check at the read side. Returns true if the event payload
 * carries the cascade marker. Useful for the case timeline UI to mark
 * "auto" events visually.
 */
export function isCascadeEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return CASCADE_TRIGGER_PAYLOAD_KEY in (payload as Record<string, unknown>);
}
