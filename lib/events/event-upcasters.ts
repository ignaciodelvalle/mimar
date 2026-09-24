// Upcasters for evolving `pet_events` payloads across schema versions.
//
// Why this file exists alongside `lib/event-schemas.ts`:
//   - Schemas validate the current writer-produced shape (v_latest).
//   - Upcasters transform a historical row (v_n, n < latest) into the latest
//     shape so reducers and UIs can ignore versioning.
// Splitting them keeps the dependency direction clean (upcasters import from
// schemas, never the other way) and keeps `event-schemas.ts` from doubling
// in size as upcasters accumulate.
//
// Today every schema in `lib/event-schemas.ts` is at v1 and this registry is
// empty — `upcastPayload` is a no-op. The first schema to evolve lands its
// v1→v2 upcaster here in the same PR that bumps the literal.
//
// See `docs/superpowers/event-versioning.md` for the contract and the
// step-by-step flow for adding a v(N+1).

import type { EventType } from "@/db/schema";

/**
 * An upcaster transforms a payload from version N to version N+1 for a given
 * event type. Pure and total — every v(N) payload must map to a valid v(N+1)
 * payload. If the migration is lossy, encode the loss as an explicit field
 * (e.g. `legacy_field: null`) rather than dropping data silently.
 */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of upcasters keyed by event type. Each entry is an array of
 * upcasters indexed by `fromVersion - 1`:
 *   - `Upcasters[type][0]` maps v1 → v2
 *   - `Upcasters[type][1]` maps v2 → v3
 *   - etc.
 *
 * Empty today. When a schema bumps its literal in `lib/event-schemas.ts`,
 * register the corresponding upcaster in this map in the SAME PR — without
 * it, historical rows would fail validation in the read path.
 */
const Upcasters: Partial<Record<EventType, ReadonlyArray<Upcaster>>> = {
  // v1 → v2 (PR-14 adoption UX): motivation + prior_pets became required
  // nullable keys. Historical applications never captured them — null.
  adoption_application_submitted: [
    (payload) => ({
      ...payload,
      payload_version: 2,
      motivation: payload.motivation ?? null,
      prior_pets: payload.prior_pets ?? null,
    }),
  ],
};

/**
 * Returns the event types that have at least one registered upcaster.
 * Intended for fitness-function tests that assert upcaster coverage stays in
 * sync with schemas whose `payload_version` literal is > 1.
 */
export function registeredUpcasterTypes(): ReadonlyArray<EventType> {
  return Object.keys(Upcasters) as EventType[];
}

/**
 * Apply registered upcasters to bring a payload up to the latest schema
 * version. No-op when no upcaster is registered for the event type or when
 * the payload is already at the latest version (i.e. the registry has no
 * upcaster past the payload's current version).
 *
 * Call this in the READ path (event reducers, history views, projection
 * rebuilds) before handing the payload to UI or business logic. The WRITE
 * path does NOT call this — writers always produce the latest shape via the
 * current Zod schema in `lib/event-schemas.ts`, enforced by
 * `validateEventPayload`.
 *
 * If `payload.payload_version` is missing the payload is treated as v1 (the
 * baseline introduced by migration 0039 — every row written before that
 * migration had its version backfilled to 1).
 */
export function upcastPayload(eventType: EventType, payload: unknown): unknown {
  const upcasters = Upcasters[eventType];
  if (!upcasters || upcasters.length === 0) return payload;
  if (!payload || typeof payload !== "object") return payload;

  let current = payload as Record<string, unknown>;
  const startVersion =
    typeof current.payload_version === "number" && Number.isInteger(current.payload_version)
      ? current.payload_version
      : 1;

  // Apply upcasters from `startVersion - 1` (0-indexed) onwards. If
  // startVersion is already past the registry length there's nothing to do.
  // Clamp at 0 so a corrupt row (payload_version: 0) no-ops instead of throwing.
  for (let i = Math.max(0, startVersion - 1); i < upcasters.length; i++) {
    current = upcasters[i](current);
  }

  return current;
}
