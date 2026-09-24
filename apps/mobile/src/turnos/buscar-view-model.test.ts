// Every sentence the buscar/reservar screens draw, asserted without rendering.
//
// WHAT THESE HAVE TO PROVE, beyond "it formats"
// ---------------------------------------------------------------------------
//   1. THE WINDOW COMES FROM THE PAYLOAD. The list read looks seven days ahead
//      and the offering read sixty, so a hard-coded "7" in the availability
//      sentence would claim the wrong figure on the grid screen.
//   2. THE SLOT CLOCK IS ARGENTINE AND 24-HOUR, ON A DEVICE SET TO ANY ZONE. A
//      turno is at a place, at an hour that place keeps.
//   3. A BLOCKED ANIMAL SAYS WHY, and says CAMPAIGN rather than slot: the rule is
//      per (pet, offering), so picking a different time changes nothing.
//   4. A GUESSED JURISDICTION SAYS IT WAS GUESSED. The web draws the prefill into
//      its own filter form where it reads as something the person typed.

import { describe, expect, it, jest } from "@jest/globals";

import type { BookableOfferingV1, BookablePetV1, BookableSlotV1 } from "@dim/contract/api";

import {
  blockedReasonLabel,
  buildBookSlot,
  groupSlotsByDay,
  jurisdictionNoteLabel,
  jurisdictionRowCaption,
  jurisdictionRowLabel,
  noBookablePetsLabel,
  noResultsLabel,
  offeringAvailabilityLabel,
  offeringKindLabel,
  offeringMetaLabel,
  offeringTitle,
  petChoiceLabel,
  slotDayHeading,
  slotPlacesLabel,
  slotTimeLabel,
} from "./buscar-view-model";

const SLOT_UUID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

/**
 * Every `timeZone` option the code under test asked `Intl` for, while `run` ran.
 *
 * WHY THIS INSTRUMENT AND NOT A DIFFERENT DEVICE ZONE. The assertion that matters
 * is "this code pins Argentina", and comparing rendered strings cannot make it:
 * the machine this project is developed on resolves to
 * `America/Argentina/Salta`, which is the same offset, so DELETING
 * `timeZone: AR_TIME_ZONE` changes not one character of the output. Measured, not
 * assumed — both timezone cases below passed over exactly that mutation until
 * this helper existed, and setting `process.env.TZ` inside the module does not
 * help either, because the environment has already resolved its default zone by
 * the time a test file's body runs.
 *
 * So the question asked here is the one a compiled-SQL fence asks of a query:
 * what did the code REQUEST? A formatter constructed with no `timeZone` follows
 * whatever device it lands on, and that is the defect — independently of whether
 * today's device happens to agree.
 */
function timeZonesAskedFor(run: () => unknown): Array<string | undefined> {
  const asked: Array<string | undefined> = [];
  const original = Intl.DateTimeFormat;
  // The cast is what lets a plain function stand in for a CONSTRUCTOR that jest's
  // signature types as its own overloaded self. `unknown` first, so the assertion
  // is the narrow one `noExplicitAny` exists to keep out of production code.
  const stand_in = (locale?: string, options?: Intl.DateTimeFormatOptions) => {
    asked.push(options?.timeZone);
    return new original(locale, options);
  };
  const spy = jest
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(stand_in as unknown as typeof Intl.DateTimeFormat);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return asked;
}

function anOffering(over: Partial<BookableOfferingV1> = {}): BookableOfferingV1 {
  return {
    offeringToken: "SVO-7K2M-9QX4",
    displayName: "Campaña antirrábica — Plaza San Martín",
    description: null,
    serviceKind: "vaccination_rabies",
    serviceKindLabel: "Vacunación antirrábica",
    provider: {
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: null,
      locality: null,
    },
    durationMinutes: 15,
    priceArs: null,
    coverageLabel: "San Carlos de Bariloche",
    slotsInWindow: 3,
    nextSlotAt: "2026-09-03T13:30:00.000Z",
    ...over,
  };
}

function aSlot(over: Partial<BookableSlotV1> = {}): BookableSlotV1 {
  return {
    slotId: SLOT_UUID,
    // 13:30Z is 10:30 in Buenos Aires (UTC-3), which is what makes this fixture
    // able to tell a device clock from an Argentine one.
    startsAt: "2026-09-03T13:30:00.000Z",
    endsAt: "2026-09-03T13:45:00.000Z",
    placesLeft: 1,
    ...over,
  };
}

function aPet(over: Partial<BookablePetV1> = {}): BookablePetV1 {
  return {
    publicToken: "DIM-PAMP-0001",
    name: "Pampa",
    canBook: true,
    blockedReason: null,
    ...over,
  };
}

describe("the offering's headline and meta", () => {
  it("uses the PROVIDER's own name for the service as the heading", () => {
    // `display_name` is `text NOT NULL` so it is always there, and "Campaña
    // antirrábica — Plaza San Martín" says more to somebody choosing where to go
    // than the catalogue's "Vacunación antirrábica" does.
    expect(offeringTitle(anOffering())).toBe("Campaña antirrábica — Plaza San Martín");
  });

  it("says GRATUITO for a free service and never $0", () => {
    // A free vaccination campaign and a service somebody priced at zero are
    // different facts, and only one of them is a thing this product has.
    expect(offeringMetaLabel(anOffering({ priceArs: null }))).toBe(
      "Gratuito · 15 min · San Carlos de Bariloche",
    );
  });

  it("formats a price in es-AR and keeps the duration and the coverage", () => {
    expect(offeringMetaLabel(anOffering({ priceArs: 12500 }))).toBe(
      "$12.500 · 15 min · San Carlos de Bariloche",
    );
  });

  it("drops an absent coverage rather than leaving a trailing separator", () => {
    // A trailing " · " is how a meta line tells the reader something failed to
    // load, and here nothing did.
    expect(offeringMetaLabel(anOffering({ coverageLabel: null }))).toBe("Gratuito · 15 min");
  });

  it("returns null for a service kind the catalogue does not know", () => {
    // The screen then draws nothing. A raw `snake_case` code under the provider's
    // name is the exact shape QA 2026-08-08 (S3-F07) found on the web.
    expect(offeringKindLabel(anOffering({ serviceKindLabel: null }))).toBe(null);
    expect(offeringKindLabel(anOffering())).toBe("Vacunación antirrábica");
  });
});

describe("the availability sentence", () => {
  it("takes the window from the PAYLOAD and not from a literal", () => {
    // THE CASE THIS FILE EXISTS FOR. The same offering renders one sentence on the
    // seven-day list and another on the sixty-day grid, and a hard-coded 7 would
    // claim the wrong figure on the screen that shows sixty days of slots.
    const offering = anOffering({ slotsInWindow: 3 });
    expect(offeringAvailabilityLabel(offering, 7)).toBe("3 turnos disponibles en 7 días");
    expect(offeringAvailabilityLabel(offering, 60)).toBe("3 turnos disponibles en 60 días");
  });

  it("agrees in number for a single turno and a single day", () => {
    expect(offeringAvailabilityLabel(anOffering({ slotsInWindow: 1 }), 1)).toBe(
      "1 turno disponible en 1 día",
    );
  });
});

describe("the zone row — the control that names where the search looked", () => {
  it("names locality AND province, because a locality alone is ambiguous", () => {
    // "San Martín" is a place in most provinces. The string labels a CONTROL now,
    // so somebody deciding whether to change it has to know which one they are in.
    expect(
      jurisdictionRowLabel({
        appliedProvince: "Buenos Aires",
        appliedLocality: "San Justo",
      }),
    ).toBe("Buscar cerca de: San Justo, Buenos Aires");
  });

  it("falls back to the province when only that half is known", () => {
    expect(jurisdictionRowLabel({ appliedProvince: "Río Negro", appliedLocality: null })).toBe(
      "Buscar cerca de: Río Negro",
    );
  });

  it("falls back to the locality when only THAT half is known", () => {
    expect(jurisdictionRowLabel({ appliedProvince: null, appliedLocality: "El Bolsón" })).toBe(
      "Buscar cerca de: El Bolsón",
    );
  });

  it("is still a row when there is no place at all, because it is the only way to narrow", () => {
    // The old note returned `null` here and the screen drew nothing. That was
    // right for a caption and wrong for a control: a person with no animal
    // registered has no other way to scope the search.
    expect(jurisdictionRowLabel({ appliedProvince: null, appliedLocality: null })).toBe(
      "Buscando en todo el país",
    );
  });

  it("offers to CHANGE a place and to CHOOSE one when there is none", () => {
    expect(
      jurisdictionRowCaption({ appliedProvince: "Buenos Aires", appliedLocality: "San Justo" }),
    ).toBe("Cambiar la localidad.");
    expect(jurisdictionRowCaption({ appliedProvince: null, appliedLocality: null })).toBe(
      "Elegir una localidad.",
    );
  });

  it("starts the caption with the verb the tester guide tells people to look for", () => {
    // `dim-interno:docs/mobile/guia-tester.md` says to tap "Cambiar". `ListRow` has no
    // trailing action slot, so the caption IS the affordance's name — if the verb
    // stops leading the sentence, the guide is pointing at nothing.
    expect(
      jurisdictionRowCaption({ appliedProvince: "Buenos Aires", appliedLocality: "San Justo" }),
    ).toMatch(/^Cambiar/);
  });
});

describe("the jurisdiction note", () => {
  it("says a GUESSED place was guessed, which the web does not", () => {
    expect(
      jurisdictionNoteLabel({
        appliedProvince: "Río Negro",
        appliedLocality: "San Carlos de Bariloche",
        jurisdictionSource: "defaulted-from-pet",
      }),
    ).toBe("Es la zona donde registraste tu primera mascota. Podés cambiarla.");
  });

  it("does NOT repeat the place, which the row above already names", () => {
    // The note used to open with "Buscando cerca de <place>". Under a control
    // that says exactly that, a second copy is furniture — and two copies of one
    // fact are two things that can disagree.
    const note = jurisdictionNoteLabel({
      appliedProvince: "Río Negro",
      appliedLocality: "San Carlos de Bariloche",
      jurisdictionSource: "defaulted-from-pet",
    });
    expect(note).not.toContain("San Carlos de Bariloche");
    expect(note).not.toContain("Río Negro");
  });

  it("says NOTHING for a place the person CHOSE — the row already said it", () => {
    // This arm used to return "Buscando en Dina Huapi.". It existed only because
    // nothing else on the screen named the place; `jurisdictionRowLabel` does now.
    expect(
      jurisdictionNoteLabel({
        appliedProvince: "Río Negro",
        appliedLocality: "Dina Huapi",
        jurisdictionSource: "requested",
      }),
    ).toBe(null);
  });

  it("says NOTHING when there is no place, rather than drawing furniture", () => {
    // A search with no jurisdiction is national, and a line saying so adds a row
    // and no information.
    expect(
      jurisdictionNoteLabel({
        appliedProvince: null,
        appliedLocality: null,
        jurisdictionSource: "none",
      }),
    ).toBe(null);
  });

  it("says nothing for a GUESS that produced no place either", () => {
    // `defaulted-from-pet` with both halves null is reachable: a caller whose
    // first pet carries no jurisdiction at all. The provenance sentence would be
    // explaining where a place that does not exist came from.
    expect(
      jurisdictionNoteLabel({
        appliedProvince: null,
        appliedLocality: null,
        jurisdictionSource: "defaulted-from-pet",
      }),
    ).toBe(null);
  });
});

describe("the empty result", () => {
  it("names the place it looked in, so it does not read as `there is nothing`", () => {
    expect(noResultsLabel({ appliedProvince: "Río Negro", appliedLocality: "El Bolsón" })).toBe(
      "No hay turnos disponibles en El Bolsón para este servicio. Probá otra localidad.",
    );
  });

  it("says it without a place when there is none", () => {
    expect(noResultsLabel({ appliedProvince: null, appliedLocality: null })).toBe(
      "No hay turnos disponibles para este servicio en los próximos días.",
    );
  });
});

describe("the slot grid", () => {
  it("draws the ARGENTINE 24-hour clock, not the device's and not 12-hour", () => {
    // 13:30Z is 10:30 in Buenos Aires. `hour12` is stated rather than inherited
    // because es-AR resolves to a 12-hour clock in some ICU builds and to 24 in
    // others — the same slot would read "8:30" on one phone and "8:30 a. m." on
    // another.
    expect(slotTimeLabel(aSlot())).toBe("10:30");
    // AND THE ZONE IS ASKED FOR, which the string above cannot prove on a machine
    // that already sits in Argentina. See `timeZonesAskedFor`.
    expect(timeZonesAskedFor(() => slotTimeLabel(aSlot()))).toEqual([AR_TIME_ZONE]);
  });

  it("says `—` for an unreadable time rather than throwing or printing NaN", () => {
    expect(slotTimeLabel(aSlot({ startsAt: "not-a-date" }))).toBe("—");
  });

  it("draws the places left only when the slot holds more than one", () => {
    // "1 lugar" on an ordinary consultation is noise, and every slot in the grid
    // has at least one by construction.
    expect(slotPlacesLabel(aSlot({ placesLeft: 1 }))).toBe(null);
    expect(slotPlacesLabel(aSlot({ placesLeft: 4 }))).toBe("4 lugares");
  });

  it("heads a day in es-AR with the first letter capitalised", () => {
    expect(slotDayHeading("2026-09-03T13:30:00.000Z")).toBe("Jueves 3 de septiembre");
  });

  it("groups by ARGENTINE calendar day, not by the device's", () => {
    // 02:00Z on the 4th is 23:00 on the 3rd in Buenos Aires. Grouping on UTC would
    // file that slot under a day the clinic does not have.
    const slots = [
      aSlot({ slotId: "a", startsAt: "2026-09-03T13:30:00.000Z" }),
      aSlot({ slotId: "b", startsAt: "2026-09-04T02:00:00.000Z" }),
    ];
    const days = groupSlotsByDay(slots);
    expect(days).toHaveLength(1);
    expect(days[0]?.slots.map((s) => s.slotId)).toEqual(["a", "b"]);

    // AND EVERY FORMATTER IT BUILT ASKED FOR ARGENTINA — the grouping key and the
    // day heading alike. The grouping above is correct on a machine in Salta
    // whether or not the option is there; this is what says the option is there.
    const asked = timeZonesAskedFor(() => groupSlotsByDay(slots));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((zone) => zone === AR_TIME_ZONE)).toBe(true);
  });

  it("keeps the SERVER's order — days as they occur, slots as they arrive", () => {
    const days = groupSlotsByDay([
      aSlot({ slotId: "a", startsAt: "2026-09-03T13:30:00.000Z" }),
      aSlot({ slotId: "b", startsAt: "2026-09-03T14:00:00.000Z" }),
      aSlot({ slotId: "c", startsAt: "2026-09-05T13:00:00.000Z" }),
    ]);
    expect(days.map((d) => d.heading)).toEqual([
      "Jueves 3 de septiembre",
      "Sábado 5 de septiembre",
    ]);
    expect(days[0]?.slots.map((s) => s.slotId)).toEqual(["a", "b"]);
  });

  it("DROPS a slot whose time cannot be read, rather than filing it under `desconocida`", () => {
    // A time nobody can name is a time nobody can arrive at, and a bookable button
    // under it would be an appointment somebody cannot keep.
    const days = groupSlotsByDay([
      aSlot({ slotId: "ok" }),
      aSlot({ slotId: "broken", startsAt: "not-a-date" }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]?.slots.map((s) => s.slotId)).toEqual(["ok"]);
  });
});

describe("the animal picker", () => {
  it("names the CAMPAIGN and not the slot when an animal already holds a place", () => {
    // The rule is per (pet, offering). Copy that said "ya tiene este turno" would
    // send somebody to try the next hour, which changes nothing.
    expect(blockedReasonLabel("already_booked_in_offering")).toBe(
      "Ya tiene un turno reservado en este servicio.",
    );
  });

  it("draws a bookable animal as its name plus the token's last block", () => {
    expect(petChoiceLabel(aPet())).toBe("Pampa · 0001");
  });

  it("tells two animals with the SAME NAME apart", () => {
    // The finding (native QA batch 2, C2): the picker offered two identical rows
    // and the person had to guess which Rocco they were booking. Species is not
    // on the wire — `BookablePetV1` is token + name + canBook + blockedReason —
    // so the token's last block is the disambiguator that exists.
    const first = petChoiceLabel(aPet({ name: "Rocco", publicToken: "DIM-SKZU-1111" }));
    const second = petChoiceLabel(aPet({ name: "Rocco", publicToken: "DIM-MTQP-2222" }));

    expect(first).not.toBe(second);
    expect(first).toBe("Rocco · 1111");
    expect(second).toBe("Rocco · 2222");
  });

  it("falls back to the bare name rather than printing a stray separator", () => {
    // An empty token is not a shape this endpoint produces; what matters is that
    // the label degrades to the old behaviour instead of reading "Pampa · ".
    expect(petChoiceLabel(aPet({ publicToken: "" }))).toBe("Pampa");
  });

  it("falls back to the bare name for a publicToken that is not token-shaped either", () => {
    // The overclaim code review #5 found: petTokenSuffix's doc comment said ""
    // for anything not shaped like a token, but `"Rocco".split("-")` has one
    // block, so the old code upper-cased the whole string and printed
    // "Pampa · ROCCO" — a disambiguator manufactured from a string that just
    // happens to share a hyphen-free shape with a name.
    expect(petChoiceLabel(aPet({ publicToken: "Rocco" }))).toBe("Pampa");
  });

  it("draws a blocked animal WITH its reason, rather than hiding it", () => {
    expect(
      petChoiceLabel(
        aPet({ name: "Lola", canBook: false, blockedReason: "already_booked_in_offering" }),
      ),
    ).toBe("Lola · 0001 — Ya tiene un turno reservado en este servicio.");
  });

  it("reads `canBook` and not the absence of a reason, in BOTH directions", () => {
    // The contract says `canBook` is the server's and must not be derived. The
    // cases that separate "reads the flag" from "reads the reason and the flag
    // happens to agree" are the ones where the two DISAGREE — and the first of
    // them, alone, is not enough: `canBook: false` with no reason gives the same
    // answer under either rule, which is exactly how this case passed over a
    // mutant that read the reason instead. Measured, not assumed.
    expect(petChoiceLabel(aPet({ name: "Rocco", canBook: false, blockedReason: null }))).toBe(
      "Rocco · 0001",
    );
    // THE ONE THAT BITES. `canBook: true` with a reason set is contradictory, and
    // the flag is the authority: the animal is offered, bare. A label derived from
    // the reason would append a refusal to a row somebody can legitimately choose.
    expect(
      petChoiceLabel(
        aPet({ name: "Rocco", canBook: true, blockedReason: "already_booked_in_offering" }),
      ),
    ).toBe("Rocco · 0001");
  });

  it("says what an empty list MEANS, not that the read failed", () => {
    expect(noBookablePetsLabel()).toBe("Necesitás una mascota registrada para reservar un turno.");
  });
});

describe("buildBookSlot", () => {
  it("validates against the CONTRACT's schema and hands back the parsed command", () => {
    const result = buildBookSlot({ slotId: SLOT_UUID, petPublicToken: "DIM-PAMP-0001" });
    expect(result).toEqual({
      ok: true,
      input: { command: "book", slotId: SLOT_UUID, petPublicToken: "DIM-PAMP-0001" },
    });
  });

  it("refuses a slot id that is not uuid-shaped, with the field's own code", () => {
    const result = buildBookSlot({ slotId: "42", petPublicToken: "DIM-PAMP-0001" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SLOT_REQUIRED");
      // THE SENTENCE DOES NOT BLAME THE PERSON. Both fields come off a read the
      // screen is already holding, so this is only reachable when the grid is
      // stale — "actualizá" is the honest instruction.
      expect(result.message).toBe(
        "No pudimos identificar el horario. Actualizá la pantalla y elegí de nuevo.",
      );
    }
  });

  it("refuses an empty pet token and asks for the animal by name", () => {
    const result = buildBookSlot({ slotId: SLOT_UUID, petPublicToken: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PET_REQUIRED");
      expect(result.message).toBe("Elegí para qué mascota es el turno.");
    }
  });
});
