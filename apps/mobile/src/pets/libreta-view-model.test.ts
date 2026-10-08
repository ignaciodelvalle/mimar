import type {
  LibretaEntryV1,
  LibretaUpcomingItemV1,
  LibretaVaccinationSection,
  PetLibretaV1,
} from "@dim/contract/api";
import { describe, expect, it } from "@jest/globals";

import {
  amendedLabel,
  buildLibretaView,
  calendarDaysBetweenInAr,
  groupLedgerEntries,
  ledgerCountLabel,
  offersVerificationRequest,
  otherVaccinesNote,
  speciesLine,
  tripPapersGroupLabel,
  tripPapersTickKey,
  tripPapersTickLabel,
  upcomingDueLabel,
  upcomingKindLabel,
  upcomingRemainingLabel,
  upcomingRowLabel,
  vaccinationHeadline,
  vaccineCounts,
  vaccineRowLabel,
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

describe("an owner-declared current dose — the back says what the front says (QA v14 P2a)", () => {
  const declaredRabies = {
    vaccineName: "Antirrábica",
    status: "active" as const,
    lastDoseAt: "2026-09-01T15:00:00.000Z",
    nextDueAt: "2027-09-01T12:00:00.000Z",
    provenance: "declarada" as const,
  };

  it("counts it with Sin confirmar, never with Vigente", () => {
    const s = summary({ active: 1, declared: 1, perVaccine: [declaredRabies] });
    expect(vaccineCounts(s)).toEqual({ vigente: 0, porVencer: 0, vencida: 0, sinConfirmar: 1 });
    expect(vaccinationHeadline(s)).toBe("SIN CONFIRMAR");
  });

  it("labels the row Declarada, like the credential front", () => {
    expect(vaccineRowLabel(declaredRabies)).toBe("Declarada");
    expect(vaccineRowLabel({ ...declaredRabies, provenance: "profesional" })).toBe("Vigente");
  });

  it("an older server without the fields keeps the old reading", () => {
    const s = summary({ active: 1, perVaccine: [{ ...declaredRabies, provenance: undefined }] });
    expect(vaccineCounts(s).vigente).toBe(1);
    expect(vaccinationHeadline(s)).toBe("AL DÍA");
  });

  it("a declared dose that is due soon keeps its urgency", () => {
    const s = summary({ dueSoon: 1, perVaccine: [{ ...declaredRabies, status: "due_soon" }] });
    expect(vaccineRowLabel({ ...declaredRabies, status: "due_soon" })).toBe("Por vencer");
    expect(vaccinationHeadline(s)).toBe("POR VENCER");
  });
});

describe("vaccineStatusLabel — every state has a word", () => {
  it("words each of the five", () => {
    expect(vaccineStatusLabel("active")).toBe("Vigente");
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

describe("an upcoming row's text — the kind is said once", () => {
  function item(overrides: Partial<LibretaUpcomingItemV1>): LibretaUpcomingItemV1 {
    return {
      id: "x",
      kind: "reminder",
      label: "Antirrábica",
      dueAt: "2026-12-01T03:00:00.000Z",
      reminderId: null,
      ...overrides,
    };
  }

  it("names a medication course by its drug, as the next dose", () => {
    const med = item({ kind: "medication", label: "Antiparasitario de amplio espectro" });
    expect(upcomingRowLabel(med)).toBe("Antiparasitario de amplio espectro · próxima dosis");
  });

  it("drops the stored '– Dosis' suffix an older server still sends", () => {
    // The J7 screenshot: "Dosis · Antiparasitario de amplio espectro – Dosis".
    const med = item({ kind: "medication", label: "Antiparasitario de amplio espectro – Dosis" });
    expect(upcomingRowLabel(med)).toBe("Antiparasitario de amplio espectro · próxima dosis");
  });

  it("keeps reminders and turnos as they were", () => {
    expect(upcomingRowLabel(item({}))).toBe("Recordatorio · Antirrábica");
    expect(upcomingRowLabel(item({ kind: "appointment", label: "Control" }))).toBe(
      "Turno · Control",
    );
  });

  it("counts what is left of a course only when there is more than the next dose", () => {
    expect(upcomingRemainingLabel(item({ kind: "medication", remainingDoses: 5 }))).toBe(
      "quedan 5 dosis",
    );
    expect(upcomingRemainingLabel(item({ kind: "medication", remainingDoses: 1 }))).toBeNull();
    // A server from before the collapse sends no count; say nothing rather than guess.
    expect(upcomingRemainingLabel(item({ kind: "medication" }))).toBeNull();
    expect(upcomingRemainingLabel(item({ remainingDoses: null }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function anEntry(over: Partial<LibretaEntryV1> = {}): LibretaEntryV1 {
  return {
    eventId: "evt-1",
    visitId: null,
    eventType: "vaccination_administered",
    kind: "Vacuna · obligatoria",
    title: "Antirrábica",
    occurredAt: "2026-07-01T15:00:00.000Z",
    whenRelative: "hace 3 días",
    whenAbsolute: "1 de jul de 2026",
    facts: [],
    note: null,
    provenance: { verified: false, label: "Declarado por vos" },
    warning: "Falta verificación profesional",
    amendedAt: null,
    hasAttachment: false,
    canAmend: false,
    ...over,
  } as LibretaEntryV1;
}

function aTick(id: string, over: Partial<LibretaEntryV1> = {}): LibretaEntryV1 {
  return anEntry({
    eventId: id,
    eventType: "event_amended",
    kind: "Viaje",
    title: "Papeles del viaje actualizados",
    warning: null,
    facts: [
      { key: "Fecha", value: "1 de jul de 2026", missing: false, mono: false },
      { key: "Destino", value: "Chile", missing: false, mono: false },
      { key: "Fecha del viaje", value: "15 de nov de 2026", missing: false, mono: false },
    ],
    ...over,
  });
}

describe("offersVerificationRequest — the web's verifyHref rule", () => {
  it("offers it for an unverified rabies dose", () => {
    expect(offersVerificationRequest(anEntry())).toBe(true);
  });

  it("does not for a verified one, another vaccine, or another record", () => {
    expect(
      offersVerificationRequest(anEntry({ provenance: { verified: true, label: "Verificado" } })),
    ).toBe(false);
    expect(offersVerificationRequest(anEntry({ kind: "Vacuna", title: "Séxtuple" }))).toBe(false);
    expect(offersVerificationRequest(anEntry({ eventType: "deworming_administered" }))).toBe(false);
  });
});

describe("groupLedgerEntries — papers ticks drawn as one row", () => {
  it("collapses a run of same-trip, same-day ticks and names the count and country", () => {
    const items = groupLedgerEntries([aTick("t3"), aTick("t2"), aTick("t1"), anEntry()]);
    expect(items).toHaveLength(2);
    const [first, second] = items;
    expect(first?.kind).toBe("papers");
    if (first?.kind !== "papers") throw new Error("expected a papers row");
    expect(first.label).toBe("Papeles del viaje actualizados · 3 cambios · Chile");
    expect(first.entries.map((e) => e.eventId)).toEqual(["t3", "t2", "t1"]);
    expect(second).toEqual({ kind: "entry", entry: anEntry() });
  });

  it("keeps ticks apart across days, trips, and anything in between", () => {
    const otherDay = aTick("t0", { whenAbsolute: "30 de jun de 2026" });
    const otherTrip = aTick("tx", {
      facts: [{ key: "Destino", value: "Uruguay", missing: false, mono: false }],
    });
    const items = groupLedgerEntries([
      aTick("t2"),
      otherTrip,
      aTick("t1"),
      anEntry(),
      aTick("tz"),
      otherDay,
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "entry",
      "entry",
      "entry",
      "entry",
      "entry",
      "entry",
    ]);
  });

  it("keys the group by trip and day, so a NEW tick does not change it (QA v14 review)", () => {
    const before = groupLedgerEntries([aTick("t2"), aTick("t1")])[0];
    const after = groupLedgerEntries([aTick("t3"), aTick("t2"), aTick("t1")])[0];
    if (before?.kind !== "papers" || after?.kind !== "papers") throw new Error("expected papers");
    expect(after.key).toBe(before.key);
    expect(after.key).not.toContain("t3");
  });

  it("leaves a single tick as its own asiento, title untouched", () => {
    expect(groupLedgerEntries([aTick("t1")])).toEqual([{ kind: "entry", entry: aTick("t1") }]);
  });

  it("does not key a real correction or another record", () => {
    expect(tripPapersTickKey(anEntry())).toBeNull();
    expect(tripPapersTickKey(aTick("c", { title: "Corrección" }))).toBeNull();
    expect(tripPapersTickKey(aTick("t"))).toBe("Chile|15 de nov de 2026|1 de jul de 2026");
  });

  it("does not group ticks whose trip fell out of the read (no Destino)", () => {
    const orphan = (id: string) =>
      aTick(id, {
        facts: [{ key: "Fecha", value: "1 de jul de 2026", missing: false, mono: false }],
      });
    expect(tripPapersTickKey(orphan("o1"))).toBeNull();
    expect(groupLedgerEntries([orphan("o2"), orphan("o1")]).map((i) => i.kind)).toEqual([
      "entry",
      "entry",
    ]);
  });

  it("numbers the ticks of a run in the order they happened, as the web does", () => {
    expect([0, 1].map((i) => tripPapersTickLabel(i, 2))).toEqual([
      "Cambio 2 de 2",
      "Cambio 1 de 2",
    ]);
  });

  it("omits an unknown country from the label", () => {
    expect(tripPapersGroupLabel(2, null)).toBe("Papeles del viaje actualizados · 2 cambios");
  });
});
