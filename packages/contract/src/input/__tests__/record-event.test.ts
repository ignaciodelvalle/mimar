// `recordEventInputSchema` — what a client may send to `POST .../events`.
//
// THE POINT OF TESTING A SCHEMA THE SERVER ALSO ENFORCES: this is the copy the
// CLIENT runs, before the network, to put a message under the right field. A
// rule that only the server knows is a rule the app can only discover from a
// 400 with no field detail.
//
// The calendar cases are the ones a reviewer should read first. They are not
// pedantry: `"2026-02-31"` passes a `YYYY-MM-DD` regex, and `new Date` rolls it
// silently to 3 March rather than failing, so without the round-trip refine a
// vaccination dated 31 February reaches an append-only ledger dated the 3rd.

import { describe, expect, it } from "vitest";

import {
  DEATH_CAUSES,
  MAX_WEIGHT_KG,
  firstRecordEventInputCode,
  recordEventInputSchema,
} from "../record-event.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = recordEventInputSchema.safeParse(body);
  return parsed.success ? null : firstRecordEventInputCode(parsed.error);
}

const A_DAY = "2026-08-20";

describe("recordEventInputSchema — the calendar", () => {
  it("accepts a real day", () => {
    expect(codeFor({ kind: "vaccination", vaccineName: "Antirrábica", occurredAt: A_DAY })).toBe(
      null,
    );
  });

  it("refuses a day that does not exist, which a regex alone would accept", () => {
    expect(
      codeFor({ kind: "vaccination", vaccineName: "Antirrábica", occurredAt: "2026-02-31" }),
    ).toBe("OCCURRED_AT_INVALID");
  });

  it("refuses a month that does not exist", () => {
    expect(
      codeFor({ kind: "vaccination", vaccineName: "Antirrábica", occurredAt: "2026-13-01" }),
    ).toBe("OCCURRED_AT_INVALID");
  });

  it("accepts 29 February in a leap year and refuses it otherwise", () => {
    const leap = { kind: "vaccination", vaccineName: "X", occurredAt: "2028-02-29" };
    const notLeap = { kind: "vaccination", vaccineName: "X", occurredAt: "2027-02-29" };
    expect(codeFor(leap)).toBe(null);
    expect(codeFor(notLeap)).toBe("OCCURRED_AT_INVALID");
  });

  it("reads a BLANK optional date as unstated, exactly as the web's action does", () => {
    // `String(formData.get("nextDueAt") ?? "").trim() || null` is what the web
    // writer does with an untouched date input. A schema that ran the regex over
    // `""` would refuse a request the other door takes happily.
    const parsed = recordEventInputSchema.parse({
      kind: "deworming",
      product: "Endogard",
      type: "internal",
      occurredAt: A_DAY,
      nextDueAt: "   ",
    });
    expect(parsed).toMatchObject({ nextDueAt: null });
    expect(codeFor({ kind: "weight", kg: 10, occurredAt: A_DAY, notes: "" })).toBe(null);
  });

  it("applies the same round-trip to a next-dose date", () => {
    expect(
      codeFor({
        kind: "deworming",
        product: "Endogard",
        type: "internal",
        occurredAt: A_DAY,
        nextDueAt: "2026-06-31",
      }),
    ).toBe("NEXT_DUE_AT_INVALID");
  });

  it("tells a WRONG SHAPE apart from a DAY THAT DOES NOT EXIST — two codes, two sentences", () => {
    // forms-F2 (mobile QoL audit 2026-09-05): one code covered both, so a
    // person who typed `20/08/2026` read "esa fecha no existe" — a calendar
    // sentence aimed at a format mistake. The consumer owns the words; it
    // cannot say two things over one code.
    const vax = { kind: "vaccination", vaccineName: "X" };
    expect(codeFor({ ...vax, occurredAt: "20/08/2026" })).toBe("OCCURRED_AT_MALFORMED");
    expect(codeFor({ ...vax, occurredAt: "2026-8-20" })).toBe("OCCURRED_AT_MALFORMED");
    expect(codeFor({ ...vax, occurredAt: "2026-02-31" })).toBe("OCCURRED_AT_INVALID");

    const dew = { kind: "deworming", product: "Endogard", type: "internal", occurredAt: A_DAY };
    expect(codeFor({ ...dew, nextDueAt: "31/06/2026" })).toBe("NEXT_DUE_AT_MALFORMED");
    expect(codeFor({ ...dew, nextDueAt: "2026-06-31" })).toBe("NEXT_DUE_AT_INVALID");

    const med = {
      kind: "medication_start",
      drugName: "Amoxicilina",
      dose: "250 mg",
      occurredAt: A_DAY,
      frequency: "once_daily",
    };
    expect(codeFor({ ...med, firstDoseAt: "20/08/2026 08:00" })).toBe("FIRST_DOSE_AT_MALFORMED");
    expect(codeFor({ ...med, firstDoseAt: "2026-08-20T25:00" })).toBe("FIRST_DOSE_AT_INVALID");

    expect(codeFor({ kind: "symptom", freeText: "Tos", onsetAt: "20/08/2026" })).toBe(
      "ONSET_AT_MALFORMED",
    );
    expect(codeFor({ kind: "symptom", freeText: "Tos", onsetAt: "2026-02-31" })).toBe(
      "ONSET_AT_INVALID",
    );
  });

  it("refuses an hour that does not exist on a first dose", () => {
    expect(
      codeFor({
        kind: "medication_start",
        drugName: "Amoxicilina",
        dose: "250 mg",
        occurredAt: A_DAY,
        frequency: "once_daily",
        firstDoseAt: "2026-08-20T25:00",
      }),
    ).toBe("FIRST_DOSE_AT_INVALID");
  });
});

describe("recordEventInputSchema — the six kinds", () => {
  it("names the kind when the discriminator is not one of the six", () => {
    expect(codeFor({ kind: "death_recorded", occurredAt: A_DAY })).toBe("KIND_REQUIRED");
  });

  it("requires a vaccine name", () => {
    expect(codeFor({ kind: "vaccination", vaccineName: "   ", occurredAt: A_DAY })).toBe(
      "VACCINE_NAME_REQUIRED",
    );
  });

  it("refuses a weight over the shared ceiling, and accepts one at it", () => {
    expect(codeFor({ kind: "weight", kg: MAX_WEIGHT_KG + 0.01, occurredAt: A_DAY })).toBe(
      "WEIGHT_TOO_HIGH",
    );
    expect(codeFor({ kind: "weight", kg: MAX_WEIGHT_KG, occurredAt: A_DAY })).toBe(null);
  });

  it("refuses a weight of zero or less — a fact nobody records", () => {
    expect(codeFor({ kind: "weight", kg: 0, occurredAt: A_DAY })).toBe("WEIGHT_INVALID");
    expect(codeFor({ kind: "weight", kg: -3, occurredAt: A_DAY })).toBe("WEIGHT_INVALID");
  });

  it("refuses an antiparasitic route outside the three the form offers", () => {
    expect(
      codeFor({ kind: "deworming", product: "Endogard", type: "oral", occurredAt: A_DAY }),
    ).toBe("DEWORMING_TYPE_INVALID");
  });

  it("demands an interval for a CUSTOM frequency and only for that one", () => {
    const base = {
      kind: "medication_start",
      drugName: "Amoxicilina",
      dose: "250 mg",
      occurredAt: A_DAY,
      firstDoseAt: "2026-08-20T08:00",
    };
    expect(codeFor({ ...base, frequency: "custom" })).toBe("CUSTOM_HOURS_INVALID");
    expect(codeFor({ ...base, frequency: "custom", customHours: 0 })).toBe("CUSTOM_HOURS_INVALID");
    expect(codeFor({ ...base, frequency: "custom", customHours: 25 })).toBe("CUSTOM_HOURS_INVALID");
    expect(codeFor({ ...base, frequency: "custom", customHours: 8 })).toBe(null);
    // A named frequency carries its own interval; a stray `customHours` beside
    // one is ignored rather than refused, exactly as `parseFrequencyFields` does.
    expect(codeFor({ ...base, frequency: "twice_daily", customHours: 99 })).toBe(null);
  });

  it("bounds a treatment's length at the web's 1–90 days", () => {
    const base = {
      kind: "medication_start",
      drugName: "Amoxicilina",
      dose: "250 mg",
      occurredAt: A_DAY,
      frequency: "once_daily",
      firstDoseAt: "2026-08-20T08:00",
    };
    expect(codeFor({ ...base, durationDays: 0 })).toBe("DURATION_DAYS_INVALID");
    expect(codeFor({ ...base, durationDays: 91 })).toBe("DURATION_DAYS_INVALID");
    expect(codeFor({ ...base, durationDays: 90 })).toBe(null);
    expect(codeFor(base)).toBe(null);
  });

  it("requires a uuid for the medication a stop refers to", () => {
    expect(
      codeFor({ kind: "medication_end", medicationStartedEventId: "med-1", occurredAt: A_DAY }),
    ).toBe("MEDICATION_SOURCE_REQUIRED");
  });

  it("requires note text and refuses a category outside the owner-facing five", () => {
    expect(codeFor({ kind: "note", text: "  ", occurredAt: A_DAY })).toBe("TEXT_REQUIRED");
    expect(codeFor({ kind: "note", text: "ok", occurredAt: A_DAY, category: "system" })).toBe(
      "NOTE_CATEGORY_INVALID",
    );
    expect(codeFor({ kind: "note", text: "ok", occurredAt: A_DAY, category: null })).toBe(null);
    expect(codeFor({ kind: "note", text: "ok", occurredAt: A_DAY, category: "dieta" })).toBe(null);
  });
});

describe("recordEventInputSchema — the shape it hands the caller", () => {
  it("normalizes every unstated optional to null, so a writer never sees three absences", () => {
    const parsed = recordEventInputSchema.parse({
      kind: "vaccination",
      vaccineName: "  Antirrábica  ",
      occurredAt: A_DAY,
      brand: "   ",
    });
    expect(parsed).toEqual({
      kind: "vaccination",
      vaccineName: "Antirrábica",
      occurredAt: A_DAY,
      brand: null,
      batch: null,
      administeredBy: null,
      nextDueAt: null,
      notes: null,
      sameDayOverride: false,
    });
  });
});

describe("recordEventInputSchema — the four WU-L kinds", () => {
  it("accepts a minimal body for each, and names the one missing required field", () => {
    expect(codeFor({ kind: "microchip", chipNumber: "982000123456789", occurredAt: A_DAY })).toBe(
      null,
    );
    expect(codeFor({ kind: "microchip", chipNumber: "  ", occurredAt: A_DAY })).toBe(
      "CHIP_NUMBER_REQUIRED",
    );

    expect(codeFor({ kind: "sterilization", procedure: "castration", occurredAt: A_DAY })).toBe(
      null,
    );
    expect(codeFor({ kind: "sterilization", procedure: "spay", occurredAt: A_DAY })).toBe(null);

    expect(codeFor({ kind: "vet_visit", reason: "Control anual", occurredAt: A_DAY })).toBe(null);
    expect(codeFor({ kind: "vet_visit", reason: "", occurredAt: A_DAY })).toBe(
      "VISIT_REASON_REQUIRED",
    );

    expect(
      codeFor({
        kind: "clinical_info",
        subKind: "lab_work",
        title: "Hemograma",
        occurredAt: A_DAY,
      }),
    ).toBe(null);
    expect(
      codeFor({ kind: "clinical_info", subKind: "lab_work", title: " ", occurredAt: A_DAY }),
    ).toBe("CLINICAL_TITLE_REQUIRED");
  });

  it("refuses a sterilization procedure the web's form does not offer", () => {
    expect(codeFor({ kind: "sterilization", procedure: "neuter", occurredAt: A_DAY })).toBe(
      "STERILIZATION_PROCEDURE_INVALID",
    );
  });

  it("refuses the VET-ONLY clinical sub_kind, which is why the enum has five", () => {
    // `disease_diagnosis` is a real `clinical_info_logged` sub_kind whose writer
    // authorizes on a verified matrícula and checks no ownership at all. If this
    // schema accepted it, an owner's bearer token could sign a professional's
    // claim — the one exclusion in this file that is a SECURITY boundary rather
    // than a copy of a form's options.
    expect(
      codeFor({
        kind: "clinical_info",
        subKind: "disease_diagnosis",
        title: "Moquillo",
        occurredAt: A_DAY,
      }),
    ).toBe("CLINICAL_SUB_KIND_INVALID");
  });

  it("holds all four to the same calendar as the six before them", () => {
    for (const body of [
      { kind: "microchip", chipNumber: "982000123456789" },
      { kind: "sterilization", procedure: "castration" },
      { kind: "vet_visit", reason: "Control" },
      { kind: "clinical_info", subKind: "imaging", title: "Radiografía" },
    ]) {
      expect(codeFor({ ...body, occurredAt: "2026-02-31" })).toBe("OCCURRED_AT_INVALID");
      expect(codeFor({ ...body, occurredAt: "" })).toBe("OCCURRED_AT_REQUIRED");
    }
  });

  it("normalizes every unstated optional to null on the four as well", () => {
    expect(
      recordEventInputSchema.parse({
        kind: "microchip",
        chipNumber: "  982000123456789  ",
        occurredAt: A_DAY,
        implantedBy: "   ",
      }),
    ).toEqual({
      kind: "microchip",
      chipNumber: "982000123456789",
      occurredAt: A_DAY,
      countryCode: null,
      implantedBy: null,
      locationOnBody: null,
      notes: null,
    });
  });

  it("carries NO same-day override on the four — the web has no such gate for them", () => {
    const parsed = recordEventInputSchema.parse({
      kind: "sterilization",
      procedure: "spay",
      occurredAt: A_DAY,
    });
    expect(parsed).not.toHaveProperty("sameDayOverride");
  });
});

// ---------------------------------------------------------------------------
// WU-M — síntoma, the eleventh kind and the only one with no `occurredAt`.
// ---------------------------------------------------------------------------

describe("recordEventInputSchema — síntoma", () => {
  it("accepts the free text ALONE — no date, no severity", () => {
    // The web's own shape: `createSymptomObservedAction` requires `freeText` and
    // nothing else. A schema that demanded a day here would refuse a report the
    // browser takes happily.
    expect(recordEventInputSchema.parse({ kind: "symptom", freeText: "Decaído, no come" })).toEqual(
      { kind: "symptom", freeText: "Decaído, no come", severity: undefined, onsetAt: null },
    );
  });

  it("refuses an empty description — the one field it cannot do without", () => {
    expect(codeFor({ kind: "symptom", freeText: "   " })).toBe("SYMPTOM_TEXT_REQUIRED");
    expect(codeFor({ kind: "symptom" })).toBe("SYMPTOM_TEXT_REQUIRED");
  });

  it("carries NO occurredAt, which is what separates it from the other ten", () => {
    const parsed = recordEventInputSchema.parse({ kind: "symptom", freeText: "Tos seca" });
    expect(parsed).not.toHaveProperty("occurredAt");
  });

  it("takes the three severities and REFUSES a fourth, where the web drops it silently", () => {
    for (const severity of ["mild", "moderate", "severe"]) {
      expect(codeFor({ kind: "symptom", freeText: "Tos", severity })).toBe(null);
    }
    // The web's `<select>` cannot produce this; a JSON client can, and a symptom
    // filed with no severity because the app sent Spanish is a typo that reaches
    // the ledger. Same call `note.category` makes.
    expect(codeFor({ kind: "symptom", freeText: "Tos", severity: "moderado" })).toBe(
      "SYMPTOM_SEVERITY_INVALID",
    );
    expect(codeFor({ kind: "symptom", freeText: "Tos", severity: null })).toBe(null);
  });

  it("normalizes a blank onset to null rather than refusing it", () => {
    // The web reads `String(formData.get("onsetAt") ?? "").trim() || null`, so an
    // untouched date input reaches the writer as null. A schema that ran the
    // regex over "" would answer 400 to a request the web accepts.
    for (const onsetAt of ["", "   ", null, undefined]) {
      expect(recordEventInputSchema.parse({ kind: "symptom", freeText: "Tos", onsetAt })).toEqual({
        kind: "symptom",
        freeText: "Tos",
        severity: undefined,
        onsetAt: null,
      });
    }
  });

  it("holds a STATED onset to the same calendar as every other date here", () => {
    expect(codeFor({ kind: "symptom", freeText: "Tos", onsetAt: "2026-02-31" })).toBe(
      "ONSET_AT_INVALID",
    );
    expect(codeFor({ kind: "symptom", freeText: "Tos", onsetAt: "20/08/2026" })).toBe(
      "ONSET_AT_MALFORMED",
    );
    expect(codeFor({ kind: "symptom", freeText: "Tos", onsetAt: A_DAY })).toBe(null);
  });

  it("caps NOTHING on the description, because the web caps nothing", () => {
    // The matcher reads this text. A truncation invented here would be a symptom
    // the browser surfaces to the sanitary authority and the app silently drops.
    const long = "vómitos ".repeat(500);
    expect(codeFor({ kind: "symptom", freeText: long })).toBe(null);
  });
});

// Two builders, so every case below reads as the ONE thing it varies. Written
// out per-case they wrapped past the line limit and the assertion disappeared
// into the body.
const replace = (over: Record<string, unknown> = {}) => ({
  kind: "microchip_replace",
  reason: "damaged",
  newChipNumber: "982000999999999",
  occurredAt: A_DAY,
  ...over,
});

const attest = (over: Record<string, unknown> = {}) => ({
  kind: "dangerous_breed_attestation",
  registry: "caba_4078",
  occurredAt: A_DAY,
  ...over,
});

describe("recordEventInputSchema — reemplazo de microchip", () => {
  // NOT A SECOND `microchip`. The implant kind appends a fact about a chip going
  // in; this one RETIRES the canonical chip. Both live in one union and a caller
  // that confused them would write the wrong act into a legal record, so the
  // fields are deliberately not shared: `chipNumber` belongs to the implant and
  // `newChipNumber` to the replacement.
  it("accepts the five owner motives", () => {
    for (const reason of ["damaged", "unreadable", "owner_request", "device_failure", "other"]) {
      expect(codeFor(replace({ reason }))).toBe(null);
    }
  });

  it("refuses the two that are a professional's finding", () => {
    // The web's owner action refuses these at the door for the same reason: they
    // open a `microchip_remediation` case, and a bearer token must not be able to
    // file a finding only a vet or an admin makes.
    expect(codeFor(replace({ reason: "duplicate_detected" }))).toBe(
      "MICROCHIP_REPLACE_REASON_INVALID",
    );
    expect(codeFor(replace({ reason: "fraud_detected" }))).toBe("MICROCHIP_REPLACE_REASON_INVALID");
  });

  it("lets a REVOCATION leave the animal with no chip, under the two motives that mean it", () => {
    // Chipless is a real outcome, not an incomplete form — which is why this is
    // the kind's one cross-field rule, and why it is asserted in both directions
    // rather than only as a refusal.
    for (const reason of ["owner_request", "device_failure"]) {
      expect(codeFor(replace({ reason, newChipNumber: null }))).toBe(null);
      // Blank says the same thing as null: an untouched field.
      expect(codeFor(replace({ reason, newChipNumber: "   " }))).toBe(null);
    }
  });

  it("refuses a missing new chip under the three motives that are a REPLACEMENT", () => {
    for (const reason of ["damaged", "unreadable", "other"]) {
      expect(codeFor(replace({ reason, newChipNumber: null }))).toBe(
        "MICROCHIP_REPLACE_NEW_CHIP_REQUIRED",
      );
    }
  });

  it("holds the replacement to the same calendar as every other dated kind", () => {
    expect(codeFor(replace({ occurredAt: "20/08/2026" }))).toBe("OCCURRED_AT_MALFORMED");
    expect(codeFor(replace({ occurredAt: "2026-02-30" }))).toBe("OCCURRED_AT_INVALID");
  });

  it("DROPS a previousChipNumber a client sends, because the server reads it", () => {
    // THE FIELD IS FED ON PURPOSE. Asserting its absence from a body that never
    // carried one is vacuous: it passes against a schema that would have kept
    // the field, and against one that never had a rule at all. What has to hold
    // is that a client asserting the previous chip cannot get that assertion
    // past the wire — there is nothing to adjudicate between the two answers,
    // the canonical row is the answer.
    const parsed = recordEventInputSchema.parse(replace({ previousChipNumber: "982000111111111" }));
    expect("previousChipNumber" in parsed).toBe(false);
  });
});

describe("recordEventInputSchema — atestación de raza peligrosa", () => {
  it("requires a registry and nothing else beyond the day", () => {
    expect(codeFor(attest())).toBe(null);
    expect(codeFor(attest({ registry: "  " }))).toBe("PPP_REGISTRY_REQUIRED");
  });

  it("does NOT constrain WHICH registry — that is the jurisdiction's answer", () => {
    // The options come from `ppp_attestation_required_registries` resolved for
    // the animal's own province and locality, so they are ADMIN-EDITABLE. An
    // enum here would be a fixed list this package must be republished to
    // change, and it would refuse a registry an admin legitimately added. The
    // SERVER checks membership (`validateAttestationRegistry`); this only
    // refuses an empty one.
    expect(codeFor(attest({ registry: "un-registro-que-nadie-cargo" }))).toBe(null);
  });

  it("holds the attestation to the same calendar", () => {
    expect(codeFor(attest({ occurredAt: "2026-02-30" }))).toBe("OCCURRED_AT_INVALID");
  });
});

const death = (over: Record<string, unknown> = {}) => ({
  kind: "death",
  cause: "natural",
  occurredAt: A_DAY,
  ...over,
});

describe("recordEventInputSchema — fallecimiento", () => {
  it("pide una causa, y no inventa una por defecto", () => {
    // "No la sé" es una respuesta que la persona da. Un default la daría por
    // ella, en el asiento que cierra el registro de un animal.
    expect(codeFor(death())).toBe(null);
    expect(codeFor(death({ cause: undefined }))).toBe("DEATH_CAUSE_INVALID");
    expect(codeFor(death({ cause: "asesinato" }))).toBe("DEATH_CAUSE_INVALID");
  });

  it("acepta las nueve causas que la web le ofrece al dueño", () => {
    // NO es un subconjunto, a diferencia de los motivos de reemplazo de chip:
    // no hay nada acá que un dueño no pueda decir sobre su propio animal.
    for (const cause of DEATH_CAUSES) {
      const extra = cause === "disease" ? { diseaseCode: "rabies_confirmed" } : {};
      expect(codeFor(death({ cause, ...extra }))).toBe(null);
    }
  });

  it("exige la enfermedad cuando la causa ES una enfermedad, y la exige del catálogo", () => {
    expect(codeFor(death({ cause: "disease" }))).toBe("DEATH_DISEASE_CODE_REQUIRED");
    expect(codeFor(death({ cause: "disease", diseaseCode: "  " }))).toBe(
      "DEATH_DISEASE_CODE_REQUIRED",
    );
    expect(codeFor(death({ cause: "disease", diseaseCode: "gripe_de_pinguino" }))).toBe(
      "DEATH_DISEASE_CODE_UNKNOWN",
    );
    expect(codeFor(death({ cause: "disease", diseaseCode: "rabies_confirmed" }))).toBe(null);
  });

  it("no pide enfermedad cuando la causa no es una enfermedad", () => {
    // NO-VACUIDAD de la regla anterior: si pidiera siempre, el caso de arriba
    // pasaría igual y no probaría nada sobre la condición.
    expect(codeFor(death({ cause: "accident" }))).toBe(null);
  });

  it("ata el nombre de la clínica a haber fallecido en una", () => {
    expect(codeFor(death({ clinicName: "Vet Central" }))).toBe("DEATH_CLINIC_REQUIRES_AT_CLINIC");
    expect(codeFor(death({ clinicName: "Vet Central", deathAtClinic: true }))).toBe(null);
  });

  it("ata la pregunta del contacto a haber fallecido en una veterinaria", () => {
    expect(codeFor(death({ vetContactedOwner: "no" }))).toBe(
      "DEATH_VET_CONTACT_REQUIRES_AT_CLINIC",
    );
    expect(codeFor(death({ vetContactedOwner: "no", deathAtClinic: true }))).toBe(null);
  });

  it("sólo admite 'decidió sin consultarte' cuando NO logró contactar", () => {
    // El campo del que dependería una disputa profesional. Bajo "sí" o "no
    // aplica" la afirmación es una contradicción, y este asiento es el que
    // alguien podría llevar a un colegio.
    const atClinic = { deathAtClinic: true, vetDecidedAlone: true };
    expect(codeFor(death({ ...atClinic, vetContactedOwner: "yes" }))).toBe(
      "DEATH_VET_DECIDED_REQUIRES_NO_CONTACT",
    );
    expect(codeFor(death({ ...atClinic, vetContactedOwner: "not_applicable" }))).toBe(
      "DEATH_VET_DECIDED_REQUIRES_NO_CONTACT",
    );
    expect(codeFor(death({ ...atClinic, vetContactedOwner: "no" }))).toBe(null);
  });

  it("deja el destino del cuerpo en null, porque 'no sé' es una respuesta real", () => {
    expect(codeFor(death({ dispositionMethod: null }))).toBe(null);
    expect(codeFor(death({ dispositionMethod: "owner_burial" }))).toBe(null);
    expect(codeFor(death({ dispositionMethod: "al_rio" }))).toBe("DEATH_DISPOSITION_INVALID");
  });

  it("sostiene el mismo calendario que todo otro asiento con fecha", () => {
    expect(codeFor(death({ occurredAt: "20/08/2026" }))).toBe("OCCURRED_AT_MALFORMED");
    expect(codeFor(death({ occurredAt: "2026-02-30" }))).toBe("OCCURRED_AT_INVALID");
  });
});

describe("recordEventInputSchema — seguimiento post-adopción", () => {
  it("accepts the kind ALONE — no date, no organization, nothing but an optional text", () => {
    // The smallest body on the endpoint, and deliberately so: the refugio it
    // is addressed to, the window it answers and the moment it happened are all
    // the server's to decide off the animal's own record.
    expect(codeFor({ kind: "post_adoption_checkin" })).toBe(null);
    expect(
      codeFor({ kind: "post_adoption_checkin", notes: "Come bien y duerme en su cama." }),
    ).toBe(null);
  });

  it("normalizes a blank text to null, exactly as the web action reads it", () => {
    const parsed = recordEventInputSchema.safeParse({ kind: "post_adoption_checkin", notes: "  " });
    if (!parsed.success) throw new Error("expected the body to parse");
    expect(parsed.data).toEqual({ kind: "post_adoption_checkin", notes: null });
  });

  it("carries NO occurredAt: the writer stamps the moment of reporting", () => {
    // A `"how things are"` and not a `"what happened on a day"`. The wire has
    // no field for a day, so a client cannot backdate a check-in the refugio
    // is reading as current.
    const parsed = recordEventInputSchema.safeParse({
      kind: "post_adoption_checkin",
      occurredAt: A_DAY,
    });
    if (!parsed.success) throw new Error("expected the body to parse");
    expect("occurredAt" in parsed.data).toBe(false);
  });
});

describe("recordEventInputSchema — tatuaje", () => {
  /** The shape a ticket mints: `{petId}/{uuid}.{ext}`. */
  const A_STAGED_PATH =
    "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg";

  const aTattoo = {
    kind: "tattoo",
    tattooCode: "ABC-1234",
    stagedPath: A_STAGED_PATH,
  };

  it("accepts the code and the staged photo alone", () => {
    expect(codeFor(aTattoo)).toBe(null);
  });

  it("REFUSES a tattoo with no photo — the one kind on this endpoint that does", () => {
    // PARITY AND NOT STRICTNESS. `createTattooAction` refuses the same
    // submission in its own words before it calls the writer, and the writer
    // stores the attachment's id as `pet_identifications.photo_id`. Accepting
    // one without would let a phone RETIRE a photographed tattoo — the writer
    // supersedes the active row — on the identification a credential reads.
    const { stagedPath: _dropped, ...noPhoto } = aTattoo;
    expect(codeFor(noPhoto)).toBe("TATTOO_PHOTO_REQUIRED");
    expect(codeFor({ ...aTattoo, stagedPath: "" })).toBe("TATTOO_PHOTO_REQUIRED");
  });

  it("refuses a staged path that is not the shape a ticket mints", () => {
    // NOT the check that matters — the server re-derives the pet-id prefix from
    // the pet whose access check just passed. This is the one that makes an
    // obviously-malformed value a 400 instead of a Storage round trip.
    expect(codeFor({ ...aTattoo, stagedPath: "../../etc/passwd" })).toBe("TATTOO_PHOTO_REQUIRED");
    expect(
      codeFor({
        ...aTattoo,
        stagedPath: "11111111-1111-4111-8111-111111111111/../x.jpg",
      }),
    ).toBe("TATTOO_PHOTO_REQUIRED");
    expect(codeFor({ ...aTattoo, stagedPath: `${A_STAGED_PATH}/deeper.jpg` })).toBe(
      "TATTOO_PHOTO_REQUIRED",
    );
  });

  it("refuses an empty code", () => {
    expect(codeFor({ ...aTattoo, tattooCode: "   " })).toBe("TATTOO_CODE_REQUIRED");
  });

  it("REFUSES an unknown place, where the web silently drops it", () => {
    // STRICTER THAN THE WEB, DELIBERATELY. `createTattooAction` coerces an
    // unrecognised `locationOnBody` to null because it reads a `<select>` whose
    // options it drew itself. A JSON client is not a `<select>`, and quietly
    // dropping a place somebody named would put "no dijeron dónde" on a
    // permanent identification record.
    expect(codeFor({ ...aTattoo, locationOnBody: "left_paw" })).toBe("TATTOO_LOCATION_INVALID");
    expect(codeFor({ ...aTattoo, locationOnBody: "inner_ear_left" })).toBe(null);
  });

  it("accepts NO place at all — 'no lo dijeron' is a real answer", () => {
    const parsed = recordEventInputSchema.safeParse(aTattoo);
    if (!parsed.success) throw new Error("expected the body to parse");
    expect(parsed.data).toMatchObject({ locationOnBody: null });
  });

  it("takes the day as OPTIONAL, and a blank one means 'no sé cuándo'", () => {
    // The web's field is optional too, and the writer records the absence as a
    // fact (`tattoo_date_known: false`) rather than stamping today. A tattoo
    // read off an adopted animal has no known date.
    const blank = recordEventInputSchema.safeParse({ ...aTattoo, occurredAt: "  " });
    if (!blank.success) throw new Error("expected the body to parse");
    expect(blank.data).toMatchObject({ occurredAt: null });

    const dated = recordEventInputSchema.safeParse({ ...aTattoo, occurredAt: A_DAY });
    if (!dated.success) throw new Error("expected the body to parse");
    expect(dated.data).toMatchObject({ occurredAt: A_DAY });
  });

  it("holds a stated day to the SAME calendar as every other kind", () => {
    // 31 February passes a `YYYY-MM-DD` regex and `new Date` rolls it to 3
    // March. Optional does not mean unchecked.
    expect(codeFor({ ...aTattoo, occurredAt: "2026-02-31" })).toBe("OCCURRED_AT_INVALID");
    expect(codeFor({ ...aTattoo, occurredAt: "20/08/2026" })).toBe("OCCURRED_AT_MALFORMED");
  });

  it("normalizes its two free-text fields to null when blank", () => {
    const parsed = recordEventInputSchema.safeParse({
      ...aTattoo,
      description: "  ",
      recordedBy: "",
    });
    if (!parsed.success) throw new Error("expected the body to parse");
    expect(parsed.data).toMatchObject({ description: null, recordedBy: null });
  });
});
