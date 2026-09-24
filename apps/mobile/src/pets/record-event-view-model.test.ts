// `record-event-view-model` — the mapping between a filled-in form and the wire.
//
// The render tests beside this one prove the screen wires up; these prove the
// small number of DECISIONS the mapping makes, which are the ones a screen test
// would only reach through six taps each.

import { describe, expect, it } from "@jest/globals";

import {
  RECORD_KINDS,
  attestationRegistryOptions,
  conditionalKinds,
  emptyDraft,
  inputCodeMessage,
  isWritableKind,
  kindSubtitle,
  kindTitle,
  restoredDraftNote,
  symptomSeverityLabel,
  tattooLocationLabel,
  todayInAr,
  validateDraft,
} from "./record-event-view-model";

const A_DAY = "2026-08-20";

function draft(overrides: Partial<ReturnType<typeof emptyDraft>> = {}) {
  return { ...emptyDraft(new Date("2026-08-25T15:00:00Z")), occurredAt: A_DAY, ...overrides };
}

describe("todayInAr — the default date a form offers", () => {
  it("uses ARGENTINE calendar days, not the device's idea of today", () => {
    // 01:30 UTC on the 26th is still the 25th in Buenos Aires. A phone that
    // travels with its owner would otherwise pre-fill tomorrow, and the server
    // would refuse a day the owner never chose.
    expect(todayInAr(new Date("2026-08-26T01:30:00Z"))).toBe("2026-08-25");
    expect(todayInAr(new Date("2026-08-25T14:00:00Z"))).toBe("2026-08-25");
  });

  it("rolls over at 21:00 UTC, which is midnight in Buenos Aires", () => {
    expect(todayInAr(new Date("2026-08-25T20:59:00Z"))).toBe("2026-08-25");
    expect(todayInAr(new Date("2026-08-25T21:00:00Z"))).toBe("2026-08-25");
    expect(todayInAr(new Date("2026-08-26T03:00:00Z"))).toBe("2026-08-26");
  });
});

describe("validateDraft — what leaves the device", () => {
  it("reads an es-AR decimal comma as a decimal point", () => {
    const result = validateDraft("weight", draft({ kg: "12,5" }));
    expect(result.ok && result.input).toMatchObject({ kind: "weight", kg: 12.5 });
  });

  it("turns every untouched optional into null, not into an empty string", () => {
    // A `""` on the wire would be a STATED empty value where the person stated
    // nothing, and the ledger would carry a brand of "".
    const result = validateDraft("vaccination", draft({ vaccineName: "Antirrábica", brand: "  " }));
    expect(result.ok && result.input).toMatchObject({ brand: null, batch: null, notes: null });
  });

  it("joins the two first-dose fields into the one string the contract describes", () => {
    const result = validateDraft(
      "medication_start",
      draft({
        drugName: "Amoxicilina",
        dose: "250 mg",
        firstDoseDay: A_DAY,
        firstDoseTime: "08:00",
      }),
    );
    expect(result.ok && result.input).toMatchObject({ firstDoseAt: "2026-08-20T08:00" });
  });

  it("carries the source asiento a medication END names, and refuses without one", () => {
    const withSource = validateDraft("medication_end", draft(), {
      sourceEventId: "33333333-3333-4333-8333-333333333333",
    });
    expect(withSource.ok).toBe(true);

    const without = validateDraft("medication_end", draft());
    expect(without.ok).toBe(false);
    expect(!without.ok && without.code).toBe("MEDICATION_SOURCE_REQUIRED");
  });

  it("tells a filled-in unreadable weight apart from a missing one", () => {
    // `kg` is a number on the wire, so "abc" arrives as NaN — and zod rejects
    // NaN as an INVALID TYPE, the same issue a missing number raises. Without
    // the pre-check both said "Falta el peso." and one of them was looking at a
    // field with "abc" in it.
    const unreadable = validateDraft("weight", draft({ kg: "abc" }));
    expect(!unreadable.ok && unreadable.code).toBe("WEIGHT_INVALID");
    expect(!unreadable.ok && unreadable.message).toContain("número");

    const missing = validateDraft("weight", draft({ kg: "  " }));
    expect(!missing.ok && missing.code).toBe("WEIGHT_REQUIRED");
  });

  it("refuses what the SERVER would refuse, before the network sees it", () => {
    const tooHeavy = validateDraft("weight", draft({ kg: "500" }));
    expect(!tooHeavy.ok && tooHeavy.code).toBe("WEIGHT_TOO_HIGH");
    expect(!tooHeavy.ok && tooHeavy.message).toContain("120 kg");

    const noDay = validateDraft(
      "vaccination",
      draft({ vaccineName: "X", occurredAt: "2026-02-31" }),
    );
    expect(!noDay.ok && noDay.code).toBe("OCCURRED_AT_INVALID");
  });

  it("passes the same-day override through only when it was asked for", () => {
    const first = validateDraft("vaccination", draft({ vaccineName: "X" }));
    expect(first.ok && first.input).toMatchObject({ sameDayOverride: false });
    const second = validateDraft("vaccination", draft({ vaccineName: "X" }), {
      sameDayOverride: true,
    });
    expect(second.ok && second.input).toMatchObject({ sameDayOverride: true });
  });
});

describe("the copy every branch owes", () => {
  it("names and describes EVERY pickable kind, plus the one that is not", () => {
    // Driven off `RECORD_KINDS` rather than a list written here, which is what
    // makes a kind added to the union a failing test instead of an untested
    // one.
    for (const kind of [...RECORD_KINDS, "medication_end" as const]) {
      expect(kindTitle(kind).length).toBeGreaterThan(0);
      expect(kindSubtitle(kind).length).toBeGreaterThan(0);
    }
  });

  it("says SOMETHING even when the contract named nothing", () => {
    // A parse that fails on a code this build does not know must not render a
    // blank line under the button. Honest about being unable to say more.
    expect(inputCodeMessage(null).length).toBeGreaterThan(0);
  });
});

describe("validateDraft — síntoma, the kind with no date of its own", () => {
  it("sends the free text alone, with no occurredAt the person never chose", () => {
    // `emptyDraft` pre-fills `occurredAt` with today because ten kinds need it.
    // Síntoma does not have the field at all, and sending the pre-filled value
    // as an onset would be this form answering a question nobody asked.
    const result = validateDraft("symptom", draft({ freeText: "Decaído, no come" }));
    expect(result.ok && result.input).toEqual({
      kind: "symptom",
      freeText: "Decaído, no come",
      severity: null,
      onsetAt: null,
    });
  });

  it("refuses an empty description with its OWN sentence, not the nota's", () => {
    const result = validateDraft("symptom", draft({ freeText: "   " }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("SYMPTOM_TEXT_REQUIRED");
    expect(!result.ok && result.message).toBe("Contá qué le viste.");
  });

  it("keeps a blank onset as null and holds a stated one to the calendar", () => {
    const blank = validateDraft("symptom", draft({ freeText: "Tos", onsetAt: "   " }));
    expect(blank.ok && blank.input).toMatchObject({ onsetAt: null });

    const stated = validateDraft("symptom", draft({ freeText: "Tos", onsetAt: A_DAY }));
    expect(stated.ok && stated.input).toMatchObject({ onsetAt: A_DAY });

    const impossible = validateDraft("symptom", draft({ freeText: "Tos", onsetAt: "2026-02-31" }));
    expect(!impossible.ok && impossible.code).toBe("ONSET_AT_INVALID");
  });

  it("carries a chosen severity and leaves an unchosen one null", () => {
    const none = validateDraft("symptom", draft({ freeText: "Tos" }));
    expect(none.ok && none.input).toMatchObject({ severity: null });

    const chosen = validateDraft("symptom", draft({ freeText: "Tos", severity: "severe" }));
    expect(chosen.ok && chosen.input).toMatchObject({ severity: "severe" });
  });

  it("labels the three severities without borrowing triage words", () => {
    // Nothing downstream reads this value — the alert cascade is decided by what
    // the FREE TEXT matched — so "urgente" here would be the app implying that
    // picking one summons somebody.
    expect(symptomSeverityLabel("mild")).toBe("Leve");
    expect(symptomSeverityLabel("moderate")).toBe("Moderado");
    expect(symptomSeverityLabel("severe")).toBe("Grave");
  });

  it("warns about the sanitary authority BEFORE the form, in the subtitle", () => {
    // This is the one asiento whose write can leave the animal's own record. A
    // person is entitled to know that while they can still decide not to send it.
    expect(kindSubtitle("symptom")).toContain("autoridad sanitaria");
  });
});

describe("isWritableKind — the route boundary", () => {
  it("accepts every kind this build writes and refuses anything else", () => {
    expect(isWritableKind("vaccination")).toBe(true);
    expect(isWritableKind("medication_end")).toBe(true);
    // A deep link carrying a kind this build does not know lands on the picker,
    // which is where the person was going.
    expect(isWritableKind("death_recorded")).toBe(false);
    expect(isWritableKind("")).toBe(false);
  });
});

describe("attestationRegistryOptions", () => {
  it("falls back to the national pair plus Otro registro when the jurisdiction named none", () => {
    // The common case in production: the rule defaults to an empty list
    // everywhere, and this is exactly what the web offers there.
    expect(attestationRegistryOptions([]).map((r) => r.id)).toEqual([
      "caba_4078",
      "prov_14107",
      "other",
    ]);
  });

  it("replaces the fallback with the jurisdiction's list and KEEPS Otro registro", () => {
    const options = attestationRegistryOptions([
      { id: "prov_neuquen", label: "Neuquén · Registro provincial", required: true },
    ]);
    expect(options.map((r) => r.id)).toEqual(["prov_neuquen", "other"]);
    // NON-VACUITY: the national pair is GONE, not merely joined.
    expect(options.some((r) => r.id === "caba_4078")).toBe(false);
  });

  it("does not append a second Otro registro when the jurisdiction already named one", () => {
    const options = attestationRegistryOptions([
      { id: "other", label: "Otro", required: false },
      { id: "prov_neuquen", label: "Neuquén", required: true },
    ]);
    expect(options.filter((r) => r.id === "other")).toHaveLength(1);
  });
});

describe("conditionalKinds — the one rule both conditional rows share", () => {
  const facts = (o: Partial<Parameters<typeof conditionalKinds>[0]> = {}) => ({
    sex: "female",
    species: "dog",
    pregnancyStatus: "none",
    // Withheld by default so this block stays about the pregnancy rule; the
    // check-in has its own block below.
    postAdoptionCheckinPending: false,
    ...o,
  });

  it("offers the START to a female of a known species with no follow-up open", () => {
    expect(conditionalKinds(facts())).toEqual(["pregnancy_start"]);
  });

  it("offers the END, and ONLY the end, while a follow-up is open", () => {
    const offered = conditionalKinds(facts({ pregnancyStatus: "in_progress" }));
    expect(offered).toEqual(["pregnancy_end"]);
    // NON-VACUITY: the two halves are mutually exclusive. A "registrar embarazo"
    // row here would offer a form the server refuses with `pregnancy_already_open`.
    expect(offered).not.toContain("pregnancy_start");
  });

  it("offers the start again once a previous pregnancy has been closed", () => {
    // `completed_live_birth` is what `rederivePregnancyStatus` writes. Anything
    // that is not `in_progress` is a closed record, and a closed record does not
    // block the next gestation.
    expect(conditionalKinds(facts({ pregnancyStatus: "completed_live_birth" }))).toEqual([
      "pregnancy_start",
    ]);
  });

  it("offers NOTHING to a male, whatever the pregnancy status says", () => {
    expect(conditionalKinds(facts({ sex: "male" }))).toEqual([]);
    // Even a cache that somehow says in_progress: the sex is the harder fact.
    expect(conditionalKinds(facts({ sex: "male", pregnancyStatus: "in_progress" }))).toEqual([]);
  });

  it("offers NOTHING for a species this build cannot date a gestation for", () => {
    expect(conditionalKinds(facts({ species: "parrot" }))).toEqual([]);
    // NON-VACUITY: the same animal with a species the table names DOES get a row,
    // so the emptiness above is the species and not the fixture.
    expect(conditionalKinds(facts({ species: "rabbit" }))).toEqual(["pregnancy_start"]);
  });

  it("OFFERS BOTH when the read came back degraded, rather than hiding them", () => {
    // The decision this function exists to make. A read that failed leaves every
    // fact null, and hiding a capability then is a dead end the person cannot see
    // — the app would silently stop being able to record a pregnancy. Offering
    // costs a round trip and a sentence that names the real reason, from the
    // server, which is authoritative where this function only guesses.
    // EVERY conditional row, the check-in included: a read that failed outright
    // knows nothing about the window either.
    expect(
      conditionalKinds({
        sex: null,
        species: null,
        pregnancyStatus: null,
        postAdoptionCheckinPending: null,
      }),
    ).toEqual(["pregnancy_start", "pregnancy_end", "post_adoption_checkin"]);
  });

  it("still refuses on the fact it DOES have when only the other one is unknown", () => {
    // A partial read is not a failed one: a known male is a male whatever the
    // species section said.
    const withheld = { pregnancyStatus: null, postAdoptionCheckinPending: false };
    expect(conditionalKinds({ sex: "male", species: null, ...withheld })).toEqual([]);
    expect(conditionalKinds({ sex: null, species: "parrot", ...withheld })).toEqual([]);
  });
});

describe("conditionalKinds — the check-in row, on the one fact the server resolves", () => {
  // A male dog, so the pregnancy rows stay out of the way and the array IS the
  // check-in's answer.
  const facts = (pending: boolean | null) => ({
    sex: "male",
    species: "dog",
    pregnancyStatus: "none",
    postAdoptionCheckinPending: pending,
  });

  it("offers the row while the refugio has a window open", () => {
    expect(conditionalKinds(facts(true))).toEqual(["post_adoption_checkin"]);
  });

  it("withholds it when nothing is pending — the form's only outcome would be a refusal", () => {
    // Never adopted through the platform, adopted by somebody else, or every
    // window closed: the server folds the three into one `false`, and the menu
    // does not need to know which. The web's anotar menu withholds its entry
    // the same way.
    expect(conditionalKinds(facts(false))).toEqual([]);
  });

  it("OFFERS it when the window read came back degraded, rather than hiding it", () => {
    // The third state, and the one worth defending: `pending: false` and
    // `unavailable` reach this function as `false` and `null`, and they must
    // not collapse. A capability hidden behind a failed read is a dead end
    // nobody can see; offered, the worst case is the server's own sentence
    // (`checkin_no_open_window`) naming the real reason.
    expect(conditionalKinds(facts(null))).toEqual(["post_adoption_checkin"]);
  });

  it("sits AFTER the pregnancy rows, so a late arrival moves nothing above it", () => {
    expect(
      conditionalKinds({
        sex: "female",
        species: "dog",
        pregnancyStatus: "none",
        postAdoptionCheckinPending: true,
      }),
    ).toEqual(["pregnancy_start", "post_adoption_checkin"]);
  });
});

describe("tatuaje — el asiento que no viaja sin foto", () => {
  const A_STAGED_PATH =
    "77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888.jpg";

  it("REFUSES without a staged photo, and names the step rather than a field", () => {
    // La persona nunca escribe un `stagedPath` — lo produce la subida — asi que
    // una copia que dijera "revisá el campo stagedPath" nombraria algo que no
    // existe en la pantalla.
    const result = validateDraft("tattoo", draft({ tattooCode: "ABC-1234" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("TATTOO_PHOTO_REQUIRED");
    expect(result.message).toBe(
      "Falta la foto del tatuaje. Elegí una imagen antes de registrarlo.",
    );
  });

  it("sends the code, the place and the staged photo once it has one", () => {
    const result = validateDraft(
      "tattoo",
      draft({
        tattooCode: "ABC-1234",
        tattooLocation: "inner_thigh",
        tattooDescription: "Letras negras",
        tattooRecordedBy: "Veterinaria del barrio",
      }),
      { stagedPath: A_STAGED_PATH },
    );
    if (!result.ok) throw new Error(`expected the draft to validate, got ${result.code}`);
    expect(result.input).toEqual({
      kind: "tattoo",
      occurredAt: A_DAY,
      tattooCode: "ABC-1234",
      locationOnBody: "inner_thigh",
      description: "Letras negras",
      recordedBy: "Veterinaria del barrio",
      stagedPath: A_STAGED_PATH,
    });
  });

  it("manda la fecha en null cuando la persona la borra — 'no sé cuándo' es una respuesta", () => {
    // El escritor asienta esa ausencia como un hecho (`tattoo_date_known:
    // false`) en vez de inventar un dia. Un tatuaje leido de un animal adoptado
    // no tiene fecha conocida.
    const result = validateDraft("tattoo", draft({ tattooCode: "ABC-1234", occurredAt: "" }), {
      stagedPath: A_STAGED_PATH,
    });
    if (!result.ok) throw new Error(`expected the draft to validate, got ${result.code}`);
    expect(result.input).toMatchObject({ occurredAt: null });
  });

  it("refuses an empty code before the network", () => {
    const result = validateDraft("tattoo", draft({ tattooCode: "   " }), {
      stagedPath: A_STAGED_PATH,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("TATTOO_CODE_REQUIRED");
    expect(result.message).toBe("Falta el código del tatuaje.");
  });

  it("empieza sin lugar elegido: null y no 'otro lugar'", () => {
    // "Otro lugar" es una respuesta que alguien elige, no la que le queda a
    // quien no contesto. El valor viaja a `pet_identifications.tattoo_location`.
    expect(emptyDraft(new Date("2026-08-25T15:00:00Z")).tattooLocation).toBe(null);
  });

  it("nombra los cinco lugares en las palabras de quien mira al animal", () => {
    expect(tattooLocationLabel("inner_ear_left")).toBe("Oreja izquierda, por dentro");
    expect(tattooLocationLabel("inner_ear_right")).toBe("Oreja derecha, por dentro");
    expect(tattooLocationLabel("inner_thigh")).toBe("Ingle o cara interna del muslo");
    expect(tattooLocationLabel("belly")).toBe("Panza");
    expect(tattooLocationLabel("other")).toBe("Otro lugar");
  });

  it("avisa que la foto es obligatoria ANTES del formulario, en el subtítulo", () => {
    // Es el unico asiento que exige un archivo, y descubrirlo al apretar el
    // boton seria descubrirlo tarde.
    expect(kindSubtitle("tattoo")).toBe(
      "Necesita una foto del tatuaje. Reemplaza al que estuviera cargado: la credencial muestra el último.",
    );
    expect(kindTitle("tattoo")).toBe("Tatuaje");
  });

  it("está en el selector, junto al otro acto de identidad", () => {
    expect(RECORD_KINDS).toContain("tattoo");
    expect(RECORD_KINDS.indexOf("tattoo")).toBe(RECORD_KINDS.indexOf("microchip") + 1);
  });

  it("nombra el paso que falta para cada código del tatuaje", () => {
    expect(inputCodeMessage("TATTOO_LOCATION_INVALID")).toBe("Elegí dónde está el tatuaje.");
  });
});

describe("restoredDraftNote — where the recovered text came from", () => {
  // 18:00 UTC on the 17th is 15:00 in Buenos Aires.
  const NOW = new Date("2026-09-17T18:00:00Z");

  it("says the HOUR for something written today, not the date", () => {
    // Most recoveries are minutes or hours old: the call that came in, the app
    // the OS reclaimed while somebody answered the door. Telling that person
    // the calendar date of today reads as if the app had dug up something
    // ancient, which is the opposite of the reassurance the banner is for.
    expect(restoredDraftNote(Date.parse("2026-09-17T17:30:00Z"), NOW)).toContain(
      "Lo escribiste hoy a las 14:30",
    );
  });

  it("says 'ayer' across the Argentine midnight, not the UTC one", () => {
    // 01:30 UTC on the 17th is 22:30 on the 16th in Buenos Aires. Reading this
    // in UTC would tell somebody "hoy" about writing they did last night.
    expect(restoredDraftNote(Date.parse("2026-09-17T01:30:00Z"), NOW)).toContain(
      "Lo escribiste ayer a las 22:30",
    );
  });

  it("falls back to the date once the hour has stopped meaning anything", () => {
    expect(restoredDraftNote(Date.parse("2026-09-12T12:00:00Z"), NOW)).toContain(
      "Lo escribiste el 12/09/2026",
    );
  });

  it("says that nothing was registered, in every arm", () => {
    // THE HALF THAT MATTERS. A banner that only announced a recovery would read
    // like a receipt to somebody who was interrupted mid-form, and these
    // asientos cannot be taken back once appended.
    for (const at of ["2026-09-17T17:30:00Z", "2026-09-17T01:30:00Z", "2026-09-12T12:00:00Z"]) {
      expect(restoredDraftNote(Date.parse(at), NOW)).toContain("Todavía no se registró nada");
    }
  });
});
