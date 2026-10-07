// `travel-view-model` — arrangement and forms, never a verdict.
//
// WHAT THESE PROVE
//   1. The semáforo's colour maps to a tone and nothing more; `sin_datos` is
//      neutral, never green or amber.
//   2. The reading is split by what is left to do (pending, done, papers),
//      the opening rule opens only the first module with work, a requirement
//      met only on the owner's word wears the contract's seal, and each one
//      offers the action its rule type maps to.
//   3. The forms go through the contract's own schema: a blank picker is a
//      field sentence, a typed DD/MM/AAAA date reaches the wire as YYYY-MM-DD.
//   4. A replay reads as done, never as a refusal.
//   5. The calendar bounds mirror the server's windows.

import { describe, expect, it } from "@jest/globals";

import {
  PET_TRAVEL_DECLARED_SEAL,
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
  declaredSeal,
  documentStatusLine,
  initialOpenModule,
  obligationActionLabel,
  obligationDocuments,
  paperKey,
  paperShortName,
  papersCountLabel,
  pendingCountLine,
  selectedTrip,
  semaforoTone,
  sourceLine,
  splitObligations,
  travelAckMessage,
  travelDateBounds,
  tripLabel,
  tripMetaLine,
  tripPaper,
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

  it("splits by what is left to do: pending, done, and the papers apart", () => {
    const papers = obligation({
      id: "required_documents",
      requirementLevel: "warning",
      documents: [
        { label: "CZI", confirmed: true },
        { label: "Certificado antirrábico", confirmed: false },
      ],
    });
    const split = splitObligations(
      compliance([
        obligation({ id: "rabies", requirementLevel: "blocker" }),
        obligation({ id: "chip", requirementLevel: "warning" }),
        papers,
        obligation({ id: "age", requirementLevel: "info" }),
      ]),
    );
    expect(split.pending.map((o) => o.id)).toEqual(["rabies", "chip"]);
    expect(split.done.map((o) => o.id)).toEqual(["age"]);
    expect(split.papers.map((p) => p.document.label)).toEqual(["CZI", "Certificado antirrábico"]);
    expect(papersCountLabel(split.papers)).toBe("1 de 2");
    expect(pendingCountLine(split)).toBe("2 cosas por resolver · 1 ya está");
    // The obligation stays with its papers: its notice and sources are still drawn.
    expect(split.paperGroups.map((g) => g.obligation.id)).toEqual(["required_documents"]);
    expect(split.paperGroups[0]?.papers.map(paperKey)).toEqual([
      "required_documents:CZI",
      "required_documents:Certificado antirrábico",
    ]);
    expect(splitObligations(null)).toEqual({ pending: [], done: [], papers: [], paperGroups: [] });
  });

  it("counts in words that never judge", () => {
    const one = splitObligations(
      compliance([obligation({ id: "a", requirementLevel: "warning" })]),
    );
    expect(pendingCountLine(one)).toBe("1 cosa por resolver");
    const none = splitObligations(
      compliance([
        obligation({ id: "a", requirementLevel: "info" }),
        obligation({ id: "b", requirementLevel: "info" }),
      ]),
    );
    expect(pendingCountLine(none)).toBe("2 requisitos revisados");
    expect(pendingCountLine(splitObligations(compliance([])))).toBeNull();
  });

  describe("the opening rule: only the first module with work opens", () => {
    it("opens Lo que falta while something is pending", () => {
      const split = splitObligations(compliance([obligation({ requirementLevel: "blocker" })]));
      expect(initialOpenModule(split)).toBe("falta");
    });

    it("opens Para llevar when nothing is pending but a paper is unticked", () => {
      const split = splitObligations(
        compliance([
          obligation({ id: "x", requirementLevel: "info" }),
          obligation({
            id: "required_documents",
            requirementLevel: "warning",
            documents: [{ label: "CZI", confirmed: false }],
          }),
        ]),
      );
      expect(initialOpenModule(split)).toBe("llevar");
    });

    it("opens nothing when everything is done", () => {
      const split = splitObligations(
        compliance([
          obligation({ id: "x", requirementLevel: "info" }),
          obligation({
            id: "required_documents",
            requirementLevel: "info",
            documents: [{ label: "CZI", confirmed: true }],
          }),
        ]),
      );
      expect(initialOpenModule(split)).toBeNull();
    });
  });

  it("seals a requirement met only on the owner's word, and only that one", () => {
    expect(declaredSeal(obligation({ evidence: "declared", requirementLevel: "warning" }))).toBe(
      PET_TRAVEL_DECLARED_SEAL,
    );
    expect(declaredSeal(obligation({ evidence: "verified", requirementLevel: "info" }))).toBeNull();
    // An older server sends no evidence at all: no seal, nothing invented.
    expect(declaredSeal(obligation({}))).toBeNull();
  });

  it("offers each requirement the action its rule type maps to, naming the destination's paper", () => {
    const czi = { name: "Certificado Zoosanitario de Importación (CZI)", shortName: "CZI" };
    expect(
      obligationActionLabel(
        obligation({ id: "document_issuance_window_days:senasa_cvi", requirementLevel: "warning" }),
        czi,
      ),
    ).toEqual({ kind: "record_paper", label: "Cargar el CZI" });
    expect(
      obligationActionLabel(
        obligation({ id: "microchip_required", requirementLevel: "warning" }),
        null,
      ),
    ).toEqual({ kind: "ask_vet", label: "Pedírselo a mi veterinaria" });
    expect(
      obligationActionLabel(
        obligation({
          id: "rabies_vaccination_to_travel_wait_days",
          requirementLevel: "warning",
          evidence: "declared",
        }),
        null,
      ),
    ).toEqual({ kind: "send_to_vet", label: "Mandar a mi veterinaria" });
    // Without a paper on the payload (an older server) the button keeps the old name.
    expect(
      obligationActionLabel(
        obligation({ id: "document_issuance_window_days", requirementLevel: "blocker" }),
        null,
      )?.label,
    ).toBe("Cargar el CVI");
    // Met, or a rule nothing on the phone resolves: no button.
    expect(
      obligationActionLabel(
        obligation({ id: "microchip_required", requirementLevel: "info" }),
        null,
      ),
    ).toBeNull();
    expect(
      obligationActionLabel(obligation({ id: "embargo", requirementLevel: "blocker" }), null),
    ).toBeNull();
  });

  it("says how the trip goes in the header even without an airline", () => {
    expect(tripMetaLine(TRIP, "Jue")).toBe("Jue 12/11/2026 · LATAM, en cabina");
    // The form's own word for cargo: "como carga", never "en carga".
    expect(tripMetaLine({ ...TRIP, intendedModality: "cargo" }, "Jue")).toBe(
      "Jue 12/11/2026 · LATAM, como carga",
    );
    expect(tripMetaLine({ ...TRIP, airlineId: null, airlineName: null, mode: "land" }, "Jue")).toBe(
      "Jue 12/11/2026 · En auto o en micro",
    );
    expect(
      tripMetaLine(
        { ...TRIP, airlineId: null, airlineName: null, mode: null, intendedModality: null },
        null,
      ),
    ).toBe("12/11/2026");
  });

  it("names the destination's paper, or the CVI when an older server names none", () => {
    const corridors = [
      { id: "chile", label: "Chile", paper: { name: "CZI largo", shortName: "CZI" } },
    ];
    expect(tripPaper(corridors, "chile")?.shortName).toBe("CZI");
    expect(tripPaper([{ id: "chile", label: "Chile" }], "chile")).toBeNull();
    expect(paperShortName(null)).toBe("CVI");
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
    // Who PUBLISHES the rule, when the server names it (QA copy 5).
    expect(
      sourceLine({
        kind: "corridor",
        label: "Chile",
        issuerLabel: "SENASA, requisitos para Chile",
        sourceUrl: "https://www.argentina.gob.ar/senasa",
        lastVerifiedAt: "2026-09-30",
        freshness: "fresh",
      }),
    ).toBe("Fuente: SENASA, requisitos para Chile, revisada el 30/09/2026");
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
