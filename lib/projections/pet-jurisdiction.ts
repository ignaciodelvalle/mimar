// Projection: derive the pet's jurisdiction from the event log.
//
// `pets.jurisdiction_country / _province / _locality` (and the denormalized
// `locality_id`) are operational caches over two event sources:
//
//   - pet_registered.payload.jurisdiction_province / _locality — where the pet
//     was first registered. Country is not in that payload; AR is the only
//     value the registration path writes, so it is the floor here.
//   - movement_recorded(sub_kind="jurisdiction_changed").payload.to_country /
//     to_province / to_locality — a move. LATEST-BY-occurredAt wins, matching
//     refreshJurisdiction on the amendment path.
//
// RAW ON PURPOSE. This returns the payload values UNCANONICALIZED. The write
// path runs them through normalizeLocationForWrite (async, DB-backed: it
// rewrites province/locality to catalog spelling and resolves locality_id), and
// a pure function cannot do that. Canonicalizing is the ORCHESTRATOR's job —
// see rederivePetCache, which applies the exact same normalizer to this output
// before comparing. Same function on both sides means a canonicalized move can
// never register as drift.
//
// Returns NULL when the stream carries no jurisdiction-bearing event at all.
// That is not "the pet has no jurisdiction" — it is "the spine has nothing to
// compare the cache against", which is a different statement and the caller must
// not collapse the two. Pets inserted directly (seeds, fixtures, legacy rows
// predating pet_registered's jurisdiction fields) land here; treating their
// populated column as drift against a derived null would fill the drift report
// with noise and get the whole check muted.
//
// Pure function. Caller orders events ascending by (occurredAt, recordedAt, id).

import type { AmendmentOverlaid, ProjectionEvent } from "./types";

export type PetJurisdictionProjection = {
  jurisdictionCountry: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

export function replayPetJurisdiction(
  events: AmendmentOverlaid<ProjectionEvent>,
): PetJurisdictionProjection | null {
  // Iterate from the end: the latest jurisdiction-bearing event wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const payload = (e.payload ?? {}) as Record<string, unknown>;

    if (e.eventType === "movement_recorded") {
      if (payload.sub_kind !== "jurisdiction_changed") continue;
      // to_country is required by the schema; province/locality are nullable
      // (a move to a province with no locality named is legitimate).
      return {
        jurisdictionCountry: str(payload.to_country) ?? "AR",
        jurisdictionProvince: str(payload.to_province),
        jurisdictionLocality: str(payload.to_locality),
      };
    }

    if (e.eventType === "pet_registered") {
      return {
        jurisdictionCountry: "AR",
        jurisdictionProvince: str(payload.jurisdiction_province),
        jurisdictionLocality: str(payload.jurisdiction_locality),
      };
    }
  }
  return null;
}

/**
 * The catalogue row the pet's LATEST jurisdiction-bearing event recorded
 * (localidades-por-id B5) — `pet_registered.jurisdiction_locality_id`, or its
 * `place.resolved.locality_id`, or a move's `to_locality_id`.
 *
 * `null` = NOT COMPARABLE: no jurisdiction-bearing event, or the latest one
 * predates the field (the key is absent, which is not the same statement as
 * "recorded no row"). `{ localityId: null }` = the event recorded that no row
 * was resolved. The same latest-by-occurredAt rule as `replayPetJurisdiction`,
 * so the id and the names always come from the same event.
 */
export function replayPetLocalityId(
  events: AmendmentOverlaid<ProjectionEvent>,
): { localityId: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const payload = (e.payload ?? {}) as Record<string, unknown>;

    if (e.eventType === "movement_recorded") {
      if (payload.sub_kind !== "jurisdiction_changed") continue;
      if (!("to_locality_id" in payload)) return null;
      return { localityId: str(payload.to_locality_id) };
    }

    if (e.eventType === "pet_registered") {
      const place = payload.place as { resolved?: { locality_id?: unknown } | null } | undefined;
      if (place && typeof place === "object" && "resolved" in place) {
        return { localityId: str(place.resolved?.locality_id) };
      }
      if (!("jurisdiction_locality_id" in payload)) return null;
      return { localityId: str(payload.jurisdiction_locality_id) };
    }
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
