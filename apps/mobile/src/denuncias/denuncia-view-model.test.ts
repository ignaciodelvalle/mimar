// The denuncia's pure half: the words, and the shape of the two asks.
//
// RUNS UNDER JEST, not Vitest, and that is not a detail. `apps` is in
// `__tests__/db-reachability.ts`'s SKIP_DIRS, so nothing in this directory is
// ever collected by `pnpm test:verified` — the mobile suite is its own runner,
// reached through `pnpm verify:mobile`. A test written here in Vitest's dialect
// would simply never run, and would look like coverage.
//
// WHAT IS WORTH TESTING IN A FILE OF STRINGS
// ---------------------------------------------------------------------------
// Not the strings. What is worth testing is the two things a `switch` over a
// closed vocabulary can still get wrong at runtime even when it compiles:
//
//   • a label that is the enum value handed back (the `default: return kind`
//     defect the server's own label table shipped), and
//   • a builder that quietly drops or invents a field.
//
// The exhaustiveness itself is the compiler's job and is left to it.

import { describe, expect, it } from "@jest/globals";

import {
  WELFARE_REPORT_CITIZEN_SEVERITIES,
  WELFARE_REPORT_INPUT_CODES,
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SUBJECT_KINDS,
} from "@dim/contract/input";

import {
  DENUNCIA_ANONYMOUS_CAVEAT,
  DENUNCIA_FIELD_ORDER,
  DENUNCIA_NO_ATTACHMENTS_CAVEAT,
  type DenunciaFormValues,
  buildFileDenunciaCommand,
  buildResolveLocationCommand,
  denunciaInputMessage,
  denunciaKindLabel,
  denunciaMissingMessage,
  denunciaSeverityHint,
  denunciaSeverityLabel,
  denunciaSubjectLabel,
  denunciaSubjectPlaceholder,
  missingDenunciaFields,
} from "./denuncia-view-model";

const PLACE = {
  label: "Avenida Bustillo 1200, San Carlos de Bariloche, Río Negro, Argentina",
  lat: -41.135,
  lng: -71.3103,
  province: "Río Negro",
  locality: "San Carlos de Bariloche",
};

const FILLED: DenunciaFormValues = {
  kind: "physical_abuse",
  severity: "critical",
  description: "Vi al perro atado al sol sin agua y con golpes visibles en el lomo.",
  subjectKind: "unowned_animal",
  subjectDescription: "Perro mestizo marrón, atado en el fondo de una casa.",
  place: PLACE,
  anonymous: true,
  contactEmail: "",
  contactPhone: "",
};

describe("every vocabulary has words, and none of them is the enum value", () => {
  it("labels the nine kinds", () => {
    // THE MUTATION: change `case "trafficking":` to return the bare key
    // (`return kind` is not even reachable — the switch has no default — so the
    // realistic version is returning the string "trafficking"). Applied: fails.
    for (const kind of WELFARE_REPORT_KINDS) {
      const label = denunciaKindLabel(kind);
      expect(label).not.toBe(kind);
      expect(label.length).toBeGreaterThan(3);
    }
    // NON-VACUITY: nine distinct labels, not one string nine times.
    expect(new Set(WELFARE_REPORT_KINDS.map(denunciaKindLabel)).size).toBe(
      WELFARE_REPORT_KINDS.length,
    );
  });

  it("labels the three severities in the words the reporter will be quoted back", () => {
    // Blind QA 2026-08-19 (O2): the wizard said "Grave / urgente" and the
    // follow-up said "Crítica — peligro inmediato". These three strings are the
    // citizen half of `WELFARE_SEVERITY_CITIZEN_LABEL`, and the operator words
    // must not leak in.
    //
    // THE MUTATION: return "Crítica — peligro inmediato" for `critical`.
    // Applied: fails.
    expect(WELFARE_REPORT_CITIZEN_SEVERITIES.map(denunciaSeverityLabel)).toEqual([
      "Sospecha",
      "Moderado",
      "Grave / urgente",
    ]);
    for (const severity of WELFARE_REPORT_CITIZEN_SEVERITIES) {
      expect(denunciaSeverityLabel(severity)).not.toContain("Crítica");
      expect(denunciaSeverityHint(severity).length).toBeGreaterThan(10);
    }
  });

  it("labels the three subjects and gives each its own placeholder", () => {
    for (const kind of WELFARE_REPORT_SUBJECT_KINDS) {
      expect(denunciaSubjectLabel(kind)).not.toBe(kind);
      expect(denunciaSubjectPlaceholder(kind)).not.toBe(kind);
    }
    expect(new Set(WELFARE_REPORT_SUBJECT_KINDS.map(denunciaSubjectPlaceholder)).size).toBe(3);
  });

  it("gives every input code a sentence, and the unknown one too", () => {
    // A code with no message renders as a blank under an error heading, which is
    // the failure `error-copy.ts` was lifted into one file to prevent.
    for (const code of WELFARE_REPORT_INPUT_CODES) {
      expect(denunciaInputMessage(code).length).toBeGreaterThan(10);
    }
    expect(denunciaInputMessage(null).length).toBeGreaterThan(10);
  });
});

describe("the two builders", () => {
  it("trims the address before asking the server to resolve it", () => {
    const draft = buildResolveLocationCommand("  Av. Bustillo 1200  ");
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input).toEqual({
      command: "resolve_location",
      addressText: "Av. Bustillo 1200",
    });
  });

  it("refuses an address too short to search, with the code the screen renders", () => {
    const draft = buildResolveLocationCommand("a");
    expect(draft).toEqual({ ok: false, code: "ADDRESS_REQUIRED" });
  });

  it("sends NO contact fields on an anonymous denuncia", () => {
    // THE CLIENT HALF of the property the contract makes structural. Filling the
    // contact fields AND choosing anonymous must produce a body with neither.
    //
    // THE MUTATION: in `buildFileDenunciaCommand`, always take the
    // `with_contact` branch. Applied: fails — both keys appear.
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      anonymous: true,
      contactEmail: "vecina@example.com",
      contactPhone: "+54 294 4123456",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(draft.input).not.toHaveProperty("reporterContactEmail");
    expect(draft.input).not.toHaveProperty("reporterContactPhone");
    expect(JSON.stringify(draft.input)).not.toContain("vecina@example.com");
    expect(JSON.stringify(draft.input)).not.toContain("4123456");
  });

  it("sends the contact when the person chose to leave one", () => {
    // The other direction — without it, a builder hardcoded to `anonymous`
    // would pass every assertion above.
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      anonymous: false,
      contactEmail: "vecina@example.com",
      contactPhone: "+54 294 4123456",
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input).toMatchObject({
      contactMode: "with_contact",
      reporterContactEmail: "vecina@example.com",
    });
  });

  // -------------------------------------------------------------------------
  // A5-ciudadanas-01 — "CON MI CONTACTO" WITH A PHONE AND NOTHING ELSE
  // -------------------------------------------------------------------------
  it("sends a phone-only contact instead of an empty e-mail key", () => {
    // The whole path was unsendable: `""` reached `z.email()`, which runs
    // before the schema's nullable/optional AND before its at-least-one rule,
    // so the form answered "dejanos un contacto" to somebody who had just left
    // one.
    //
    // WHAT `input` IS, because the old comment here claimed something this
    // assertion could not check (lote 1b review, F13). The builder OMITS the key
    // from the wire body, but `input` is the PARSED result — and the contract's
    // `.optional().transform()` turns the absent key into an explicit `null`. So
    // "the key is omitted" is a fact about `buildFileDenunciaCommand`'s input to
    // zod and is invisible here; what IS observable, and what actually matters
    // downstream, is that the address field carries NO ADDRESS rather than a
    // blank string. `toMatchObject` cannot assert an absence, so it asserts the
    // value instead of implying a shape.
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      anonymous: false,
      contactEmail: "   ",
      contactPhone: "+54 294 4123456",
    });

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input).toMatchObject({
      contactMode: "with_contact",
      reporterContactEmail: null,
      reporterContactPhone: "+54 294 4123456",
    });
    // And not the empty string, which is the value that used to make the parse
    // fail. `toMatchObject` above would accept `""` as "present"; this does not.
    expect((draft.input as { reporterContactEmail?: unknown }).reporterContactEmail).not.toBe("");
  });

  it("still refuses when BOTH contact boxes are blank", () => {
    // The control: omitting the keys must not turn the at-least-one rule off.
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      anonymous: false,
      contactEmail: "",
      contactPhone: "",
    });

    expect(draft).toEqual({ ok: false, code: "CONTACT_REQUIRED" });
  });

  it("refuses to build a denuncia with no place chosen, and says which list to tap", () => {
    // A phone cannot produce a point on its own; the only way through is tapping
    // a candidate. The message has to say that rather than "faltan coordenadas".
    const draft = buildFileDenunciaCommand({ ...FILLED, place: null });
    expect(draft).toEqual({ ok: false, code: "COORDS_REQUIRED" });
    expect(denunciaInputMessage("COORDS_REQUIRED")).toContain("de la lista");
  });

  it("carries the chosen candidate's own values, jurisdiction pair included", () => {
    // The pair is the walkthrough 2026-08-31 §2 fix: dropping it here is what
    // made every mobile denuncia land "jurisdicción sin verificar" while the
    // server had geocoded province and locality moments earlier.
    const draft = buildFileDenunciaCommand(FILLED);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input).toMatchObject({
      locationLat: PLACE.lat,
      locationLng: PLACE.lng,
      locationAddress: PLACE.label,
      locationProvince: PLACE.province,
      locationLocality: PLACE.locality,
    });
  });

  it("sends NO jurisdiction pair when the candidate carried none", () => {
    // A nominatim candidate can come back with null province/locality (the
    // contract says a client must not treat either as present) — the draft then
    // carries nulls and the server's inference path earns the unverified mark.
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      place: { ...PLACE, province: null, locality: null },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input).toMatchObject({ locationProvince: null, locationLocality: null });
  });

  it("refuses a description under the floor, with the sentence that explains the rule", () => {
    const draft = buildFileDenunciaCommand({ ...FILLED, description: "no le dan agua" });
    expect(draft).toEqual({ ok: false, code: "DESCRIPTION_TOO_SHORT" });
    // The web's own action says "al menos 20 caracteres para poder ser
    // actuable"; the second half is the part that explains rather than states.
    expect(denunciaInputMessage("DESCRIPTION_TOO_SHORT")).toContain("20");
  });

  it("refuses a with_contact submission that leaves no channel at all", () => {
    const draft = buildFileDenunciaCommand({
      ...FILLED,
      anonymous: false,
      contactEmail: "",
      contactPhone: "",
    });
    expect(draft).toEqual({ ok: false, code: "CONTACT_REQUIRED" });
  });
});

describe("the two caveats say the true thing", () => {
  it("does not promise that evidence can be added later, because it cannot", () => {
    // THE DEFECT THIS CAUGHT ON THE WAY IN. The first draft of this string read
    // "sumalas desde la web con el código que te damos al final" — a promise the
    // product cannot keep: no surface accepts evidence for an existing
    // denuncia. The copy has to send somebody to the browser BEFORE they fill
    // anything in.
    //
    // The count in this comment was WRONG and is corrected rather than dropped:
    // `uploadWelfareEvidence` has THREE call sites, not two. The two denuncia
    // ones are the CREATE actions; the third, `submit-claim-dispute.ts`, is a
    // custody dispute and is also a creation path. The conclusion survives, the
    // arithmetic did not. See `denuncia-view-model.ts` for the full note.
    expect(DENUNCIA_NO_ATTACHMENTS_CAVEAT).toContain("no se pueden sumar después");
    expect(DENUNCIA_NO_ATTACHMENTS_CAVEAT).toContain("desde el navegador");
    expect(DENUNCIA_NO_ATTACHMENTS_CAVEAT).not.toContain("al final");
  });

  it("does not claim the request itself is anonymous, only the record", () => {
    // Every `/api/v1` door authenticates before it reads a body. What this
    // transport can offer is that nothing is WRITTEN DOWN; the stronger property
    // lives in a browser with no session, and a person who needs it deserves to
    // be told where it is rather than reassured.
    expect(DENUNCIA_ANONYMOUS_CAVEAT).toContain("iniciaste sesión");
    expect(DENUNCIA_ANONYMOUS_CAVEAT).toContain("navegador");
  });
});

describe("an empty form is answered in FIELD ORDER, not in schema order (B-07)", () => {
  const EMPTY: DenunciaFormValues = {
    kind: null,
    severity: null,
    description: "",
    subjectKind: null,
    subjectDescription: "",
    place: null,
    anonymous: true,
    contactEmail: "",
    contactPhone: "",
  };

  it("names the place FIRST, because it is the first heading on the screen", () => {
    // MEASURED on build 10 (shots 133-134): the empty form answered "Elegí qué
    // tipo de situación estás denunciando." while "¿DÓNDE ESTÁ PASANDO? *" sat
    // above it, just as empty. The old order was zod's, i.e. the schema object's
    // key order, which knows nothing about the phone.
    const missing = missingDenunciaFields(EMPTY);
    expect(missing[0]).toBe("ADDRESS_REQUIRED");
    // And the parse on its own still points somewhere else, which is the whole
    // reason this function exists rather than a re-ordering of the contract.
    const draft = buildFileDenunciaCommand(EMPTY);
    expect(draft.ok).toBe(false);
    expect(draft.ok === false && draft.code).not.toBe("COORDS_REQUIRED");
  });

  it("tells the two place failures apart, which is what ADDRESS_REQUIRED is for (L3)", () => {
    // `DENUNCIA_FIELD_ORDER` listed `ADDRESS_REQUIRED` and NOTHING could produce
    // it: the list was built by hand-written push order and only ever pushed
    // `COORDS_REQUIRED`, so a person who had typed nothing at all was told to
    // "elegí el lugar de la lista" — a list that does not exist until they type
    // something and search.
    expect(missingDenunciaFields(EMPTY, "")).toContain("ADDRESS_REQUIRED");
    expect(missingDenunciaFields(EMPTY, "")).not.toContain("COORDS_REQUIRED");

    // Typed, searched, never TAPPED a candidate. Same heading, different advice.
    expect(missingDenunciaFields(EMPTY, "Av. Bustillo 1200")).toContain("COORDS_REQUIRED");
    expect(missingDenunciaFields(EMPTY, "Av. Bustillo 1200")).not.toContain("ADDRESS_REQUIRED");

    // And whitespace is not typing.
    expect(missingDenunciaFields(EMPTY, "   ")).toContain("ADDRESS_REQUIRED");
  });

  it("derives the list from DENUNCIA_FIELD_ORDER rather than from a second hand-written order", () => {
    // The mechanism half of L3. Two orders that agree by transcription drift the
    // day somebody inserts a field into one of them.
    const missing = missingDenunciaFields(EMPTY);
    const positions = missing.map((code) => DENUNCIA_FIELD_ORDER.indexOf(code));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Every code it produced is in the array — a `push` of something absent from
    // it would not typecheck, and this says so at runtime too.
    expect(positions.every((at) => at >= 0)).toBe(true);
  });

  it("leads with the first field's OWN sentence and lists the rest as headings (L4)", () => {
    const message = denunciaMissingMessage(missingDenunciaFields(EMPTY));
    expect(message).toBe(
      "Escribí la dirección o el lugar para poder buscarlo. Faltan además: ¿Qué está pasando?, ¿Qué tan grave es?, ¿Sobre qué es la denuncia?, ¿Qué o a quién estás denunciando? y Contanos qué pasó.",
    );
  });

  it("does not tell somebody looking at a filled address that the address is missing (L4)", () => {
    // THE DEFECT: `COORDS_REQUIRED` flattened to its heading, "¿Dónde está
    // pasando?", so the summary named a field the person had just filled in. The
    // heading says WHERE; only the code's own sentence says what is actually
    // wrong with it.
    const typed = missingDenunciaFields(EMPTY, "Av. Bustillo 1200");
    const message = denunciaMissingMessage(typed);
    expect(message).toContain("Elegí el lugar de la lista");
    expect(message).not.toContain("¿Dónde está pasando?");
  });

  it("says 'Falta además' for exactly one leftover", () => {
    // "Faltan además: Contanos qué pasó." about one field is a sentence nobody
    // would write by hand.
    const twoMissing: DenunciaFormValues = { ...FILLED, severity: null, description: "" };
    expect(denunciaMissingMessage(missingDenunciaFields(twoMissing, "x"))).toBe(
      "Elegí qué tan grave es la situación. Falta además: Contanos qué pasó.",
    );
  });

  it("keeps the single field's own sentence when only one is missing", () => {
    // A list of one is worse than the sentence it replaces: the per-code copy
    // says what to DO, and the heading only says where.
    const oneMissing: DenunciaFormValues = { ...FILLED, severity: null };
    expect(denunciaMissingMessage(missingDenunciaFields(oneMissing))).toBe(
      "Elegí qué tan grave es la situación.",
    );
  });

  it("says nothing at all about a form that is filled in", () => {
    expect(missingDenunciaFields(FILLED)).toEqual([]);
    expect(denunciaMissingMessage(missingDenunciaFields(FILLED))).toBeNull();
  });

  it("does not call a too-SHORT description missing — that is the contract's call", () => {
    // "Blank" and "wrong" are different questions. A twelve-character
    // description is present; `DESCRIPTION_TOO_SHORT` carries the number and the
    // reason, and this pre-check may not shadow it with "faltan campos".
    const short: DenunciaFormValues = { ...FILLED, description: "muy corto" };
    expect(missingDenunciaFields(short)).toEqual([]);
    const draft = buildFileDenunciaCommand(short);
    expect(draft.ok === false && draft.code).toBe("DESCRIPTION_TOO_SHORT");
  });

  it("asks for a contact only when the person chose to leave one", () => {
    const anonymous: DenunciaFormValues = { ...FILLED, anonymous: true };
    expect(missingDenunciaFields(anonymous)).toEqual([]);
    const named: DenunciaFormValues = { ...FILLED, anonymous: false };
    expect(missingDenunciaFields(named)).toEqual(["CONTACT_REQUIRED"]);
    const withPhone: DenunciaFormValues = { ...named, contactPhone: "1155550000" };
    expect(missingDenunciaFields(withPhone)).toEqual([]);
  });
});
