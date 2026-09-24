// The two conversions at the edges of the "editar mis datos" form.
//
// Both failure modes here are SILENT, which is the whole reason this is a module
// with a test rather than four lines inside a component: a wrong `toEditInput`
// does not crash and does not look wrong on screen. It either erases somebody's
// vet phone number on a save that mentions nothing, or quietly refuses to let
// them clear a field and leaves them retyping it.

import { describe, expect, it } from "@jest/globals";

import { type ProfileDraft, draftFrom, looksLikeArPhone, toEditInput } from "./profile-draft";

const PAYLOAD = {
  payloadVersion: 1 as const,
  issuedAt: "2026-08-29T12:00:00.000Z",
  staleAfter: "2026-08-29T12:01:00.000Z",
  profile: {
    displayName: "Lucía",
    phone: "+54 9 294 123-4567",
    preferredVetName: "Vet Bariloche",
    preferredVetPhone: "",
    emergencyContactName: "",
    emergencyContactPhone: "+54 9 11 5555-5555",
  },
};

const DRAFT: ProfileDraft = {
  displayName: "Lucía",
  phone: "",
  preferredVetName: "",
  preferredVetPhone: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
};

describe("draftFrom", () => {
  it("takes the six fields straight through, re-deriving nothing", () => {
    expect(draftFrom(PAYLOAD)).toEqual(PAYLOAD.profile);
  });
});

describe("toEditInput", () => {
  it("sends ALL SIX fields, so nothing the form did not show can be cleared", () => {
    // The mutation this catches: posting only what changed. The server's
    // "omitted means leave it alone" arm would then be doing real work, and the
    // day a field is added to the payload without being added to the form, that
    // field starts being silently preserved instead of visibly unsupported.
    const input = toEditInput(DRAFT);

    expect(Object.keys(input).sort()).toEqual([
      "displayName",
      "emergencyContactName",
      "emergencyContactPhone",
      "phone",
      "preferredVetName",
      "preferredVetPhone",
    ]);
  });

  it('keeps an empty field EMPTY, because `""` is how a column is cleared', () => {
    // The mutation this catches: dropping empty keys ("nothing to send"). That
    // is the server's "leave it alone" signal, so clearing a phone number from
    // the phone would become impossible — and the field would silently refill
    // itself on the next load.
    const input = toEditInput({ ...DRAFT, preferredVetPhone: "" });

    expect(input.preferredVetPhone).toBe("");
    expect(input.preferredVetPhone).not.toBeUndefined();
  });

  it("trims the display name, so five spaces reach the server as empty", () => {
    // The save button's length check counts TRIMMED characters. Without this,
    // "     " would pass the button's guard as five characters and then be
    // stored as a whitespace display name.
    expect(toEditInput({ ...DRAFT, displayName: "  Lucía  " }).displayName).toBe("Lucía");
  });

  it("does NOT trim the other five — the value is the person's, not the form's", () => {
    // The mutation this catches: `.trim()` on every field. A phone number with a
    // trailing space is what somebody typed and the server stores it as given;
    // trimming here would be this form quietly editing their input, which is the
    // behaviour the "format is a warning, not a refusal" decision exists to
    // avoid.
    const input = toEditInput({ ...DRAFT, phone: " +54 9 11 1234-5678 " });

    expect(input.phone).toBe(" +54 9 11 1234-5678 ");
  });
});

describe("looksLikeArPhone — re-exported, one definition", () => {
  it("is the SAME predicate the web form warns with", () => {
    // Not a copy of the regex. If this module ever grows its own, the two
    // clients start disagreeing about what an Argentine number looks like — on
    // the field a rescuer dials when they find somebody's dog.
    expect(looksLikeArPhone("+54 9 11 1234-5678")).toBe(true);
    expect(looksLikeArPhone("011 15-1234-5678")).toBe(true);
    expect(looksLikeArPhone("hola")).toBe(false);
  });

  it("answers `true` for empty, so a blank optional field is never nagged about", () => {
    expect(looksLikeArPhone("")).toBe(true);
    expect(looksLikeArPhone("   ")).toBe(true);
  });
});
