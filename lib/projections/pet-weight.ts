// Projection: derive `pets.estimatedWeightKg` from the event log.
//
// The weight cache is LATEST-WINS across EVERY event that carries a weight — not
// just the dedicated `weight_recorded` measurement. Three write paths update the
// cache, each already matched by an event (Invariant #3), so all three must be
// replayable or the cache drifts invisibly from the spine:
//
//   - weight_recorded.payload.kg                  — a dedicated weight measurement
//       (createWeight use-case; the /eventos/nuevo/peso timeline entry).
//   - pet_profile_updated changes[]               — a profile edit that CORRECTS
//       the estimated weight (field "estimated_weight_kg"). The `new` value is
//       the correction; clearing the field (new=null) is itself a weight-bearing
//       change that sets the cache to null.
//   - pet_registered.payload.estimated_weight_kg  — the initial estimate captured
//       at registration.
//
// A profile-edit weight change is deliberately NOT re-emitted as a
// weight_recorded event: that would inject a non-measurement into the weight
// history chart (fetchPetWeightHistory) and the libreta sanitaria timeline, both
// of which read weight_recorded. The correction lives on its own event
// (pet_profile_updated) and is folded here instead.
//
// The value is returned as a string (or null); the rebuild script + drift
// harness compare numerically, so "8.5" vs "8.50" is not a mismatch.

import type { AmendmentOverlaid, ProjectionEvent } from "./types";

export type PetWeightProjection = {
  estimatedWeightKg: string | null;
};

// Sentinel: this event carries no weight at all, so the scan skips it and keeps
// looking backwards. Distinct from a weight-bearing event whose value is null (a
// cleared estimate), which WINS as null and stops the scan.
const NOT_WEIGHT_BEARING = Symbol("not-weight-bearing");

export function replayPetWeight(events: AmendmentOverlaid<ProjectionEvent>): PetWeightProjection {
  // Iterate from the end: the latest weight-bearing event wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const w = weightFromEvent(events[i]);
    if (w === NOT_WEIGHT_BEARING) continue;
    return { estimatedWeightKg: w };
  }
  return { estimatedWeightKg: null };
}

function weightFromEvent(e: ProjectionEvent): string | null | typeof NOT_WEIGHT_BEARING {
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.eventType) {
    case "weight_recorded":
      // A malformed kg (empty / non-finite) is not-weight-bearing so the scan
      // falls through to the previous real measurement.
      return normalizeKg(payload.kg);
    case "pet_registered":
      // No weight at registration (null) is not-weight-bearing — nothing was
      // cached, so keep looking (there is nothing earlier, so it resolves null).
      return normalizeKg(payload.estimated_weight_kg);
    case "pet_profile_updated": {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      const entry = changes.find(
        (c): c is { field: string; new: unknown } =>
          typeof c === "object" &&
          c !== null &&
          (c as { field?: unknown }).field === "estimated_weight_kg",
      );
      if (!entry) return NOT_WEIGHT_BEARING; // this edit did not touch weight
      // A profile edit that touches weight is weight-bearing even when it clears
      // the value (new=null) — that sets the cache to null and wins.
      return emptyToNull(entry.new);
    }
    default:
      return NOT_WEIGHT_BEARING;
  }
}

// weight_recorded kg / registration estimate: string or number; empty or
// non-finite → not-weight-bearing.
function normalizeKg(v: unknown): string | typeof NOT_WEIGHT_BEARING {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return v.toString();
  return NOT_WEIGHT_BEARING;
}

// Profile-edit `new` value: empty string / null / non-finite → null (a real
// "no weight" state); a valid value returns its string form.
function emptyToNull(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number") return Number.isFinite(v) ? v.toString() : null;
  return null;
}
