// The app's Anotar picker is grouped by the web's own categories.
//
// WHY. The web's capture list (`anotar/CaptureOptionsList.tsx`) groups every act
// under the `category` its `ALL_CAPTURE_OPTIONS` row carries. The app's picker
// was thirteen ungrouped pills until it learned the same sections
// (`RECORD_KIND_GROUPS`, apps/mobile/src/pets/record-event-view-model.ts). A
// person who used one door must recognise the other, and a table restated on
// two platforms drifts the day one of them gains a row — so this reads both and
// fails when an act sits under a different heading on each side.
//
// THE BRIDGE IS WRITTEN OUT. The app picks `RecordKind`s, the web lists event
// types; the map below is the only place that pairs them, and it is total over
// the app's kinds (the last test fails when a kind is added without a pairing).

import { describe, expect, it } from "vitest";

import { ALL_CAPTURE_OPTIONS } from "@/app/(app)/mis-mascotas/[publicToken]/anotar/handoff";

import {
  RECORD_KINDS,
  RECORD_KIND_GROUPS,
  type RecordKind,
} from "../apps/mobile/src/pets/record-event-view-model";

const WEB_EVENT_TYPE: Record<RecordKind, string> = {
  vaccination: "vaccination_administered",
  weight: "weight_recorded",
  deworming: "deworming_administered",
  symptom: "symptom_observed",
  bite: "incident_reported",
  medication_start: "medication_started",
  vet_visit: "vet_visit_logged",
  clinical_info: "clinical_info_logged",
  sterilization: "sterilization_performed",
  microchip: "microchip_implanted",
  tattoo: "tattoo_recorded",
  note: "note_added",
};

/** The web's category for an event type — its plain row, not a route override. */
function webCategory(eventType: string): string | undefined {
  return ALL_CAPTURE_OPTIONS.find((o) => o.eventType === eventType && !o.routeOverride)?.category;
}

describe("the app's Anotar groups match the web's capture categories", () => {
  it("files every app kind under the web's category for the same act", () => {
    for (const group of RECORD_KIND_GROUPS) {
      for (const kind of group.kinds) {
        expect({ kind, category: webCategory(WEB_EVENT_TYPE[kind]) }).toEqual({
          kind,
          category: group.category,
        });
      }
    }
  });

  it("orders the groups as the web orders its categories", () => {
    const webOrder = Array.from(new Set(ALL_CAPTURE_OPTIONS.map((o) => o.category)));
    const appOrder = RECORD_KIND_GROUPS.map((g) => g.category);
    const webPositions = appOrder.map((c) => webOrder.indexOf(c));
    // Every app heading exists on the web…
    expect(webPositions.every((p) => p >= 0)).toBe(true);
    // …and they appear in the web's relative order.
    expect(webPositions).toEqual([...webPositions].sort((a, b) => a - b));
  });

  it("pairs every pickable kind with a web event type (non-vacuity)", () => {
    expect(Object.keys(WEB_EVENT_TYPE).sort()).toEqual([...RECORD_KINDS].sort());
    for (const kind of RECORD_KINDS) {
      expect(webCategory(WEB_EVENT_TYPE[kind])).toBeDefined();
    }
  });
});
