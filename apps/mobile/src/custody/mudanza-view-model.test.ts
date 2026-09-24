// `mudanza-view-model` — the pure half of MUDANZA.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE VALIDATION IS THE CONTRACT'S, run locally so a person gets a field
//      sentence instead of a round trip that answers `invalid_request` with no
//      field detail. The blank-province case is the load-bearing one: a blank
//      province makes the SERVER's strict canonicalization skip the catalog
//      entirely, so it must never leave this screen.
//   2. "THE SECTION FAILED TO LOAD" AND "THIS ANIMAL HAS NO LOCALITY" ARE
//      DIFFERENT FACTS, and the second sentence would invite a move nobody
//      needs. That is the whole reason `CurrentJurisdiction` is a union and not
//      a nullable string.
//   3. THE ACK'S SENTENCE NAMES THE CANONICAL PAIR, never the typed one.

import { describe, expect, it } from "@jest/globals";

import type { OwnerPetDetailV1 } from "@dim/contract/api";

import {
  buildMove,
  currentJurisdiction,
  moveRecordedMessage,
  petNameFrom,
} from "./mudanza-view-model";

function detail(identity: OwnerPetDetailV1["identity"]): OwnerPetDetailV1 {
  return { identity } as unknown as OwnerPetDetailV1;
}

function okIdentity(over: Record<string, unknown> = {}): OwnerPetDetailV1["identity"] {
  return {
    status: "ok",
    data: {
      name: "Pampa",
      species: "dog",
      sex: "female",
      breed: null,
      breedLine: "Mestiza · Hembra",
      photoUrl: null,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      tags: [],
      ...over,
    },
  } as unknown as OwnerPetDetailV1["identity"];
}

/** A picked destination, as the picker writes it. Overridden per case. */
const PICKED = {
  provinceCode: "AR-R",
  localityName: "Bariloche",
  localityIndecId: "620105",
  reason: "",
};

describe("buildMove — the contract's schema, run before the round trip", () => {
  it("accepts a picked destination and trims a blank reason to null", () => {
    const built = buildMove({ ...PICKED, reason: "   " });
    expect(built).toEqual({
      ok: true,
      input: {
        command: "record_move",
        provinceCode: "AR-R",
        localityName: "Bariloche",
        localityIndecId: "620105",
        reason: null,
      },
    });
  });

  it("carries the INDEC id of the row the person tapped", () => {
    // A2-alta-asentar-03. Sending only the name lets the server resolve a
    // homonym to the alphabetically first department: a mudanza to San Pedro,
    // Buenos Aires acknowledged "San Pedro, Santiago del Estero quedó
    // registrada", and the correcting move was then refused as
    // `move_same_locality` because the registry already believed the pet was
    // there.
    const built = buildMove({ ...PICKED, localityIndecId: "060658" });
    expect(built.ok && built.input.localityIndecId).toBe("060658");
  });

  it("sends null when the picker did not say which row — the old body, unchanged", () => {
    // An older build sends no id at all. The server falls back to the
    // (province, name) pair, so this must be a clean null rather than a "".
    const built = buildMove({ ...PICKED, localityIndecId: "   " });
    expect(built.ok && built.input.localityIndecId).toBeNull();
  });

  it("keeps a real reason, trimmed", () => {
    const built = buildMove({ ...PICKED, reason: "  Trabajo " });
    expect(built.ok && built.input.reason).toBe("Trabajo");
  });

  it("refuses a BLANK PROVINCE with the destination sentence", () => {
    // THE ONE THAT MATTERS MOST. A blank province reaches the server's
    // `canonicalProvinceNameForStorage("")`, which returns null, which makes the
    // STRICT branch of `normalizeLocationForWrite` skip the catalog entirely —
    // handing back an uncanonicalized pair with no error at all. The route's own
    // schema is the backstop; this is the half that gives a person a sentence.
    //
    // MUTATION APPLIED: `provinceCode: draft.provinceCode || "AR-X"` in
    // `buildMove`. Red — and the request would then go out naming a province
    // nobody picked.
    const built = buildMove({ ...PICKED, provinceCode: "" });
    expect(built).toEqual({
      ok: false,
      code: "DESTINATION_REQUIRED",
      message: "Elegí la localidad de destino de la lista.",
    });
  });

  it("refuses a blank LOCALITY with the SAME sentence, because it is one control", () => {
    // The picker writes both halves in one tap and clears both in one tap, so a
    // message naming the province would point at a field this screen does not
    // draw. Asserted as equality with the case above rather than as its own
    // string, so the two cannot drift apart.
    const noLocality = buildMove({ ...PICKED, localityName: "  " });
    const noProvince = buildMove({ ...PICKED, provinceCode: "" });
    expect(noLocality).toEqual(noProvince);
  });

  it("refuses a reason past the cap rather than truncating it", () => {
    // Truncation would edit somebody's explanation without being asked.
    // MUTATION APPLIED: `reason: draft.reason.slice(0, 200)`. Red.
    const built = buildMove({ ...PICKED, reason: "x".repeat(201) });
    expect(built).toMatchObject({ ok: false, code: "REASON_TOO_LONG" });
  });
});

describe("currentJurisdiction — three states, and two of them are not the same", () => {
  it("reads a known pair locality-first, the way the web prints it", () => {
    // MUTATION APPLIED: join province first. Red — and the row would read
    // "Buenos Aires, La Plata", which is the address written backwards.
    expect(currentJurisdiction(detail(okIdentity()))).toEqual({
      kind: "known",
      label: "La Plata, Buenos Aires",
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });

  it("says `none` only when BOTH halves are absent", () => {
    expect(
      currentJurisdiction(
        detail(okIdentity({ jurisdictionProvince: null, jurisdictionLocality: null })),
      ),
    ).toEqual({ kind: "none" });
  });

  it("still reads a province with no locality as KNOWN", () => {
    // A pet registered at province granularity has a jurisdiction; calling it
    // `none` would tell its owner nothing is on file.
    // MUTATION APPLIED: `if (!jurisdictionProvince || !jurisdictionLocality) return { kind: "none" }`.
    // Red.
    expect(currentJurisdiction(detail(okIdentity({ jurisdictionLocality: null })))).toEqual({
      kind: "known",
      label: "Buenos Aires",
      province: "Buenos Aires",
      locality: null,
    });
  });

  it("distinguishes an UNAVAILABLE section from an animal with no locality", () => {
    // THE DISTINCTION `CredentialSection` EXISTS TO FORCE. A pooler outage that
    // rendered as "no tiene localidad registrada" would invite somebody to
    // register a move they do not need — and a move appends to the ledger and
    // moves the columns that decide which authority answers for the animal.
    // MUTATION APPLIED: `return { kind: "none" }` for a non-ok section. Red.
    expect(currentJurisdiction(detail({ status: "unavailable" }))).toEqual({
      kind: "unavailable",
    });
  });
});

describe("petNameFrom / moveRecordedMessage", () => {
  it("hands back null rather than a placeholder when the section did not load", () => {
    expect(petNameFrom(detail({ status: "unavailable" }))).toBeNull();
    expect(petNameFrom(detail(okIdentity()))).toBe("Pampa");
  });

  it("names the CANONICAL pair in the confirmation, locality first", () => {
    // The person typed "bariloche"; what was stored is the catalog's spelling,
    // and the sentence has to say the stored one — otherwise a screen confirms a
    // registration in words that are not on the record.
    expect(
      moveRecordedMessage({ province: "Río Negro", locality: "San Carlos de Bariloche" }),
    ).toContain("San Carlos de Bariloche, Río Negro");
  });
});
