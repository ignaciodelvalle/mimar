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
    paper: { name: "Certificado Veterinario Internacional (CVI)", shortName: "CVI" },
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
    servesCorridors: [],
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

// Signed by a vet unless a test says otherwise: an UNKNOWN tier reads as
// declared (the check fails closed), which is not what these tests are about.
const ev = (eventType: string, occurredAt: string, payload: Record<string, unknown> = {}) =>
  ({
    eventType,
    occurredAt,
    payload,
    confidenceTier: "professional_verified",
  }) satisfies TravelComplianceEvent;
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

  it("no CVI yet: pending with its window, named the way the destination names its paper", () => {
    const o = window([]);
    expect(o.requirementLevel).toBe("warning");
    // Uruguay's window (60 days) opened long ago: the range starts TODAY.
    expect(o.state).toBe(
      "Pendiente: pedí el CVI Mercosur desde hoy y hasta el 15 de noviembre de 2026",
    );
    expect(o.label).toBe(
      "Certificado Veterinario Internacional (CVI) modelo Mercosur · ventana de emisión",
    );
  });

  it("a window that opens later names its first day (Chile, 10 days)", () => {
    const o = find(
      deriveTravelCompliance(input({ corridors: [getCorridor("chile")] })),
      "document_issuance_window_days:senasa_cvi",
    );
    expect(o.label).toBe("Certificado Zoosanitario de Importación (CZI) · ventana de emisión");
    expect(o.state).toBe(
      "Pendiente: pedí el CZI desde el 5 de noviembre de 2026 y hasta el 15 de noviembre de 2026",
    );
  });

  it("a lapsed window says what to do next", () => {
    const o = window([cvi("2026-08-01")]);
    expect(o.state).toBe(
      "El CVI Mercosur se emitió antes de la ventana. Consultá con tu veterinaria si conviene un certificado nuevo o mover la fecha del viaje.",
    );
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
  it("a complete Chile libreta reaches verde on the shipped corridor once every paper is ticked", () => {
    const chile = getCorridor("chile");
    // Before the owner ticks anything, the papers are the ONE pending item.
    const unticked = deriveTravelCompliance(
      input({ corridors: [chile], events: COMPLETE_CHILE_LIBRETA }),
    );
    expect(
      unticked.obligations.filter((o) => o.requirementLevel !== "info").map((o) => o.key),
    ).toEqual(["required_documents"]);
    expect(unticked.semaforo).toBe("amarillo");

    const papers = find(unticked, "required_documents").documents?.map((d) => d.label) ?? [];
    expect(papers.length).toBeGreaterThan(0);
    const state = deriveTravelCompliance(
      input({ corridors: [chile], events: COMPLETE_CHILE_LIBRETA, confirmedDocuments: papers }),
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

// ---------------------------------------------------------------------------
// v14 — declared vs verified (QA 2026-10-07 bug 1, PO 2026-10-07)
// ---------------------------------------------------------------------------

describe("declared vs verified — only a vet or an institution verifies a travel fact", () => {
  const chile = [getCorridor("chile")];
  const tiered = (e: TravelComplianceEvent, tier: TravelComplianceEvent["confidenceTier"]) => ({
    ...e,
    confidenceTier: tier,
  });
  const wait = (events: TravelComplianceEvent[]) =>
    find(
      deriveTravelCompliance(input({ corridors: chile, events })),
      "rabies_vaccination_to_travel_wait_days",
    );

  it("a vet's antirrábica meets the wait: verified, Ya está", () => {
    const o = wait([tiered(rabies("2026-09-01T15:00:00Z"), "professional_verified")]);
    expect(o.requirementLevel).toBe("info");
    expect(o.evidence).toBe("verified");
  });

  it("the owner's own antirrábica stays at Atención, says so, and is never Ya está", () => {
    const o = wait([tiered(rabies("2026-09-01T15:00:00Z"), "self_reported")]);
    expect(o.requirementLevel).toBe("warning");
    expect(o.evidence).toBe("declared");
    expect(o.state).toBe(
      "Registrada en la libreta, sin verificación profesional. Para el viaje cuenta el registro de un veterinario matriculado.",
    );
  });

  it("an organisation without matrícula only declares (org_registered)", () => {
    const o = wait([tiered(rabies("2026-09-01T15:00:00Z"), "org_registered")]);
    expect(o.evidence).toBe("declared");
    expect(o.requirementLevel).toBe("warning");
  });

  it("an institution verifies (institutional_verified)", () => {
    const o = wait([tiered(rabies("2026-09-01T15:00:00Z"), "institutional_verified")]);
    expect(o.evidence).toBe("verified");
  });

  it("nothing on record is evidence none, with the verified reading's state", () => {
    const o = wait([]);
    expect(o.evidence).toBe("none");
    expect(o.state).toBe("Pendiente");
  });

  it("a declared dose too recent for the wait counts AGAINST readiness", () => {
    // Applied 5 days before travel, by the owner: a newer dose restarts the
    // wait whoever wrote it, even over a vet's older dose that met it.
    const o = wait([
      tiered(rabies("2026-09-01T15:00:00Z"), "professional_verified"),
      tiered(rabies("2026-11-10T15:00:00Z"), "self_reported"),
    ]);
    expect(o.evidence).toBe("none");
    expect(o.requirementLevel).toBe("blocker");
    expect(o.state).toBe("La última dosis no llega a la espera antes del viaje");
  });

  it("a declared AND a verified record: the verified one wins", () => {
    const o = wait([
      tiered(rabies("2026-08-01T15:00:00Z"), "self_reported"),
      tiered(rabies("2026-09-01T15:00:00Z"), "professional_verified"),
    ]);
    expect(o.evidence).toBe("verified");
    expect(o.requirementLevel).toBe("info");
  });

  it("an entry whose author is unknown reads as declared — the check fails closed", () => {
    const o = wait([tiered(rabies("2026-09-01T15:00:00Z"), null)]);
    expect(o.evidence).toBe("declared");
    expect(o.requirementLevel).toBe("warning");
  });

  it("a fully declared Chile libreta never reaches verde, even with every paper ticked", () => {
    const declared = COMPLETE_CHILE_LIBRETA.map((e) =>
      e.eventType === "movement_recorded" ? e : tiered(e, "self_reported"),
    );
    const papers =
      find(
        deriveTravelCompliance(input({ corridors: chile, events: declared })),
        "required_documents",
      ).documents?.map((d) => d.label) ?? [];
    const state = deriveTravelCompliance(
      input({ corridors: chile, events: declared, confirmedDocuments: papers }),
    );
    expect(state.semaforo).toBe("amarillo");
    const declaredOnes = state.obligations.filter((o) => o.evidence === "declared");
    expect(declaredOnes.map((o) => o.key).sort()).toEqual(
      [
        "microchip_required",
        "parasite_treatment_window_days",
        "rabies_vaccination_to_travel_wait_days",
        "required_vaccines",
      ].sort(),
    );
    for (const o of declaredOnes) expect(o.requirementLevel, o.id).toBe("warning");
  });

  it("the owner's own CVI and weight still count: they are the owner's to record", () => {
    const o = find(
      deriveTravelCompliance(
        input({
          corridors: [getCorridor("uruguay")],
          events: [tiered(cvi("2026-11-01"), "self_reported")],
        }),
      ),
      "document_issuance_window_days:senasa_cvi",
    );
    expect(o.requirementLevel).toBe("info");
  });

  it("a vet's chip and the OWNER's revocation: no chip, whoever revoked it (review HIGH)", () => {
    const revoked = ev("microchip_replaced", "2026-09-20T15:00:00Z", {
      old_chip_number: "032000000000001",
      new_chip_number: null,
    });
    const state = deriveTravelCompliance(
      input({
        corridors: chile,
        events: [chip("2024-01-10T15:00:00Z"), tiered(revoked, "self_reported")],
      }),
    );
    const o = find(state, "microchip_required");
    expect(o.requirementLevel).not.toBe("info");
    expect(o.evidence).not.toBe("verified");
    expect(o.state).toBe("Sin microchip registrado");
    expect(state.semaforo).not.toBe("verde");
  });

  it("the owner's chip replacement keeps the chip-before-rabies order amber", () => {
    const replaced = ev("microchip_replaced", "2026-09-20T15:00:00Z", {
      old_chip_number: "032000000000001",
      new_chip_number: "032000000000002",
    });
    const o = find(
      deriveTravelCompliance(
        input({
          corridors: [getCorridor("ue_espana")],
          events: [
            chip("2024-01-10T15:00:00Z"),
            rabies("2026-06-01T15:00:00Z"),
            tiered(replaced, "self_reported"),
          ],
        }),
      ),
      "microchip_before_vaccination_required",
    );
    expect(o.requirementLevel).toBe("warning");
    expect(o.state).toBe("El microchip fue reemplazado: verificá el orden con tu veterinario");
  });

  it("an age check rests on the owner-typed birth date: it claims no evidence", () => {
    const state = deriveTravelCompliance(input({ corridors: [getCorridor("usa")] }));
    expect(find(state, "min_animal_age_days").evidence).toBeUndefined();
  });

  it("only the libreta's answers carry evidence; papers and destination rules do not", () => {
    const state = deriveTravelCompliance(input({ corridors: chile }));
    expect(find(state, "required_documents").evidence).toBeUndefined();
    expect(find(state, "document_issuance_window_days:senasa_cvi").evidence).toBeUndefined();
    expect(find(state, "microchip_required").evidence).toBe("none");
  });
});

describe("v14 copy — papers only, the paper's own name, next steps", () => {
  it("required_documents lists papers, never a microchip or an antiparasitario (QA copy 2)", () => {
    for (const id of ["chile", "uruguay", "brasil", "ue_espana", "usa"] as const) {
      const state = deriveTravelCompliance(input({ corridors: [getCorridor(id)] }));
      const labels = find(state, "required_documents").documents?.map((d) => d.label) ?? [];
      expect(labels.length, id).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label, id).not.toMatch(/microchip|antiparasitario|examen clínico/i);
      }
    }
  });

  it("Chile's microchip requirement is 'Microchip o tatuaje' (QA copy 7); the UE's is not", () => {
    const chile = deriveTravelCompliance(input({ corridors: [getCorridor("chile")] }));
    expect(find(chile, "microchip_required").label).toBe("Microchip o tatuaje");
    const ue = deriveTravelCompliance(input({ corridors: [getCorridor("ue_espana")] }));
    expect(find(ue, "microchip_required").label).toBe("Microchip");
  });

  it("the deworming window is worded against the destination's paper", () => {
    const o = find(
      deriveTravelCompliance(input({ corridors: [getCorridor("chile")] })),
      "parasite_treatment_window_days",
    );
    expect(o.detail).toBe("Antiparasitario interno y externo entre 5 y 30 días antes del CZI");
  });

  it("a lapsed rabies wait says what to do next (QA copy 6)", () => {
    const close = new Date("2026-10-15T00:00:00Z");
    const o = find(
      deriveTravelCompliance(input({ corridors: [getCorridor("chile")], travelDate: close })),
      "rabies_vaccination_to_travel_wait_days",
    );
    expect(o.requirementLevel).toBe("blocker");
    expect(o.state).toBe(
      "Plazo vencido: aunque se vacune hoy, no llega a los 21 días antes del viaje. Consultá con tu veterinaria si conviene mover la fecha del viaje.",
    );
  });

  it("a deworming missing before the issued paper says what to do next", () => {
    const o = find(
      deriveTravelCompliance(
        input({ corridors: [getCorridor("chile")], events: [cvi("2026-11-08")] }),
      ),
      "parasite_treatment_window_days",
    );
    expect(o.state).toBe(
      "Sin antiparasitario registrado dentro de la ventana antes del CZI del 8 de noviembre de 2026. Consultá con tu veterinaria si conviene un certificado nuevo o mover la fecha del viaje.",
    );
  });
});
