// Coverage guardrail for the libreta-sanitaria projection.
//
// Whenever EVENT_TYPES gains a new entry, the contributor MUST classify it as
// either part of the libreta (medical) or deliberately excluded (admin /
// custody / system). This test fails the build if a value falls through.

import { describe, expect, it } from "vitest";

import { EVENT_TYPES, type EventType } from "@/db/schema";
import {
  LIBRETA_FILTER_CHIPS,
  LIBRETA_SANITARIA_EVENT_TYPES,
  NON_LIBRETA_EVENT_TYPES,
  groupLibretaEvents,
  isLibretaSanitariaEvent,
  libretaConfidenceTier,
  libretaGroupForEvent,
} from "@/lib/infra/libreta-sanitaria";

describe("LIBRETA_SANITARIA_EVENT_TYPES coverage", () => {
  it("every EVENT_TYPES entry is classified exactly once", () => {
    const libretaSet = new Set<string>(LIBRETA_SANITARIA_EVENT_TYPES);
    const nonLibretaSet = new Set<string>(NON_LIBRETA_EVENT_TYPES);
    const unclassified: string[] = [];
    const doubleClassified: string[] = [];

    for (const t of EVENT_TYPES) {
      const inLibreta = libretaSet.has(t);
      const inNonLibreta = nonLibretaSet.has(t);
      if (!inLibreta && !inNonLibreta) unclassified.push(t);
      if (inLibreta && inNonLibreta) doubleClassified.push(t);
    }

    expect(
      unclassified,
      "Unclassified event types — add to LIBRETA_SANITARIA_EVENT_TYPES or NON_LIBRETA_EVENT_TYPES",
    ).toEqual([]);
    expect(doubleClassified, "Event types appear in both lists").toEqual([]);
  });

  it("LIBRETA_FILTER_CHIPS only references libreta event types", () => {
    for (const chip of LIBRETA_FILTER_CHIPS) {
      expect(
        isLibretaSanitariaEvent(chip.type),
        `Chip ${chip.type} (${chip.label}) is not in LIBRETA_SANITARIA_EVENT_TYPES`,
      ).toBe(true);
    }
  });

  it("isLibretaSanitariaEvent returns the right answer for known types", () => {
    expect(isLibretaSanitariaEvent("vaccination_administered" satisfies EventType)).toBe(true);
    expect(isLibretaSanitariaEvent("pet_registered" satisfies EventType)).toBe(false);
    expect(isLibretaSanitariaEvent("credential_scanned" satisfies EventType)).toBe(false);
    expect(isLibretaSanitariaEvent("weight_recorded" satisfies EventType)).toBe(true);
  });
});

describe("libretaGroupForEvent", () => {
  it("maps direct event types to their group", () => {
    expect(libretaGroupForEvent({ eventType: "vaccination_administered", payload: {} })).toBe(
      "vacunas",
    );
    expect(libretaGroupForEvent({ eventType: "deworming_administered", payload: {} })).toBe(
      "antiparasitarios",
    );
    expect(libretaGroupForEvent({ eventType: "vet_visit_logged", payload: {} })).toBe("visitas");
    expect(libretaGroupForEvent({ eventType: "weight_recorded", payload: {} })).toBe("peso");
    expect(libretaGroupForEvent({ eventType: "death_recorded", payload: {} })).toBe(
      "fallecimiento",
    );
    expect(libretaGroupForEvent({ eventType: "medication_started", payload: {} })).toBe(
      "medicacion",
    );
    expect(libretaGroupForEvent({ eventType: "medication_dose_taken", payload: {} })).toBe(
      "medicacion",
    );
    expect(libretaGroupForEvent({ eventType: "symptom_observed", payload: {} })).toBe("sintomas");
  });

  it("folds esterilización into the cirugías section", () => {
    // sterilization_performed is a surgery; the 2026-05-26 consolidation
    // dropped the dedicated "esterilizacion" group and surfaces these
    // events alongside clinical_info_logged{sub_kind:'surgery'}.
    expect(libretaGroupForEvent({ eventType: "sterilization_performed", payload: {} })).toBe(
      "cirugias",
    );
  });

  it("merges microchip + tatuaje into the identificacion section", () => {
    // Owners think "how is the pet identified", not "chip vs tattoo".
    expect(libretaGroupForEvent({ eventType: "microchip_implanted", payload: {} })).toBe(
      "identificacion",
    );
    expect(libretaGroupForEvent({ eventType: "microchip_replaced", payload: {} })).toBe(
      "identificacion",
    );
    expect(libretaGroupForEvent({ eventType: "tattoo_recorded", payload: {} })).toBe(
      "identificacion",
    );
    expect(libretaGroupForEvent({ eventType: "tattoo_updated", payload: {} })).toBe(
      "identificacion",
    );
  });

  it("routes bite + rabies observation lifecycle into a single legal section", () => {
    expect(libretaGroupForEvent({ eventType: "incident_reported", payload: {} })).toBe(
      "mordeduras_observacion",
    );
    expect(libretaGroupForEvent({ eventType: "rabies_observation_started", payload: {} })).toBe(
      "mordeduras_observacion",
    );
    expect(libretaGroupForEvent({ eventType: "rabies_observation_ended", payload: {} })).toBe(
      "mordeduras_observacion",
    );
  });

  it("splits clinical_info_logged by sub_kind", () => {
    expect(
      libretaGroupForEvent({ eventType: "clinical_info_logged", payload: { sub_kind: "surgery" } }),
    ).toBe("cirugias");
    expect(
      libretaGroupForEvent({
        eventType: "clinical_info_logged",
        payload: { sub_kind: "lab_work" },
      }),
    ).toBe("estudios");
    expect(
      libretaGroupForEvent({ eventType: "clinical_info_logged", payload: { sub_kind: "imaging" } }),
    ).toBe("estudios");
    // allergy_detection used to land in its own "alergias" group; after the
    // 2026-05-26 consolidation those events live under "Estudios e
    // información clínica" and the persistent condition list lives in the
    // dashboard at the top of /libreta.
    expect(
      libretaGroupForEvent({
        eventType: "clinical_info_logged",
        payload: { sub_kind: "allergy_detection" },
      }),
    ).toBe("estudios");
    // Unknown / missing sub_kind defaults to "estudios" so the event stays visible.
    expect(libretaGroupForEvent({ eventType: "clinical_info_logged", payload: {} })).toBe(
      "estudios",
    );
    expect(
      libretaGroupForEvent({
        eventType: "clinical_info_logged",
        payload: { sub_kind: "future_kind" },
      }),
    ).toBe("estudios");
  });

  it("returns null for non-libreta events", () => {
    expect(libretaGroupForEvent({ eventType: "pet_registered", payload: {} })).toBeNull();
    expect(libretaGroupForEvent({ eventType: "credential_scanned", payload: {} })).toBeNull();
    expect(libretaGroupForEvent({ eventType: "note_added", payload: {} })).toBeNull();
  });
});

describe("groupLibretaEvents", () => {
  it("groups events by clinical purpose and drops non-libreta entries", () => {
    const events = [
      { id: "1", eventType: "vaccination_administered", payload: { vaccine_name: "Antirrábica" } },
      { id: "2", eventType: "weight_recorded", payload: { kg: "12" } },
      { id: "3", eventType: "vaccination_administered", payload: { vaccine_name: "Triple" } },
      { id: "4", eventType: "pet_registered", payload: {} },
      { id: "5", eventType: "clinical_info_logged", payload: { sub_kind: "surgery" } },
    ];
    const grouped = groupLibretaEvents(events);
    expect(grouped.vacunas.map((e) => e.id)).toEqual(["1", "3"]);
    expect(grouped.peso.map((e) => e.id)).toEqual(["2"]);
    expect(grouped.cirugias.map((e) => e.id)).toEqual(["5"]);
    expect(grouped.visitas).toHaveLength(0);
  });

  it("preserves insertion order within each group", () => {
    const events = [
      { id: "a", eventType: "weight_recorded", payload: { kg: "10" } },
      { id: "b", eventType: "weight_recorded", payload: { kg: "11" } },
      { id: "c", eventType: "weight_recorded", payload: { kg: "12" } },
    ];
    const grouped = groupLibretaEvents(events);
    expect(grouped.peso.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// libretaConfidenceTier — confidence tier helper for libreta entries
// ---------------------------------------------------------------------------

describe("libretaConfidenceTier", () => {
  it("vet verified → professional_verified", () => {
    expect(
      libretaConfidenceTier({
        authorRole: "vet",
        authorVerified: true,
        authorOrganizationId: null,
        payload: {},
      }),
    ).toBe("professional_verified");
  });

  it("shelter verified with org → institutional_verified", () => {
    expect(
      libretaConfidenceTier({
        authorRole: "shelter",
        authorVerified: true,
        authorOrganizationId: "org-abc",
        payload: {},
      }),
    ).toBe("institutional_verified");
  });

  it("owner alone → self_reported", () => {
    expect(
      libretaConfidenceTier({
        authorRole: "owner",
        authorVerified: false,
        authorOrganizationId: null,
        payload: {},
      }),
    ).toBe("self_reported");
  });

  it("any role with confirmed_by_lab=true → institutional_verified (A4 bumper)", () => {
    expect(
      libretaConfidenceTier({
        authorRole: "vet",
        authorVerified: false,
        authorOrganizationId: null,
        payload: { confirmed_by_lab: true },
      }),
    ).toBe("institutional_verified");
  });

  it("scanner → unverified", () => {
    expect(
      libretaConfidenceTier({
        authorRole: "scanner",
        authorVerified: false,
        authorOrganizationId: null,
        payload: {},
      }),
    ).toBe("unverified");
  });
});
