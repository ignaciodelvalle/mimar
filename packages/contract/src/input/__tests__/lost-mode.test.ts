// `lostCommandInputSchema` — what a client may send to `POST .../lost`.
//
// THE POINT OF TESTING A SCHEMA THE SERVER ALSO ENFORCES: this is the copy the
// CLIENT runs, before the network, to put a message under the right field. A
// rule only the server knows is a rule the app can only discover from a 400 with
// no field detail.
//
// The two cases a reviewer should read first are the disclosure block and the
// coordinate pair. Both are places where this schema is deliberately NARROWER
// than the web form, and in both the reason is that a JSON client can express an
// ambiguity a form cannot.

import { describe, expect, it } from "vitest";

import { firstLostCommandInputCode, lostCommandInputSchema } from "../lost-mode.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = lostCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstLostCommandInputCode(parsed.error);
}

const DISCLOSURE = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
};

describe("lostCommandInputSchema — the command discriminator", () => {
  it("accepts the five commands and nothing else", () => {
    expect(codeFor({ command: "mark_lost", disclosure: DISCLOSURE })).toBe(null);
    expect(codeFor({ command: "report_last_seen" })).toBe(null);
    expect(codeFor({ command: "mark_found" })).toBe(null);
    expect(codeFor({ command: "reactivate_search" })).toBe(null);
    expect(codeFor({ command: "set_disclosure", key: "disclosePhoneWhenLost", value: true })).toBe(
      null,
    );

    expect(codeFor({ command: "delete_search" })).toBe("COMMAND_REQUIRED");
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
  });

  it("carries NO publicToken — that is a path segment", () => {
    // A body naming it too would be a second source for one identity and a way
    // for the two to disagree.
    const parsed = lostCommandInputSchema.parse({ command: "mark_found" });
    expect(parsed).toEqual({ command: "mark_found" });
  });
});

describe("lostCommandInputSchema — the disclosure block on mark_lost", () => {
  it("requires ALL FIVE toggles, so a client cannot ask for the ambiguity", () => {
    // `parseDisclosurePrefsFromForm` fails CLOSED when the section is absent:
    // "section absent" means no consent was expressed, not "keep what was
    // there". Optional fields here would reach that same writer through a door
    // that inherits the pet row's current values silently.
    expect(codeFor({ command: "mark_lost" })).toBe("DISCLOSURE_REQUIRED");
    expect(
      codeFor({
        command: "mark_lost",
        disclosure: { ...DISCLOSURE, allowFinderFormWhenLost: undefined },
      }),
    ).toBe("DISCLOSURE_REQUIRED");
  });

  it("takes the whole incident snapshot as optional, field by field", () => {
    // The web's wizard lets a person mark an animal lost in one tap and fill the
    // description in afterwards. A contract that required any of it would make
    // the fast path impossible.
    const parsed = lostCommandInputSchema.parse({
      command: "mark_lost",
      disclosure: DISCLOSURE,
      enrichedDescription: { color: "  Marrón  ", behaviorNotes: "   " },
    });
    expect(parsed).toMatchObject({
      enrichedDescription: {
        color: "Marrón",
        // A blank is "not stated", never a stated empty string.
        behaviorNotes: null,
        accessoriesWhenLost: null,
        microchipId: null,
      },
    });
  });

  it("normalizes every unstated optional to null rather than to an empty string", () => {
    const parsed = lostCommandInputSchema.parse({
      command: "mark_lost",
      disclosure: DISCLOSURE,
      locationDescription: "   ",
      reason: "Se escapó",
    });
    expect(parsed).toMatchObject({ locationDescription: null, reason: "Se escapó" });
  });
});

describe("lostCommandInputSchema — the coordinate pair", () => {
  it("takes both or neither, where the web silently discards a half pair", () => {
    // `setPetLostAction` validates only `if (lat && lng)`, so a half pair reaches
    // `writePoint` and is dropped. A map widget cannot produce one; a JSON client
    // can, and dropping half a fact on the floor is the failure nobody sees.
    for (const command of ["mark_lost", "report_last_seen"] as const) {
      const base = command === "mark_lost" ? { command, disclosure: DISCLOSURE } : { command };
      expect(codeFor({ ...base, locationLat: -36.6 })).toBe("COORDS_INCOMPLETE");
      expect(codeFor({ ...base, locationLng: -64.2 })).toBe("COORDS_INCOMPLETE");
      expect(codeFor({ ...base, locationLat: -36.6, locationLng: -64.2 })).toBe(null);
      expect(codeFor(base)).toBe(null);
    }
  });

  it("refuses a pin outside the world, which is the web's own STEP 3 hardening", () => {
    const base = { command: "report_last_seen" as const };
    expect(codeFor({ ...base, locationLat: 91, locationLng: 0 })).toBe("COORDS_OUT_OF_RANGE");
    expect(codeFor({ ...base, locationLat: 0, locationLng: -181 })).toBe("COORDS_OUT_OF_RANGE");
    expect(codeFor({ ...base, locationLat: -90, locationLng: 180 })).toBe(null);
  });

  it("refuses a non-finite pin before it can become a NaN in the ledger", () => {
    expect(
      codeFor({
        command: "report_last_seen",
        locationLat: Number.POSITIVE_INFINITY,
        locationLng: 0,
      }),
    ).toBe("COORDS_INVALID");
  });
});

describe("lostCommandInputSchema — set_disclosure", () => {
  it("accepts the six real keys and refuses anything else", () => {
    for (const key of [
      "discloseFirstNameWhenLost",
      "disclosePhoneWhenLost",
      "discloseEmailWhenLost",
      "discloseLastLocationWhenLost",
      "allowFinderFormWhenLost",
      "discloseCaretakerContactWhenLost",
    ]) {
      expect(codeFor({ command: "set_disclosure", key, value: true })).toBe(null);
    }
    expect(codeFor({ command: "set_disclosure", key: "discloseDniWhenLost", value: true })).toBe(
      "DISCLOSURE_KEY_INVALID",
    );
  });

  it("requires an explicit value — there is no toggle-by-omission", () => {
    // A command that flipped whatever was there would make a retry after a
    // timeout undo the thing it was retrying.
    expect(codeFor({ command: "set_disclosure", key: "disclosePhoneWhenLost" })).toBe(
      "DISCLOSURE_VALUE_REQUIRED",
    );
  });
});
