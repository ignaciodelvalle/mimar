// `petProfileCommandInputSchema` and the length gate beside it — what a client
// may send to `POST .../profile`, and how long the two free-text identity
// fields may be.
//
// THE ONE CASE A REVIEWER SHOULD READ FIRST is the grandfather block. The caps
// on `name` and `color` are NOT on the schema, and that is the whole point:
// `pets.name` and `pets.color` are unbounded `text` whose only writer caps
// neither, so values longer than `PET_NAME_MAX` already exist in the database.
// A cap that could not see the stored row would apply itself to those values on
// the way back out and refuse the entire request — including the COLOUR
// correction the person actually came to make, because `edit_identity` carries
// all three fields on every save. The owner ends up locked out of their own
// record by a number invented after their data.
//
// So the rule is the one QA A5 already established one field over: only NEW
// values are gated, and a value identical to the one on the animal passes at any
// length. These tests are what fails if somebody "tidies" the gate back onto the
// schema, where the stored value is not in scope.

import { describe, expect, it } from "vitest";

import {
  PET_COLOR_MAX,
  PET_NAME_MAX,
  firstPetProfileCommandInputCode,
  petIdentityFieldCap,
  petProfileCommandInputSchema,
  resolvePetIdentityLengths,
} from "../pet-profile-edit.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = petProfileCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstPetProfileCommandInputCode(parsed.error);
}

/** A name far past any cap — the shape a legacy row can already hold. */
const LONG_NAME = "Pampa ".repeat(30).trim();
const LONG_COLOR = "atigrada con manchas ".repeat(20).trim();

const STORED = { name: "Pampa", color: "Atigrada" };

describe("edit_identity — the schema itself", () => {
  it("accepts the three fields and clears breed and colour with null", () => {
    const parsed = petProfileCommandInputSchema.safeParse({
      command: "edit_identity",
      name: "  Pampita  ",
      breed: null,
      color: "",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        command: "edit_identity",
        name: "Pampita",
        breed: null,
        color: null,
      });
    }
  });

  it("still refuses a blank name — the column is not null and the credential is read by it", () => {
    expect(codeFor({ command: "edit_identity", name: "   ", breed: null, color: null })).toBe(
      "NAME_REQUIRED",
    );
  });

  it("does NOT refuse a long name, because it cannot see the animal", () => {
    // The distinction the schema is structurally unable to make: this body is
    // either a legacy value being carried over or a new one being typed, and
    // only the stored row says which. Refusing here would refuse both.
    expect(
      codeFor({ command: "edit_identity", name: LONG_NAME, breed: null, color: LONG_COLOR }),
    ).toBeNull();
  });

  it("keeps the two contact caps, which mirror the server's own numbers", () => {
    expect(
      codeFor({
        command: "set_emergency_contacts",
        preferredVetName: "x".repeat(81),
        preferredVetPhone: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
      }),
    ).toBe("CONTACT_NAME_TOO_LONG");
    expect(
      codeFor({
        command: "set_emergency_contacts",
        preferredVetName: "",
        preferredVetPhone: "9".repeat(41),
        emergencyContactName: "",
        emergencyContactPhone: "",
      }),
    ).toBe("CONTACT_PHONE_TOO_LONG");
  });
});

describe("resolvePetIdentityLengths — only NEW values are capped", () => {
  it("admits a value inside the cap", () => {
    expect(resolvePetIdentityLengths({ name: "Pampita", color: "Blanca" }, STORED)).toEqual({
      ok: true,
    });
  });

  it("refuses a NEW name past the cap", () => {
    expect(resolvePetIdentityLengths({ name: LONG_NAME, color: null }, STORED)).toEqual({
      ok: false,
      code: "NAME_TOO_LONG",
    });
  });

  it("refuses a NEW colour past the cap, naming the colour and not the name", () => {
    expect(resolvePetIdentityLengths({ name: "Pampa", color: LONG_COLOR }, STORED)).toEqual({
      ok: false,
      code: "COLOR_TOO_LONG",
    });
  });

  it("ADMITS the animal's own over-long name, posted back unchanged", () => {
    // The lockout this exists to prevent. Without it the owner of a pet recorded
    // with a 180-character name could not correct anything on this screen ever
    // again — the form posts the name on every save.
    expect(
      resolvePetIdentityLengths(
        { name: LONG_NAME, color: "Blanca" },
        { name: LONG_NAME, color: "Atigrada" },
      ),
    ).toEqual({ ok: true });
  });

  it("ADMITS the animal's own over-long colour while the name is being corrected", () => {
    expect(
      resolvePetIdentityLengths(
        { name: "Pampita", color: LONG_COLOR },
        { name: "Pampa", color: LONG_COLOR },
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a DIFFERENT over-long name even on an animal that already has one", () => {
    // The grandfather is for the value on the row, not a licence to type any
    // length once one long value exists.
    expect(
      resolvePetIdentityLengths(
        { name: `${LONG_NAME} y algo más`, color: null },
        { name: LONG_NAME, color: null },
      ),
    ).toEqual({ ok: false, code: "NAME_TOO_LONG" });
  });

  it("compares trimmed, so whitespace around a carried-over value is not a new value", () => {
    expect(
      resolvePetIdentityLengths(
        { name: LONG_NAME, color: null },
        { name: `  ${LONG_NAME}  `, color: null },
      ),
    ).toEqual({ ok: true });
  });

  it("treats a cleared colour as no colour rather than measuring null", () => {
    expect(resolvePetIdentityLengths({ name: "Pampa", color: null }, STORED)).toEqual({ ok: true });
  });

  it("reports the NAME first when both fields are over — one message, nearest the top", () => {
    expect(
      resolvePetIdentityLengths({ name: LONG_NAME, color: LONG_COLOR }, { name: "", color: null }),
    ).toEqual({ ok: false, code: "NAME_TOO_LONG" });
  });
});

describe("petIdentityFieldCap — the cap a control may truncate at", () => {
  it("is the constant when nothing longer is stored", () => {
    expect(petIdentityFieldCap(PET_NAME_MAX, "Pampa")).toBe(PET_NAME_MAX);
    expect(petIdentityFieldCap(PET_COLOR_MAX, null)).toBe(PET_COLOR_MAX);
  });

  it("rises to the stored length, so an input cannot shorten what is already there", () => {
    // A `TextInput` truncates the value it is handed. A fixed cap under a longer
    // stored name would put the shortened one on screen and store it on the next
    // save — an edit to the credential's own field that nobody asked for.
    expect(petIdentityFieldCap(PET_NAME_MAX, LONG_NAME)).toBe(LONG_NAME.length);
  });
});
