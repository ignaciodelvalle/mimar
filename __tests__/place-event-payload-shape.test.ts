// Fence: every place-bearing event keeps its place AS ENTERED and AS RESOLVED.
//
// localidades-por-id, cross-cutting "Event origin preservation" (P2: never lose
// an event's origin place). The flat `jurisdiction_*` keys some payloads carry
// are two display strings: they say neither what the person entered (the
// names, the id their picker had) nor which catalogue row it resolved to, if
// any. A bite pinned in a homonym, a lost report whose place never resolved
// and a vaccination in a locality INDEC later renames are indistinguishable in
// the spine from a clean, resolved place.
//
// Each family below must accept `place: { entered, resolved }`, where
// `resolved` is `null` when the place did not resolve to exactly one catalogue
// row. The schemas are `.strict()`, so an unknown `place` key is REFUSED — this
// file reads that refusal, which needs no fixture payload per family: a key the
// schema does not know is reported as unrecognised whatever else is missing.
//
// Moves (`movement_recorded` / `jurisdiction_changed`) are not listed: they
// already carry `from_locality_id` and `to_locality_id` beside their names.
//
// `entered` holds the PLACE the person gave (province, locality, INDEC id) and
// not the point or the address: those already live on the event row
// (`location_lat`/`location_lng`, `location_description`) under the erasure
// policy in lib/events/payload-privacy.ts, which coarsens the point and blanks
// the address. A second copy inside `place` would be personal data that policy
// does not reach.

import { describe, expect, it } from "vitest";

import { PayloadSchemas } from "@/lib/events/event-schemas";
import type { EventType } from "@dim/contract/events";

const RESOLVED_PLACE = {
  entered: { province: "Córdoba", locality: "Villa María", indec_id: "14042170" },
  resolved: {
    locality_id: "00000000-0000-4000-8000-0000000014e2",
    province_code: "AR-X",
    method: "indec_id",
  },
};

const UNRESOLVED_PLACE = {
  entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
  resolved: null,
};

/** Does this family's schema refuse `place` as a key it does not know? */
function refusesPlaceKey(eventType: EventType, payload: Record<string, unknown>): boolean {
  const schema = PayloadSchemas[eventType];
  if (!schema) throw new Error(`no schema registered for ${eventType}`);
  const result = schema.safeParse(payload);
  if (result.success) return false;
  return result.error.issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" && (issue as { keys: string[] }).keys.includes("place"),
  );
}

describe("sanity: the probe sees an unknown key", () => {
  it("a key no schema knows is reported as unrecognised", () => {
    const schema = PayloadSchemas.incident_reported;
    const result = schema?.safeParse({ not_a_field: 1 });
    expect(result?.success).toBe(false);
    expect(
      result?.success === false &&
        result.error.issues.some(
          (i) =>
            i.code === "unrecognized_keys" &&
            (i as { keys: string[] }).keys.includes("not_a_field"),
        ),
    ).toBe(true);
  });
});

describe("place-bearing families accept place: { entered, resolved }", () => {
  // Known failure until work unit A8 (localidades-por-id): flip each to `it` there.
  it.fails("pet_registered", () => {
    expect(refusesPlaceKey("pet_registered", { place: RESOLVED_PLACE })).toBe(false);
  });
  it.fails("status_changed (lost report)", () => {
    expect(refusesPlaceKey("status_changed", { place: RESOLVED_PLACE })).toBe(false);
  });
  it.fails("incident_reported (bite)", () => {
    expect(refusesPlaceKey("incident_reported", { place: UNRESOLVED_PLACE })).toBe(false);
  });
  it.fails("outbreak_signal", () => {
    expect(refusesPlaceKey("outbreak_signal", { place: RESOLVED_PLACE })).toBe(false);
  });
  it.fails("vet_visit_logged", () => {
    expect(refusesPlaceKey("vet_visit_logged", { place: RESOLVED_PLACE })).toBe(false);
  });
  it.fails("clinical_info_logged", () => {
    expect(refusesPlaceKey("clinical_info_logged", { place: RESOLVED_PLACE })).toBe(false);
  });
  it.fails("post_adoption_checkin", () => {
    expect(refusesPlaceKey("post_adoption_checkin", { place: RESOLVED_PLACE })).toBe(false);
  });

  // Known failure until work unit A5 (localidades-por-id): flip to `it` there.
  it.fails("note_added (last-seen update, sighting)", () => {
    expect(refusesPlaceKey("note_added", { place: UNRESOLVED_PLACE })).toBe(false);
  });
});
