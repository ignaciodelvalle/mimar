// `travel-view-model` — arrangement and forms, never a verdict.
//
// WHAT THESE PROVE
//   1. The semáforo's colour maps to a tone and nothing more; `sin_datos` is
//      neutral, never green or amber.
//   2. The airline group appears only when the trip names an airline, and its
//      notice is the CONTRACT's wording (shared with the web).
//   3. The forms go through the contract's own schema: a blank picker is a
//      field sentence, a typed DD/MM/AAAA date reaches the wire as YYYY-MM-DD.
//   4. A replay reads as done, never as a refusal.
//   5. The calendar bounds mirror the server's windows.

import { describe, expect, it } from "@jest/globals";

import {
  PET_TRAVEL_AIRLINE_NOTICE,
  PET_TRAVEL_SEMAFORO_LABELS,
  type PetTravelComplianceV1,
  type PetTravelObligationV1,
  type PetTravelTripV1,
} from "@dim/contract/api";

import {
  EMPTY_CVI_DRAFT,
  EMPTY_TRIP_DRAFT,
  buildCancelTrip,
  buildConfirmDocument,
  buildCvi,
  buildTrip,
  cviIssuedBounds,
  cviLine,
  documentStatusLine,
  obligationDocuments,
  obligationSections,
  selectedTrip,
  semaforoTone,
  sourceLine,
  travelAckMessage,
  travelDateBounds,
  tripLabel,
  tripSummary,
} from "./travel-view-model";

const TRIP: PetTravelTripV1 = {
  tripEventId: "11111111-1111-4111-8111-111111111111",
  corridorId: "chile",
  corridorLabel: "Chile",
  travelDate: "2026-11-12",
  mode: "air",
  airlineId: "latam",
  airlineName: "LATAM",
  intendedModality: "cabin",
};

function obligation(over: Partial<PetTravelObligationV1>): PetTravelObligationV1 {
  return {
    id: "o1",
    group: "destino",
    label: "Vacuna antirrábica",
    state: "Registrada en la libreta",
    detail: null,
    requirementLevel: "blocker",
    contributingJurisdictions: ["Chile"],
    sources: [],
    freshnessNotice: null,
    legalFootnote: "Res. SENASA",
    ...over,
  };
}

function compliance(obligations: PetTravelObligationV1[]): PetTravelComplianceV1 {
  return {
    semaforo: "amarillo",
    semaforoLabel: "Revisar pendientes",
    obligations,
    corridors: [],
  };
}

describe("reading", () => {
  it("maps each semáforo to a tone, and sin_datos to neutral", () => {
    expect(semaforoTone("rojo")).toBe("err");
    expect(semaforoTone("amarillo")).toBe("warn");
    expect(semaforoTone("verde")).toBe("ok");
    expect(semaforoTone("sin_datos")).toBe("neutral");
  });

  // PO 2026-10-01. The server draws `semaforoLabel` from this same contract
  // table, so the phone and the web cannot word red two ways.
  it("the contract's red says requirements are pending, never that the trip is blocked", () => {
    expect(PET_TRAVEL_SEMAFORO_LABELS.rojo).toBe("Hay requisitos pendientes");
    expect(PET_TRAVEL_SEMAFORO_LABELS.verde).toBe("Sin pendientes detectados");
    for (const label of Object.values(PET_TRAVEL_SEMAFORO_LABELS)) {
      expect(label).not.toMatch(/bloque|\bapto\b|\bcumple\b|en orden|listo para viajar/i);
    }
  });

  it("names a trip as the web does", () => {
    expect(tripLabel(TRIP)).toBe("Chile, 12/11/2026");
    expect(tripSummary(TRIP)).toBe("Chile, 12/11/2026 · LATAM, en cabina");
    expect(tripSummary({ ...TRIP, airlineId: null, airlineName: null })).toBe("Chile, 12/11/2026");
  });

  it("finds the selected trip, and answers null when there is none", () => {
    expect(selectedTrip([TRIP], TRIP.tripEventId)).toBe(TRIP);
    expect(selectedTrip([TRIP], null)).toBeNull();
    expect(selectedTrip([], TRIP.tripEventId)).toBeNull();
  });

  it("lists Destino, Aerolínea, Libreta in order, the airline one with the contract's notice", () => {
    const sections = obligationSections(
      compliance([
        obligation({ id: "l", group: "libreta" }),
        obligation({ id: "a", group: "aerolinea" }),
        obligation({ id: "d", group: "destino" }),
      ]),
      TRIP,
    );
    expect(sections.map((s) => s.title)).toEqual(["Destino", "Aerolínea", "Libreta"]);
    expect(sections[1]?.airlineNotice).toBe(`${PET_TRAVEL_AIRLINE_NOTICE}: LATAM`);
    expect(sections[0]?.airlineNotice).toBeNull();
  });

  it("drops the airline group when the trip names no airline, and empty groups except Destino", () => {
    const sections = obligationSections(compliance([obligation({ id: "a", group: "aerolinea" })]), {
      ...TRIP,
      airlineId: null,
      airlineName: null,
    });
    expect(sections.map((s) => s.group)).toEqual(["destino"]);
    expect(sections[0]?.obligations).toEqual([]);
  });

  it("prints sources and CVIs with Argentine dates", () => {
    expect(
      sourceLine({
        kind: "corridor",
        label: "SENASA",
        sourceUrl: "https://www.argentina.gob.ar/senasa",
        lastVerifiedAt: "2026-09-01",
        freshness: "fresh",
      }),
    ).toBe("Fuente: SENASA, revisada el 01/09/2026");
    expect(
      cviLine({ eventId: "e", cviNumber: "AR-1", issuedDate: "2026-10-01", validUntil: null }),
    ).toBe("AR-1: emitido el 01/10/2026");
    expect(
      cviLine({
        eventId: "e",
        cviNumber: "AR-1",
        issuedDate: "2026-10-01",
        validUntil: "2026-10-11",
      }),
    ).toBe("AR-1: emitido el 01/10/2026, válido hasta el 11/10/2026");
  });
});

describe("forms", () => {
  it("asks for the destination before anything else", () => {
    const built = buildTrip(EMPTY_TRIP_DRAFT);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.code).toBe("CORRIDOR_REQUIRED");
      expect(built.message).toBe("Elegí el país de destino.");
    }
  });

  it("asks for the date as DD/MM/AAAA when it is half typed", () => {
    const built = buildTrip({ ...EMPTY_TRIP_DRAFT, corridorId: "chile", travelDate: "12/1" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.code).toBe("TRAVEL_DATE_INVALID");
  });

  it("sends a filled trip in the wire's shape, blank pickers as null", () => {
    const built = buildTrip({
      ...EMPTY_TRIP_DRAFT,
      corridorId: "uruguay",
      travelDate: "12/11/2026",
    });
    expect(built).toEqual({
      ok: true,
      input: {
        command: "record_trip",
        corridorId: "uruguay",
        travelDate: "2026-11-12",
        mode: null,
        airlineId: null,
        intendedModality: null,
      },
    });
  });

  it("carries the airline and where on board when chosen", () => {
    const built = buildTrip({
      corridorId: "chile",
      travelDate: "12/11/2026",
      mode: "air",
      airlineId: "latam",
      intendedModality: "hold",
    });
    expect(built.ok && built.input).toMatchObject({
      airlineId: "latam",
      mode: "air",
      intendedModality: "hold",
    });
  });

  it("records a CVI, with and without its expiry", () => {
    expect(buildCvi(EMPTY_CVI_DRAFT).ok).toBe(false);
    expect(buildCvi({ cviNumber: " AR-9 ", issuedDate: "01/10/2026", validUntil: "" })).toEqual({
      ok: true,
      input: {
        command: "record_cvi",
        cviNumber: "AR-9",
        issuedDate: "2026-10-01",
        validUntil: null,
      },
    });
    const backwards = buildCvi({
      cviNumber: "AR-9",
      issuedDate: "10/10/2026",
      validUntil: "01/10/2026",
    });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.code).toBe("VALID_UNTIL_BEFORE_ISSUED");
  });

  it("cancels by the trip's event id", () => {
    expect(buildCancelTrip(TRIP.tripEventId)).toEqual({
      ok: true,
      input: { command: "cancel_trip", tripEventId: TRIP.tripEventId },
    });
    expect(buildCancelTrip("nope").ok).toBe(false);
  });

  it("ticks a paper by the trip's id and the document's own label", () => {
    expect(buildConfirmDocument(TRIP.tripEventId, "Certificado veterinario", true)).toEqual({
      ok: true,
      input: {
        command: "confirm_trip_document",
        tripEventId: TRIP.tripEventId,
        document: "Certificado veterinario",
        confirmed: true,
      },
    });
    const blank = buildConfirmDocument(TRIP.tripEventId, "  ", false);
    expect(blank).toMatchObject({ ok: false, code: "DOCUMENT_REQUIRED" });
  });
});

describe("papers to carry (PO 2026-10-01)", () => {
  it("says what the owner said about each paper, never that it is valid", () => {
    expect(documentStatusLine({ label: "CVI", confirmed: true })).toBe("Lo tenés, según indicaste");
    expect(documentStatusLine({ label: "CVI", confirmed: false })).toBe("Sin confirmar");
  });

  it("reads no papers from a server that sends none", () => {
    expect(obligationDocuments(obligation({}))).toEqual([]);
    expect(
      obligationDocuments(obligation({ documents: [{ label: "CVI", confirmed: false }] })),
    ).toEqual([{ label: "CVI", confirmed: false }]);
  });
});

describe("acknowledgements", () => {
  it("reads a replay as done, never as a refusal", () => {
    expect(travelAckMessage({ command: "record_trip", eventId: "e", replayed: false })).toBe(
      "Viaje registrado.",
    );
    expect(travelAckMessage({ command: "record_trip", eventId: "e", replayed: true })).toBe(
      "Ese viaje ya estaba registrado.",
    );
    expect(travelAckMessage({ command: "record_cvi", eventId: "e", replayed: true })).toBe(
      "Ese CVI ya estaba registrado.",
    );
    expect(travelAckMessage({ command: "cancel_trip", tripEventId: "t", changed: false })).toBe(
      "Ese viaje ya estaba cancelado.",
    );
    expect(
      travelAckMessage({ command: "confirm_trip_document", tripEventId: "t", changed: false }),
    ).toBe("Ese documento ya estaba así.");
  });
});

describe("calendar bounds mirror the server's windows", () => {
  const now = new Date(2026, 8, 30, 15, 0);

  it("offers a trip from yesterday to a year ahead", () => {
    const { minimumDate, maximumDate } = travelDateBounds(now);
    expect(minimumDate).toEqual(new Date(2026, 8, 29));
    expect(maximumDate).toEqual(new Date(2027, 8, 30));
  });

  it("offers a CVI issued in the last year, never in the future", () => {
    const { minimumDate, maximumDate } = cviIssuedBounds(now);
    expect(minimumDate).toEqual(new Date(2025, 8, 30));
    expect(maximumDate).toEqual(new Date(2026, 8, 30));
  });
});
