import type { LibretaVaccinationSection, PetLibretaV1 } from "@dim/contract/api";
import { describe, expect, it } from "@jest/globals";

import {
  amendedLabel,
  buildLibretaView,
  calendarDaysBetweenInAr,
  ledgerCountLabel,
  otherVaccinesNote,
  speciesLine,
  upcomingDueLabel,
  upcomingKindLabel,
  vaccinationHeadline,
  vaccineStatusLabel,
} from "./libreta-view-model";
import { SECTION_UNAVAILABLE_MESSAGE } from "./owner-face-view-model";
import { UNKNOWN_SPECIES_LABEL } from "./species";

function summary(overrides: Partial<LibretaVaccinationSection> = {}): LibretaVaccinationSection {
  return {
    active: 0,
    dueSoon: 0,
    expired: 0,
    missing: 0,
    unconfirmed: 0,
    otherCount: 0,
    perVaccine: [],
    ...overrides,
  };
}

describe("vaccinationHeadline — the verdict never borrows a word it did not earn", () => {
  it("says SIN DATOS for an animal with nothing on file, NOT al día", () => {
    // An animal with no dose recorded has not been reported compliant. It has
    // been reported unknown, and the two must not print the same word.
    expect(vaccinationHeadline(summary())).toBe("SIN DATOS");
  });

  it("says AL DÍA only when something is on file and nothing is wrong", () => {
    expect(vaccinationHeadline(summary({ active: 3 }))).toBe("AL DÍA");
  });

  it("ranks the worst state first", () => {
    expect(vaccinationHeadline(summary({ active: 2, dueSoon: 1 }))).toBe("POR VENCER");
    expect(vaccinationHeadline(summary({ active: 2, dueSoon: 1, missing: 1 }))).toBe("SIN APLICAR");
    expect(vaccinationHeadline(summary({ active: 2, missing: 1, expired: 1 }))).toBe("VENCIDA");
  });

  it("never reports an UNCONFIRMED vaccine as missing", () => {
    // A core vaccine we cannot MATCH, on an animal carrying a dose we cannot
    // IDENTIFY, is not an animal whose owner can be told it is unvaccinated.
    expect(vaccinationHeadline(summary({ unconfirmed: 1 }))).toBe("SIN CONFIRMAR");
    expect(vaccinationHeadline(summary({ unconfirmed: 1 }))).not.toBe("SIN APLICAR");
  });

  it("counts an off-catalog dose as data, so the verdict is not SIN DATOS", () => {
    // The dose does not move the core-vaccine verdict, but it is still a dose
    // somebody gave the animal.
    expect(vaccinationHeadline(summary({ otherCount: 1 }))).toBe("AL DÍA");
  });
});

describe("otherVaccinesNote — a dose the catalog could not name must not vanish", () => {
  it("is absent when there are none", () => {
    expect(otherVaccinesNote(summary())).toBeNull();
  });

  it("agrees in number", () => {
    expect(otherVaccinesNote(summary({ otherCount: 1 }))).toContain("1 vacuna registrada");
    expect(otherVaccinesNote(summary({ otherCount: 3 }))).toContain("3 vacunas registradas");
  });
});

describe("vaccineStatusLabel — every state has a word", () => {
  it("words each of the five", () => {
    expect(vaccineStatusLabel("active")).toBe("Al día");
    expect(vaccineStatusLabel("due_soon")).toBe("Por vencer");
    expect(vaccineStatusLabel("expired")).toBe("Vencida");
    expect(vaccineStatusLabel("missing")).toBe("Nunca aplicada");
    // "Sin confirmar" and "Nunca aplicada" are different claims — see the
    // headline test above.
    expect(vaccineStatusLabel("unconfirmed")).toBe("Sin confirmar");
  });
});

describe("upcomingDueLabel — the ARGENTINE calendar, not the device's", () => {
  it("calls a due date on the same AR day HOY even when UTC has rolled over", () => {
    // 23:00 UTC on the 25th is 20:00 on the 25th in Buenos Aires; 01:00 UTC on
    // the 26th is 22:00 on the SAME AR day. A device reading UTC would say
    // "Mañana" and move an animal's turno by a day for an owner abroad.
    const now = new Date("2026-08-25T23:00:00Z");
    expect(upcomingDueLabel("2026-08-26T01:00:00Z", now)).toBe("Hoy");
  });

  it("counts calendar days, not elapsed hours", () => {
    // 14 hours away, and one calendar day.
    const now = new Date("2026-08-25T13:00:00Z");
    expect(upcomingDueLabel("2026-08-26T03:00:00Z", now)).toBe("Mañana");
  });

  it("says an overdue item is overdue, never 'en -1 días'", () => {
    const now = new Date("2026-08-25T15:00:00Z");
    expect(upcomingDueLabel("2026-08-24T15:00:00Z", now)).toBe("Venció ayer");
    expect(upcomingDueLabel("2026-08-20T15:00:00Z", now)).toBe("Venció hace 5 días");
  });

  it("collapses a far date into months", () => {
    const now = new Date("2026-08-25T15:00:00Z");
    expect(upcomingDueLabel("2027-08-25T15:00:00Z", now)).toContain("meses");
  });

  it("says so plainly when the date is unreadable", () => {
    expect(upcomingDueLabel("no-es-una-fecha", new Date("2026-08-25T15:00:00Z"))).toBe("Sin fecha");
    expect(calendarDaysBetweenInAr(new Date("2026-08-25T15:00:00Z"), "nope")).toBeNull();
  });
});

describe("the masthead and the ledger's own copy", () => {
  it("drops a sex the record does not carry instead of printing a dangling separator", () => {
    expect(speciesLine({ species: "dog", sex: "female" })).toBe("Perro · hembra");
    expect(speciesLine({ species: "dog", sex: null })).toBe("Perro");
  });

  it("names an unknown species in es-AR instead of printing the wire value", () => {
    // THIS ASSERTION USED TO EXPECT `"axolotl"`, and the change is deliberate.
    //
    // It was pinning the argument `species.ts` records as the one that was
    // wrong: that showing "Otro" for an animal the server called `chinchilla`
    // hides a gap in this app behind a word that looks deliberate. The
    // objection stands — the remedy did not. `axolotl`, `chinchilla`,
    // `bearded_dragon` are internal English identifiers in a wallet whose whole
    // UI is es-AR, and the libreta is a health document a vet reads.
    //
    // `UNKNOWN_SPECIES_LABEL` answers both halves: it is real es-AR, and it is
    // NOT the label of the real `other` member ("Otro"), so a species this
    // build has never met still does not vanish into a deliberate-looking
    // category. Lote 1c moved `species.ts` to that rule and fixed its own
    // tests; this module kept a hand-typed copy of the table, and this
    // assertion is what held the old behaviour in place.
    expect(speciesLine({ species: "axolotl", sex: null })).toBe(UNKNOWN_SPECIES_LABEL);
    // And the real member keeps its own, different word — the collision the
    // duplicated table had created.
    expect(speciesLine({ species: "other", sex: null })).toBe("Otro");
    expect(UNKNOWN_SPECIES_LABEL).not.toBe("Otro");
  });

  it("agrees in number on the asiento count", () => {
    expect(ledgerCountLabel(1)).toBe("1 registro");
    expect(ledgerCountLabel(4)).toBe("4 registros");
  });

  it("dates the correction marker in the Argentine calendar", () => {
    // 01:00 UTC on the 23rd is still the 22nd in Buenos Aires.
    expect(amendedLabel("2026-08-23T01:00:00Z")).toBe("Corregido el 22/08/2026");
  });

  it("words each kind of upcoming row", () => {
    expect(upcomingKindLabel("reminder")).toBe("Recordatorio");
    expect(upcomingKindLabel("appointment")).toBe("Turno");
    expect(upcomingKindLabel("medication")).toBe("Dosis");
  });
});

describe("buildLibretaView — a failed section is not an empty one", () => {
  it("carries the refusal copy for every unavailable section", () => {
    const payload = {
      payloadVersion: 1,
      issuedAt: "2026-08-25T15:00:00.000Z",
      staleAfter: "2026-08-25T15:05:00.000Z",
      publicToken: "DIM-PAMP-0001",
      viewer: { role: "owner", isTitular: true, canAmend: true },
      identity: { status: "unavailable" },
      vaccination: { status: "unavailable" },
      upcoming: { status: "unavailable" },
      timeline: { status: "unavailable" },
    } as unknown as PetLibretaV1;

    const view = buildLibretaView(payload);
    for (const section of [view.identity, view.vaccination, view.upcoming, view.timeline]) {
      expect(section.state).toBe("unavailable");
      // The copy travels with the state, so a screen cannot render the failure
      // as an empty view without noticing it threw a string away.
      if (section.state === "unavailable") {
        expect(section.message).toBe(SECTION_UNAVAILABLE_MESSAGE);
      }
    }
    // The viewer's capability is NOT a section and survives a failed read.
    expect(view.canAmend).toBe(true);
  });
});
