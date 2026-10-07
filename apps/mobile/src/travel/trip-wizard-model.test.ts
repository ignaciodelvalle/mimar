// `trip-wizard-model` — the four steps of "Nuevo viaje", as pure rules.
//
// WHAT THESE PROVE
//   1. Each answer trims the next question: the destination's modes
//      (`CORRIDOR_MODES`), skipped when there is one; "Todavía no sé" skips the
//      airline and sends mode null.
//   2. Back keeps every answer.
//   3. The destination search knows other names, and "Perú" finds nothing —
//      which is what makes "Otro país" an honest no-op.
//   4. The destination's airlines come first and never more than four; the
//      search is over ALL of them; an older server (no `corridors`, no
//      `modalities`) gets the full lists back.
//   5. The date window is checked with the contract's own sentence.

import { describe, expect, it } from "@jest/globals";

import { PET_TRAVEL_REFUSAL_MESSAGES } from "@dim/contract/api";

import { buildTrip } from "./travel-view-model";
import {
  type WizardAirline,
  airlineChoices,
  chooseAirline,
  chooseCorridor,
  chooseModality,
  chooseMode,
  clearAirline,
  countdownLabel,
  matchCorridors,
  modalitiesFor,
  modalityCaption,
  previousStep,
  searchAirlines,
  skipAirline,
  startWizard,
  stepPosition,
  stepsFor,
  travelDateLine,
  travelDateRangeMessage,
} from "./trip-wizard-model";

const CORRIDORS = [
  { id: "chile", label: "Chile" },
  { id: "uruguay", label: "Uruguay" },
  { id: "brasil", label: "Brasil" },
  { id: "ue_espana", label: "España (Unión Europea)" },
  { id: "usa", label: "Estados Unidos" },
];

describe("steps", () => {
  it("starts on the destination, counting four steps", () => {
    const state = startWizard();
    expect(state.step).toBe("destino");
    expect(stepPosition(state)).toEqual({ index: 0, total: 4 });
  });

  it("asks how they travel only among the destination's modes", () => {
    const chile = chooseCorridor(startWizard(), "chile");
    expect(chile.step).toBe("modo");
    expect(stepPosition(chile)).toEqual({ index: 1, total: 4 });
  });

  it("skips the mode step when the destination allows one way (by air)", () => {
    const spain = chooseCorridor(startWizard(), "ue_espana");
    expect(spain.step).toBe("aerolinea");
    expect(spain.draft.mode).toBe("air");
    expect(stepsFor(spain)).toEqual(["destino", "aerolinea", "fecha"]);
    expect(stepPosition(spain)).toEqual({ index: 1, total: 3 });
  });

  it("'Todavía no sé' sends mode null and jumps to the date", () => {
    const unsure = chooseMode(chooseCorridor(startWizard(), "chile"), null);
    expect(unsure.step).toBe("fecha");
    expect(stepsFor(unsure)).toEqual(["destino", "modo", "fecha"]);
    const built = buildTrip({ ...unsure.draft, travelDate: "15/11/2026" });
    expect(built.ok && built.input).toEqual({
      command: "record_trip",
      corridorId: "chile",
      travelDate: "2026-11-15",
      mode: null,
      airlineId: null,
      intendedModality: null,
    });
  });

  it("by road goes straight to the date, with no airline", () => {
    const road = chooseMode(chooseCorridor(startWizard(), "chile"), "land");
    expect(road.step).toBe("fecha");
    expect(road.draft.mode).toBe("land");
  });

  it("by air asks the airline, then where the animal travels, then the date", () => {
    let state = chooseMode(chooseCorridor(startWizard(), "chile"), "air");
    expect(state.step).toBe("aerolinea");
    state = chooseAirline(state, "latam");
    // Picking the airline does not advance: the same screen asks the modality.
    expect(state.step).toBe("aerolinea");
    state = chooseModality(state, "cabin");
    expect(state.step).toBe("fecha");
    expect(state.draft).toMatchObject({ airlineId: "latam", intendedModality: "cabin" });
  });

  it("'Todavía no sé' for the airline leaves it blank and moves on", () => {
    const state = skipAirline(chooseMode(chooseCorridor(startWizard(), "chile"), "air"));
    expect(state.step).toBe("fecha");
    expect(state.draft).toMatchObject({ mode: "air", airlineId: "", intendedModality: "" });
  });

  it("goes back one step at a time KEEPING every answer, and has nowhere back from the first", () => {
    const atDate = chooseModality(
      chooseAirline(chooseMode(chooseCorridor(startWizard(), "chile"), "air"), "latam"),
      "hold",
    );
    const atAirline = previousStep(atDate);
    expect(atAirline?.step).toBe("aerolinea");
    expect(atAirline?.draft).toEqual(atDate.draft);
    const atMode = atAirline === null ? null : previousStep(atAirline);
    expect(atMode?.step).toBe("modo");
    expect(atMode?.draft.mode).toBe("air");
    const atStart = atMode === null ? null : previousStep(atMode);
    expect(atStart?.step).toBe("destino");
    expect(atStart?.draft.corridorId).toBe("chile");
    expect(atStart === null ? "x" : previousStep(atStart)).toBeNull();
  });

  it("choosing the SAME destination again keeps the later answers; a different one drops them", () => {
    const answered = chooseAirline(
      chooseMode(chooseCorridor(startWizard(), "chile"), "air"),
      "latam",
    );
    const back = previousStep(previousStep(answered) ?? answered) ?? answered;
    expect(back.step).toBe("destino");
    expect(chooseCorridor(back, "chile").draft.airlineId).toBe("latam");
    const other = chooseCorridor(back, "brasil");
    expect(other.draft).toMatchObject({ corridorId: "brasil", mode: "", airlineId: "" });
  });

  it("opens on the second step from a destination shortcut", () => {
    expect(startWizard("uruguay").step).toBe("modo");
    expect(startWizard("usa").step).toBe("aerolinea");
  });

  it("'Cambiar' brings the airline list back", () => {
    const changed = clearAirline(chooseAirline(startWizard("usa"), "american"));
    expect(changed.draft.airlineId).toBe("");
    expect(changed.step).toBe("aerolinea");
  });
});

describe("destination search", () => {
  it("matches names, other names and accents", () => {
    expect(matchCorridors(CORRIDORS, "").map((c) => c.id)).toHaveLength(5);
    expect(matchCorridors(CORRIDORS, "europa").map((c) => c.id)).toEqual(["ue_espana"]);
    expect(matchCorridors(CORRIDORS, "UE").map((c) => c.id)).toEqual(["ue_espana"]);
    expect(matchCorridors(CORRIDORS, "espana").map((c) => c.id)).toEqual(["ue_espana"]);
    expect(matchCorridors(CORRIDORS, "EEUU").map((c) => c.id)).toEqual(["usa"]);
    expect(matchCorridors(CORRIDORS, "estados").map((c) => c.id)).toEqual(["usa"]);
    expect(matchCorridors(CORRIDORS, "bra").map((c) => c.id)).toEqual(["brasil"]);
  });

  it("finds nothing for a destination miMAR does not check", () => {
    expect(matchCorridors(CORRIDORS, "Perú")).toEqual([]);
  });
});

describe("airlines", () => {
  const AIRLINES: WizardAirline[] = [
    { id: "aerolineas_argentinas", name: "Aerolíneas Argentinas", corridors: ["chile", "brasil"] },
    { id: "flybondi", name: "Flybondi", corridors: [] },
    { id: "jetsmart", name: "JetSMART", corridors: ["chile"] },
    { id: "latam", name: "LATAM", corridors: ["chile", "brasil"] },
    { id: "sky", name: "Sky Airline", corridors: ["chile"] },
    { id: "gol", name: "GOL", corridors: ["chile", "brasil"] },
    { id: "iberia", name: "Iberia", corridors: [] },
  ];

  it("puts the destination's airlines first, never more than four", () => {
    const choices = airlineChoices(AIRLINES, "chile");
    expect(choices.kind).toBe("suggested");
    expect(choices.airlines.map((a) => a.id)).toEqual([
      "aerolineas_argentinas",
      "jetsmart",
      "latam",
      "sky",
    ]);
  });

  it("falls back to every airline on an older server, or when none names the destination", () => {
    const old = AIRLINES.map(({ id, name }) => ({ id, name }));
    expect(airlineChoices(old, "chile")).toEqual({ kind: "all", airlines: old });
    expect(airlineChoices(AIRLINES, "usa").kind).toBe("all");
  });

  it("searches ALL airlines, six at most", () => {
    expect(searchAirlines(AIRLINES, "ibe").results.map((a) => a.id)).toEqual(["iberia"]);
    expect(searchAirlines(AIRLINES, "argentinas").results.map((a) => a.id)).toEqual([
      "aerolineas_argentinas",
    ]);
    const all = searchAirlines(AIRLINES, "");
    expect(all.results).toHaveLength(6);
    expect(all.more).toBe(true);
  });

  it("offers only the modalities the airline publishes, all three when it says nothing", () => {
    const emirates: WizardAirline = {
      id: "emirates",
      name: "Emirates",
      modalities: [
        { modality: "cargo", offered: "yes", maxWeightKg: null, includesCarrier: false },
      ],
    };
    expect(modalitiesFor(emirates)).toEqual(["cargo"]);
    expect(modalitiesFor({ id: "x", name: "X" })).toEqual(["cabin", "hold", "cargo"]);
    expect(modalitiesFor(undefined)).toEqual(["cabin", "hold", "cargo"]);
  });

  it("attributes the published weight to the airline", () => {
    const latam: WizardAirline = {
      id: "latam",
      name: "LATAM",
      modalities: [
        { modality: "cabin", offered: "yes", maxWeightKg: 7, includesCarrier: true },
        { modality: "hold", offered: "restricted", maxWeightKg: null, includesCarrier: false },
      ],
    };
    expect(modalityCaption(latam, "cabin")).toBe("LATAM publica hasta 7 kg con el bolso");
    expect(modalityCaption(latam, "hold")).toBe("Con condiciones: confirmalo con LATAM");
    expect(modalityCaption(latam, "cargo")).toBeNull();
  });
});

describe("dates", () => {
  const NOW = new Date(2026, 9, 7, 13, 5);

  it("counts down in days, as arithmetic", () => {
    expect(countdownLabel("2026-11-15", NOW)).toBe("faltan 39 días");
    expect(countdownLabel("2026-10-08", NOW)).toBe("sale mañana");
    expect(countdownLabel("2026-10-07", NOW)).toBe("sale hoy");
    expect(countdownLabel("2026-10-01", NOW)).toBe("viajó el 01/10");
    expect(countdownLabel("15/11/2026", NOW)).toBeNull();
  });

  it("spells the day under the field", () => {
    expect(travelDateLine("2026-11-15", NOW)).toBe("Domingo 15 de noviembre · faltan 39 días");
  });

  it("refuses a date outside the server's window with the server's sentence", () => {
    const bounds = { minimumDate: new Date(2026, 9, 6), maximumDate: new Date(2027, 9, 7) };
    expect(travelDateRangeMessage("2026-10-05", bounds)).toBe(
      PET_TRAVEL_REFUSAL_MESSAGES.TRAVEL_DATE_OUT_OF_RANGE,
    );
    expect(travelDateRangeMessage("2027-10-08", bounds)).toBe(
      PET_TRAVEL_REFUSAL_MESSAGES.TRAVEL_DATE_OUT_OF_RANGE,
    );
    expect(travelDateRangeMessage("2026-10-06", bounds)).toBeNull();
    expect(travelDateRangeMessage("2026-11-15", bounds)).toBeNull();
    expect(travelDateRangeMessage(null, bounds)).toBeNull();
  });
});
