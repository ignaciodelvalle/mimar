// Validated insert boundary for pet_events (event-sourcing integrity review
// 2026-07-04, item 2).
//
// Before this module, payload validation lived ONLY at the use-case edge:
// every writer was expected to call validateEventPayload and pass the parsed
// result down. That convention held for app/actions/* but the repository
// insert methods (EventsRepository.insertEvent / insertEventIdempotent,
// WelfareRepository.insertPetEvent / insertPetEventIdempotent) accepted raw
// values — one forgetful writer away from an unvalidated append-only row.
//
// This helper is called INSIDE those repository methods so every pet_events
// write is schema-checked at the last boundary before the INSERT:
//   - Invalid payload → EventPayloadValidationError, nothing written.
//   - Valid payload   → the PARSED payload is stored (fills payload_version: 1
//     when missing, per the upcaster contract).
//
// Re-validation of an already-parsed payload is a no-op, so use-case-level
// validateEventPayload calls stay correct and cheap.

import type { EventType, NewPetEvent } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";

/**
 * Return `values` with `payload` replaced by its schema-parsed projection.
 * Throws EventPayloadValidationError when the payload does not satisfy the
 * per-type Zod schema (or when the event type has no registered schema).
 *
 * `payload` defaults to `{}` when absent — mirrors the column's
 * `'{}'::jsonb` default so schemas with all-optional fields still parse.
 */
export function validatedEventValues(values: NewPetEvent): NewPetEvent {
  const payload = validateEventPayload(values.eventType as EventType, values.payload ?? {});
  return { ...values, payload };
}
