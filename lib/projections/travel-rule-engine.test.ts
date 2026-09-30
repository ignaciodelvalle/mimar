// The travel rule engine (viajes-fase-2 Phase 3, design D2/D3): corridor +
// airline merge with provenance, freshness degradation, and the checks that
// used to be only displayed — now asked of the libreta.
//
// Spec scenarios covered: "Airline tighter", "No airline selected",
// "Microchip before rabies", "USA minimum dog age", "Chile deworming window",
// "Unverified never green", "Attributed breed restriction", "Expired rule",
// and the honesty-and-copy forbidden strings.

import { describe, expect, it } from "vitest";

import type { Sourced } from "@/lib/domain/travel-freshness";
import type { TravelRuleValueByType } from "@/lib/domain/travel-strictness";
import {
  type TravelComplianceEvent,
  type TravelComplianceInput,
  type TravelComplianceState,
  type TravelObligation,
  deriveTravelCompliance,
} from "@/lib/projections/travel-compliance";
import { type Airline, getAirline } from "@/lib/reference/airlines";
import {
  type Corridor,
  type CorridorRules,
  getCorridor,
} from "@/lib/reference/cross-border-corridors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-01T15:00:00Z");
const TRAVEL = new Date("2026-11-15T00:00:00Z");

type PlainRules = { [K in keyof TravelRuleValueByType]?: TravelRuleValueByType[K] };

function sourced<T>(value: T, overrides: Partial<Sourced<T>> = {}): Sourced<T> {
  return {
    value,
    sourceUrl: "https://example.gov/fuente",
    lastVerifiedAt: "2026-09-30",
    reviewBy: "2026-12-29",
    verification: "verified",
    ...overrides,
  };
}

function corridor(
  id: Corridor["id"],
  label: string,
  plain: PlainRules,
  meta: Partial<Sourced<unknown>> = {},
): Corridor {
  const rules: Record<string, unknown> = {};
  for (const [ruleType, value] of Object.entries(plain)) rules[ruleType] = sourced(value, meta);
  return {
    id,
    label,
    jurisdiction: { country: "XX" },
    version: "test",
    effectiveFrom: "2026-09-30",
    sourceUrl: "https://example.gov/fuente",
    lastVerifiedAt: "2026-09-30",
    reviewBy: "2027-03-29",
    appliesTo: { species: ["dog", "cat"], direction: "outbound_from_ar" },
    rules: rules as CorridorRules,
  };
}

function airline(modalities: Airline["modalities"], name = "Aerolínea Test"): Airline {
  return {
    id: "latam",
    name,
    iata: "XX",
    scope: "international",
    sourceUrl: "https://example.com/mascotas",
    lastVerifiedAt: "2026-09-30",
    reviewBy: "2026-12-29",
    modalities,
  };
}

const DOG = {
  species: "dog",
  dateOfBirth: "2023-01-10",
  birthDateIsEstimated: false,
  breed: "Labrador Retriever",
};

function input(overrides: Partial<TravelComplianceInput>): TravelComplianceInput {
  return {
    now: NOW,
    origin: { country: "AR" },
    destinations: [],
    corridors: [],
    travelDate: TRAVEL,
    events: [],
    pet: DOG,
    ...overrides,
  };
}

const ev = (eventType: string, occurredAt: string, payload: Record<string, unknown> = {}) =>
  ({ eventType, occurredAt, payload }) satisfies TravelComplianceEvent;
const rabies = (at: string) => ev("vaccination_administered", at, { vaccine_name: "Antirrábica" });
const chip = (at: string, extra: Record<string, unknown> = {}) =>
  ev("microchip_implanted", at, { chip_number: "032000000000001", ...extra });
const deworm = (at: string, type: "internal" | "external" | "both") =>
  ev("deworming_administered", at, { product: "X", type, next_due_at: null });
const cvi = (issued: string, extra: Record<string, unknown> = {}) =>
  ev("movement_recorded", `${issued}T15:00:00Z`, {
    sub_kind: "cvi_issued",
    origin_country: "AR",
    cvi_number: "CVI-1",
    issuing_authority: "SENASA",
    issued_date: issued,
    chip_iso_country_code: null,
    ...extra,
  });

function find(state: TravelComplianceState, id: string): TravelObligation {
  const found = state.obligations.find((o) => o.id === id);
  if (!found) {
    throw new Error(`no obligation ${id}: ${state.obligations.map((o) => o.id).join(", ")}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Corridor + airline merge (spec: Merge corridor and airline rules)
// ---------------------------------------------------------------------------

describe("merge — corridor and airline, strictest wins, source kept", () => {
  const uy = corridor("uruguay", "Uruguay", { document_issuance_window_days: 60 });
  const tight = airline({
    cabin: {
      offered: sourced("yes" as const),
      requiredDocuments: sourced([
        { doc: "vet_health_certificate" as const, maxDaysBeforeFlight: 10 },
        { doc: "rabies_certificate" as const, minDaysSinceDose: 30 },
      ]),
    },
  });

  it("Airline tighter: a 60-day corridor window and a 10-day airline window give 10, from the airline", () => {
    const state = deriveTravelCompliance(
      input({ corridors: [uy], airline: tight, modality: "cabin" }),
    );
    const window = find(state, "document_issuance_window_days:senasa_cvi");
    expect(window.detail).toContain("10 días");
    expect(window.contributingJurisdictions).toEqual(["Aerolínea Test"]);
    expect(window.sources.map((s) => s.kind).sort()).toEqual(["airline", "corridor"]);
    expect(window.legalFootnote).toContain("verificá con tu aerolínea");
  });

  it("an airline's minDaysSinceDose beats the corridor's rabies wait (30 over 21)", () => {
    const state = deriveTravelCompliance(
      input({
        corridors: [corridor("uruguay", "Uruguay", { rabies_vaccination_to_travel_wait_days: 21 })],
        airline: tight,
        modality: "cabin",
      }),
    );
    expect(find(state, "rabies_vaccination_to_travel_wait_days").detail).toContain("30");
  });

  it("No airline selected: only corridor rules, and no airline section", () => {
    const state = deriveTravelCompliance(input({ corridors: [uy] }));
    expect(state.obligations.some((o) => o.group === "aerolinea")).toBe(false);
    expect(state.obligations.flatMap((o) => o.sources).some((s) => s.kind === "airline")).toBe(
      false,
    );
    expect(find(state, "document_issuance_window_days:senasa_cvi").detail).toContain("60 días");
  });

  it("an airline without a modality contributes nothing and asks for one", () => {
    const state = deriveTravelCompliance(input({ corridors: [uy], airline: tight }));
    const ask = find(state, "modality_not_selected");
    expect(ask.state).toBe("Elegí cabina, bodega o carga");
    expect(ask.requirementLevel).toBe("warning");
    expect(find(state, "document_issuance_window_days:senasa_cvi").detail).toContain("60 días");
  });

  it("a modality the airline does not offer blocks, attributed to the airline", () => {
    const state = deriveTravelCompliance(
      input({ airline: airline({ hold: { offered: sourced("no" as const) } }), modality: "hold" }),
    );
    const gate = find(state, "airline_modality");
    expect(gate.requirementLevel).toBe("blocker");
    expect(gate.state).toMatch(/^Según lo publicado por Aerolínea Test/);
  });

  it("a species the airline does not carry blocks", () => {
    const state = deriveTravelCompliance(
      input({
        airline: airline({
          cabin: { offered: sourced("yes" as const), species: sourced(["cat" as const]) },
        }),
        modality: "cabin",
      }),
    );
    expect(find(state, "airline_species").requirementLevel).toBe("blocker");
  });

  it("a floor above the ceiling is a blocker: incompatible windows", () => {
    const state = deriveTravelCompliance(
      input({
        corridors: [
          corridor("chile", "Chile", { parasite_treatment_min_days_before: 20 }),
          corridor("brasil", "Brasil", { parasite_treatment_window_days: 15 }),
        ],
      }),
    );
    const clash = find(state, "incompatible_windows:parasite_treatment_window_days");
    expect(clash.state).toBe("Ventanas incompatibles");
    expect(clash.requirementLevel).toBe("blocker");
    expect(clash.contributingJurisdictions.sort()).toEqual(["Brasil", "Chile"]);
  });
});

// ---------------------------------------------------------------------------
// Freshness (spec: travel-reference-freshness; design D2)
// ---------------------------------------------------------------------------

describe("freshness — degrade, never lower a blocker", () => {
  it("Expired rule: past reviewBy, an informational obligation becomes an amber 'Verificá'", () => {
    const stale = corridor(
      "chile",
      "Chile",
      { required_documents: ["CZI"] },
      { lastVerifiedAt: "2026-01-02", reviewBy: "2026-06-30" },
    );
    const state = deriveTravelCompliance(input({ corridors: [stale] }));
    const docs = find(state, "required_documents");
    expect(docs.requirementLevel).toBe("warning");
    expect(docs.freshnessNotice).toMatch(
      /^Verificá — dato sin revisar desde el 2 de enero de 2026/,
    );
    expect(state.semaforo).toBe("amarillo");
  });

  it("Unverified never green: an unverified airline datum reads amber", () => {
    const state = deriveTravelCompliance(
      input({
        airline: airline({
          cabin: {
            offered: sourced("yes" as const),
            bookingLeadHours: sourced(48, { verification: "unverified", note: "403" }),
          },
        }),
        modality: "cabin",
      }),
    );
    const booking = find(state, "booking_lead_hours");
    expect(booking.requirementLevel).toBe("warning");
    expect(booking.freshnessNotice).toBe("Verificá — dato sin confirmar con la fuente");
    expect(state.semaforo).not.toBe("verde");
  });

  it("a stale source never LOWERS a blocker", () => {
    const stale = corridor(
      "chile",
      "Chile",
      { rabies_vaccination_to_travel_wait_days: 21 },
      { verification: "unverified", note: "sin confirmar" },
    );
    const state = deriveTravelCompliance(
      input({ corridors: [stale], events: [rabies("2026-11-10T15:00:00Z")] }),
    );
    expect(find(state, "rabies_vaccination_to_travel_wait_days").requirementLevel).toBe("blocker");
  });
});

// ---------------------------------------------------------------------------
// Checks against the libreta (design D3)
// ---------------------------------------------------------------------------

describe("microchip before rabies", () => {
  const ue = [getCorridor("ue_espana")];
  const check = (events: TravelComplianceEvent[]) =>
    find(
      deriveTravelCompliance(input({ corridors: ue, events })),
      "microchip_before_vaccination_required",
    );

  it("an implant before the latest dose is registered (info)", () => {
    const o = check([chip("2025-01-10T15:00:00Z"), rabies("2026-03-01T15:00:00Z")]);
    expect(o.requirementLevel).toBe("info");
    expect(o.state).toMatch(/^Registrada en la libreta/);
  });

  it("a dose before the chip blocks: revaccinate", () => {
    const o = check([rabies("2025-01-10T15:00:00Z"), chip("2026-03-01T15:00:00Z")]);
    expect(o.requirementLevel).toBe("blocker");
    expect(o.state).toMatch(/revacunar/);
  });

  it("implant_date_known=false renders amber, never green", () => {
    const o = check([
      chip("2025-01-10T15:00:00Z", { implant_date_known: false }),
      rabies("2026-03-01T15:00:00Z"),
    ]);
    expect(o.requirementLevel).toBe("warning");
  });

  it("a replaced chip renders amber", () => {
    const o = check([
      chip("2025-01-10T15:00:00Z"),
      rabies("2026-03-01T15:00:00Z"),
      ev("microchip_replaced", "2026-04-01T15:00:00Z", { new_chip_number: "032000000000002" }),
    ]);
    expect(o.requirementLevel).toBe("warning");
  });
});

describe("microchip required (Chile, UE, USA dogs, Uruguay dogs)", () => {
  it("Chile without a chip on record: pending", () => {
    const state = deriveTravelCompliance(input({ corridors: [getCorridor("chile")] }));
    expect(find(state, "microchip_required").requirementLevel).toBe("warning");
  });

  it("Chile with a chip: registered", () => {
    const state = deriveTravelCompliance(
      input({ corridors: [getCorridor("chile")], events: [chip("2024-01-01T15:00:00Z")] }),
    );
    expect(find(state, "microchip_required").requirementLevel).toBe("info");
  });

  it("Uruguay's dog-only microchip does not apply to a cat", () => {
    const state = deriveTravelCompliance(
      input({
        corridors: [getCorridor("uruguay")],
        pet: { ...DOG, species: "cat", breed: "Persa" },
      }),
    );
    expect(state.obligations.find((o) => o.key === "microchip_required")).toBeUndefined();
  });
});

describe("minimum animal age — USA dogs 6 months", () => {
  const usa = [getCorridor("usa")];

  it("a dog under 6 months on the travel date blocks", () => {
    const state = deriveTravelCompliance(
      input({ corridors: usa, pet: { ...DOG, dateOfBirth: "2026-07-01" } }),
    );
    const age = find(state, "min_animal_age_days");
    expect(age.requirementLevel).toBe("blocker");
    expect(state.semaforo).toBe("rojo");
  });

  it("an adult dog is registered", () => {
    const state = deriveTravelCompliance(input({ corridors: usa }));
    expect(find(state, "min_animal_age_days").requirementLevel).toBe("info");
  });

  it("an ESTIMATED birth date is amber even when old enough", () => {
    const state = deriveTravelCompliance(
      input({ corridors: usa, pet: { ...DOG, birthDateIsEstimated: true } }),
    );
    expect(find(state, "min_animal_age_days").requirementLevel).toBe("warning");
  });

  it("no birth date is amber", () => {
    const state = deriveTravelCompliance(
      input({ corridors: usa, pet: { ...DOG, dateOfBirth: null } }),
    );
    expect(find(state, "min_animal_age_days").requirementLevel).toBe("warning");
  });

  it("the rule is dog-only: a cat gets no minimum-age obligation", () => {
    const state = deriveTravelCompliance(
      input({ corridors: usa, pet: { ...DOG, species: "cat", breed: "Persa" } }),
    );
    expect(state.obligations.find((o) => o.key === "min_animal_age_days")).toBeUndefined();
  });
});

describe("rabies minimum age at the dose (UE 84 days)", () => {
  it("a dose given before 12 weeks blocks: revaccinate", () => {
    const state = deriveTravelCompliance(
      input({
        corridors: [getCorridor("ue_espana")],
        pet: { ...DOG, dateOfBirth: "2026-05-01" },
        events: [rabies("2026-06-20T15:00:00Z")],
      }),
    );
    expect(find(state, "rabies_vaccination_min_age_days").requirementLevel).toBe("blocker");
  });
});

describe("deworming window — Chile 5–30 days before the CZI", () => {
  const chile = [getCorridor("chile")];
  const window = (events: TravelComplianceEvent[]) =>
    find(
      deriveTravelCompliance(input({ corridors: chile, events })),
      "parasite_treatment_window_days",
    );

  it("inside the window (10 days before the CZI): registered", () => {
    const o = window([cvi("2026-11-10"), deworm("2026-10-31T15:00:00Z", "both")]);
    expect(o.requirementLevel).toBe("info");
    // The floor and the ceiling are one obligation with both sources.
    expect(o.detail).toContain("entre 5 y 30 días");
  });

  it("too close to the CZI (3 days before): fails", () => {
    const o = window([cvi("2026-11-10"), deworm("2026-11-07T15:00:00Z", "both")]);
    expect(o.requirementLevel).toBe("blocker");
  });

  it("too early (40 days before): fails", () => {
    const o = window([cvi("2026-11-10"), deworm("2026-10-01T15:00:00Z", "both")]);
    expect(o.requirementLevel).toBe("blocker");
  });

  it("internal only: external coverage is missing", () => {
    const o = window([cvi("2026-11-10"), deworm("2026-10-31T15:00:00Z", "internal")]);
    expect(o.requirementLevel).toBe("blocker");
    expect(o.state).toMatch(/externo/);
  });

  it("one internal and one external dose cover it", () => {
    const o = window([
      cvi("2026-11-10"),
      deworm("2026-10-30T15:00:00Z", "internal"),
      deworm("2026-11-02T15:00:00Z", "external"),
    ]);
    expect(o.requirementLevel).toBe("info");
  });

  it("without a CVI, anchored on the travel date and capped at amber", () => {
    const o = window([deworm("2026-11-01T15:00:00Z", "both")]);
    expect(o.requirementLevel).toBe("warning");
  });

  it("the Chile floor is not a second obligation", () => {
    const state = deriveTravelCompliance(input({ corridors: chile }));
    expect(state.obligations.find((o) => o.key === "parasite_treatment_min_days_before")).toBe(
      undefined,
    );
  });
});

describe("CVI window", () => {
  const uy = [getCorridor("uruguay")];
  const window = (events: TravelComplianceEvent[]) =>
    find(
      deriveTravelCompliance(input({ corridors: uy, events })),
      "document_issuance_window_days:senasa_cvi",
    );

  it("issued inside the window: registered", () => {
    expect(window([cvi("2026-11-01")]).requirementLevel).toBe("info");
  });

  it("issued before the window opens: blocks", () => {
    expect(window([cvi("2026-08-01")]).requirementLevel).toBe("blocker");
  });

  it("valid_until before the trip: blocks", () => {
    expect(window([cvi("2026-11-01", { valid_until: "2026-11-10" })]).requirementLevel).toBe(
      "blocker",
    );
  });

  it("no CVI yet: pending with its window", () => {
    const o = window([]);
    expect(o.requirementLevel).toBe("warning");
    expect(o.state).toMatch(/^Pendiente: emitirlo entre el/);
  });

  it("the USA 5-day window is the miasis certificate's, and stays a warning", () => {
    const state = deriveTravelCompliance(input({ corridors: [getCorridor("usa")] }));
    const miasis = find(state, "document_issuance_window_days:miasis_certificate");
    expect(miasis.label).toMatch(/Miasis/);
    expect(miasis.requirementLevel).toBe("warning");
  });
});

describe("rabies antibody titre — where a destination demands it", () => {
  const titerCorridor = corridor("ue_espana", "Destino con titulación", {
    rabies_titer_test_required: true,
    rabies_titer_test_wait_days: 90,
  });
  const titer = (at: string) =>
    ev("clinical_info_logged", at, {
      sub_kind: "lab_work",
      title: "Titulación de anticuerpos antirrábicos (FAVN)",
      details: null,
      performed_by: null,
    });

  it("no titre on record: pending", () => {
    const state = deriveTravelCompliance(input({ corridors: [titerCorridor] }));
    expect(find(state, "rabies_titer_test_required").state).toBe("Sin titulación registrada");
  });

  it("a recorded titre is still amber — its result is not in the libreta", () => {
    const state = deriveTravelCompliance(
      input({ corridors: [titerCorridor], events: [titer("2026-05-01T15:00:00Z")] }),
    );
    const o = find(state, "rabies_titer_test_required");
    expect(o.requirementLevel).toBe("warning");
    expect(find(state, "rabies_titer_test_wait_days").requirementLevel).toBe("info");
  });

  it("a titre too recent for the wait blocks", () => {
    const state = deriveTravelCompliance(
      input({ corridors: [titerCorridor], events: [titer("2026-10-01T15:00:00Z")] }),
    );
    expect(find(state, "rabies_titer_test_wait_days").requirementLevel).toBe("blocker");
  });

  it("no shipped corridor demands a titre from Argentina", () => {
    for (const id of ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const) {
      const state = deriveTravelCompliance(input({ corridors: [getCorridor(id)] }));
      expect(
        state.obligations.find((o) => o.key === "rabies_titer_test_required"),
        id,
      ).toBe(undefined);
    }
  });
});

describe("airline breed and weight checks (shipped Iberia data)", () => {
  const iberia = getAirline("iberia");

  it("Attributed breed restriction: a Dogo Argentino in Iberia's hold", () => {
    const state = deriveTravelCompliance(
      input({
        corridors: [getCorridor("ue_espana")],
        airline: iberia,
        modality: "hold",
        pet: { ...DOG, breed: "Dogo Argentino" },
      }),
    );
    const breed = find(state, "breed_restrictions");
    expect(breed.state).toBe(
      "Según la política publicada por Iberia, el Dogo Argentino no viaja en bodega. Confirmalo con la aerolínea antes de reservar.",
    );
    expect(breed.requirementLevel).toBe("blocker");
    expect(JSON.stringify(state.obligations)).not.toMatch(/peligros/i);
  });

  it("a mixed breed cannot be confirmed against the list: amber", () => {
    const state = deriveTravelCompliance(
      input({ airline: iberia, modality: "hold", pet: { ...DOG, breed: "Mestizo" } }),
    );
    expect(find(state, "breed_restrictions").state).toBe(
      "No pudimos confirmar la raza con la lista de Iberia",
    );
  });

  it("over the cabin weight limit blocks", () => {
    const state = deriveTravelCompliance(
      input({
        airline: iberia,
        modality: "cabin",
        events: [ev("weight_recorded", "2026-09-01T15:00:00Z", { kg: "12" })],
      }),
    );
    expect(find(state, "max_weight_kg").requirementLevel).toBe("blocker");
  });
});

// ---------------------------------------------------------------------------
// Green is reachable, and nothing ever promises
// ---------------------------------------------------------------------------

const COMPLETE_CHILE_LIBRETA = [
  chip("2024-01-10T15:00:00Z"),
  rabies("2026-06-01T15:00:00Z"),
  cvi("2026-11-10"),
  deworm("2026-10-31T15:00:00Z", "both"),
];

describe("honesty and copy", () => {
  it("a complete Chile libreta reaches verde on the shipped corridor", () => {
    const state = deriveTravelCompliance(
      input({ corridors: [getCorridor("chile")], events: COMPLETE_CHILE_LIBRETA }),
    );
    expect(state.obligations.filter((o) => o.requirementLevel !== "info")).toEqual([]);
    expect(state.semaforo).toBe("verde");
  });

  it("no obligation ever says 'apto', 'cumple', 'cumplida' or 'listo para viajar'", () => {
    const scenarios: TravelComplianceInput[] = [
      input({ corridors: [getCorridor("chile")], events: COMPLETE_CHILE_LIBRETA }),
      input({ corridors: [getCorridor("chile")] }),
      input({ corridors: [getCorridor("usa")], pet: { ...DOG, dateOfBirth: "2026-08-01" } }),
      input({
        corridors: [getCorridor("ue_espana")],
        events: [rabies("2025-01-01T15:00:00Z"), chip("2026-01-01T15:00:00Z")],
      }),
      input({
        corridors: [getCorridor("brasil")],
        airline: getAirline("latam"),
        modality: "cabin",
      }),
      input({ corridors: [getCorridor("uruguay")], airline: getAirline("iberia") }),
    ];
    const forbidden = /\bapto\b|cumple|cumplida|listo para viajar/i;
    for (const scenario of scenarios) {
      for (const o of deriveTravelCompliance(scenario).obligations) {
        for (const text of [o.label, o.state, o.detail ?? "", o.legalFootnote]) {
          expect(text, o.id).not.toMatch(forbidden);
        }
      }
    }
  });
});
