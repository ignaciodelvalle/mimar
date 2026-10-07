// The pure rules of the v14 /viaje screen ("Viaje en pasos"): which module a
// requirement lands in, which module opens by itself, the pase's words, and the
// trip form's chained filters. No React rendering here — every rule is data.

import { describe, expect, it } from "vitest";

import type { TravelObligation, TravelTrip } from "@/lib/projections/travel-compliance";
import { getAirline } from "@/lib/reference/airlines";
import { AIRLINE_IDS } from "@/lib/reference/airlines";
import { toAirlineOption } from "@/src/modules/pets/application/travel/travel-options";

import {
  OTHER_COUNTRY,
  airlinesFor,
  isShortcutCorridor,
  modalityOptionLabel,
  modesFor,
} from "./trip-form-options";
import {
  countdownLabel,
  isPastTrip,
  moduleToOpen,
  papersTally,
  partitionObligations,
  semaforoTally,
  travelDayLabel,
  tripMetaLine,
} from "./trip-screen";

function obligation(
  id: string,
  requirementLevel: TravelObligation["requirementLevel"],
  extra: Partial<TravelObligation> = {},
): TravelObligation {
  return {
    id,
    key: id as TravelObligation["key"],
    group: "libreta",
    label: id,
    state: "x",
    tone: "due",
    detail: null,
    legalFootnote: "",
    requirementLevel,
    contributingJurisdictions: [],
    sources: [],
    freshnessNotice: null,
    ...extra,
  };
}

const PAPERS = (confirmed: boolean[]) =>
  obligation("required_documents", confirmed.every(Boolean) ? "info" : "warning", {
    documents: confirmed.map((c, i) => ({ label: `Papel ${i}`, confirmed: c })),
  });

describe("modules — Lo que falta / Para llevar / Ya está", () => {
  it("splits by the server's level, and keeps the papers out of Ya está", () => {
    const m = partitionObligations([
      obligation("microchip_required", "warning"),
      obligation("rabies_vaccination_to_travel_wait_days", "blocker"),
      obligation("required_vaccines", "info"),
      PAPERS([true, true]),
    ]);
    expect(m.falta.map((o) => o.id)).toEqual([
      "microchip_required",
      "rabies_vaccination_to_travel_wait_days",
    ]);
    expect(m.yaEsta.map((o) => o.id)).toEqual(["required_vaccines"]);
    expect(m.papers?.id).toBe("required_documents");
  });

  it("unticked papers are something still to do", () => {
    const m = partitionObligations([PAPERS([true, false])]);
    expect(m.falta.map((o) => o.id)).toEqual(["required_documents"]);
    expect(papersTally(m.papers)).toEqual({ done: 1, total: 2 });
  });

  it("opens Lo que falta when anything is pending, else nothing", () => {
    expect(moduleToOpen(partitionObligations([obligation("a", "warning")]))).toBe("falta");
    expect(moduleToOpen(partitionObligations([obligation("a", "info"), PAPERS([true])]))).toBe(
      null,
    );
  });

  it("the tally counts what is pending and what is met", () => {
    expect(
      semaforoTally(
        partitionObligations([
          obligation("a", "warning"),
          obligation("b", "blocker"),
          obligation("c", "warning"),
          obligation("d", "info"),
          obligation("e", "info"),
        ]),
      ),
    ).toBe("3 cosas por resolver · 2 ya están");
    expect(semaforoTally(partitionObligations([obligation("a", "warning")]))).toBe(
      "1 cosa por resolver",
    );
    expect(semaforoTally(partitionObligations([obligation("a", "info")]))).toBe(
      "1 requisito revisado",
    );
  });
});

describe("the pase", () => {
  const today = "2026-10-07";

  it("counts down in days, never a verdict", () => {
    expect(countdownLabel("2026-11-15", today)).toBe("faltan 39 días");
    expect(countdownLabel("2026-10-08", today)).toBe("sale mañana");
    expect(countdownLabel("2026-10-07", today)).toBe("sale hoy");
    expect(countdownLabel("2026-10-01", today)).toBe("viajó el 01/10");
    expect(isPastTrip("2026-10-06", today)).toBe(true);
    expect(isPastTrip("2026-10-07", today)).toBe(false);
  });

  it("names the day of the week", () => {
    expect(travelDayLabel("2026-11-15")).toBe("Domingo 15/11/2026");
  });

  const trip: TravelTrip = {
    eventId: "t",
    corridorId: "chile",
    travelDate: "2026-11-15",
    mode: "air",
    airlineId: "latam",
    intendedModality: "cabin",
    documentsConfirmed: [],
  };

  it("says the airline and where the animal flies", () => {
    expect(tripMetaLine(trip, "LATAM")).toBe("Domingo 15/11/2026 · LATAM, en cabina");
  });

  it("says the mode when there is no airline (QA copy 9)", () => {
    expect(tripMetaLine({ ...trip, mode: "land", airlineId: null }, null)).toBe(
      "Domingo 15/11/2026 · En auto o en micro",
    );
    expect(tripMetaLine({ ...trip, mode: null, airlineId: null }, null)).toBe("Domingo 15/11/2026");
  });
});

describe("the trip form's chained filters", () => {
  const airlines = AIRLINE_IDS.map((id) => toAirlineOption(getAirline(id)));

  it("offers only the modes of the destination, all of them before one is chosen", () => {
    expect(modesFor("usa")).toEqual(["air"]);
    expect(modesFor("uruguay")).toEqual(["air", "sea", "land"]);
    expect(modesFor("")).toEqual(["air", "land", "sea"]);
    expect(modesFor(OTHER_COUNTRY)).toEqual(["air", "land", "sea"]);
  });

  it("lists the destination's airlines first and never hides the others", () => {
    const { suggested, others } = airlinesFor(airlines, "chile", "");
    expect(suggested.map((a) => a.id).sort()).toEqual(
      ["aerolineas_argentinas", "jetsmart", "latam", "sky"].sort(),
    );
    expect(suggested.length + others.length).toBe(20);
  });

  it("'Buscar otra aerolínea' searches the rest by name", () => {
    const { others } = airlinesFor(airlines, "chile", "ibe");
    expect(others.map((a) => a.id)).toEqual(["iberia"]);
    // Without a destination, every airline is searchable.
    expect(airlinesFor(airlines, "", "").others).toHaveLength(20);
  });

  it("offers the modalities the airline publishes, with its weight", () => {
    const latam = airlines.find((a) => a.id === "latam");
    expect(latam?.modalities?.map(modalityOptionLabel)).toEqual([
      "En cabina · hasta 7 kg con el bolso o canil",
      "En bodega · hasta 32 kg con el bolso o canil",
    ]);
  });

  it("a destination shortcut accepts the five destinations and nothing else", () => {
    expect(isShortcutCorridor("chile")).toBe(true);
    expect(isShortcutCorridor("toString")).toBe(false);
    expect(isShortcutCorridor(OTHER_COUNTRY)).toBe(false);
  });
});
