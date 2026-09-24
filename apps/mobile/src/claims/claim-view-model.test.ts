// `claim-view-model` — the words for a claim, and the two things they must never
// say.
//
// WHAT THESE HAVE TO PROVE, beyond "it returns a string"
// ---------------------------------------------------------------------------
//   1. NO SENTENCE IN THIS FILE INVITES A CLAIM ON AN ANIMAL SOMEBODY HOLDS.
//      `canClaim` is the server's, and the copy for `active_owner` has to send a
//      person to the browser rather than to a button — because the disputa the
//      web offers there needs an evidence file this build cannot attach.
//   2. THE DRAFT BUILDER USES THE CONTRACT'S SCHEMA AND RETURNS ITS PARSE, so
//      the value that reaches the server is the trimmed one the fifteen-digit
//      rule was checked against — not the raw text from the field.
//   3. EVERY VARIANT AND EVERY INPUT CODE HAS A SENTENCE. Both switches are
//      exhaustive with no `default`, so a silent blank line is the failure this
//      guards, and it is guarded by ITERATING the contract's own arrays rather
//      than by listing values here.
//   4. THE SIGHTING LINK IS THE WEB'S, built from `DEEP_LINK_MAP`, because there
//      is no native avistaje form and a `mimar://` URL would resolve to nothing
//      for the finder it is meant for.

import { describe, expect, it } from "@jest/globals";

import { PET_CLAIM_VARIANTS_V1, type PetClaimLookupAckV1 } from "@dim/contract/api";
import { PET_CLAIM_COMMAND_INPUT_CODES } from "@dim/contract/input";

import {
  SCAN_NOT_A_CHIP_MESSAGE,
  buildClaimCommand,
  chipCodeFromScan,
  claimDisputeUrl,
  claimIdentifierFieldLabel,
  claimIdentifierKindLabel,
  claimIdentifierPlaceholder,
  claimInputMessage,
  claimSightingUrl,
  claimVariantBody,
  claimVariantHeadline,
  claimVariantTone,
} from "./claim-view-model";

const CHIP = "982000123456789";
const ORIGIN = "https://dim-staging.vercel.app";

function anAck(over: Partial<PetClaimLookupAckV1> = {}): PetClaimLookupAckV1 {
  return {
    command: "lookup",
    variant: "free",
    petName: "Rocky",
    petToken: null,
    ownerInitials: null,
    canClaim: true,
    ...over,
  };
}

describe("buildClaimCommand — the contract's schema, not a second copy", () => {
  it("returns the PARSED input, so the server sees the trimmed value", () => {
    const draft = buildClaimCommand("lookup", "microchip", `  ${CHIP}\n`);
    expect(draft.ok).toBe(true);
    if (draft.ok) {
      expect(draft.input).toEqual({
        command: "lookup",
        identifierKind: "microchip",
        identifierValue: CHIP,
      });
    }
  });

  it("refuses a 14-digit microchip locally, with the code the copy switch knows", () => {
    // The point of validating client-side at all: the person hears about it
    // without a round trip, and the round trip that would have been refused
    // never spends the shared `claim_lookup` budget.
    const draft = buildClaimCommand("claim_free", "microchip", "12345678901234");
    expect(draft).toEqual({ ok: false, code: "MICROCHIP_MUST_BE_15_DIGITS" });
  });

  it("refuses an empty value, on both commands", () => {
    expect(buildClaimCommand("lookup", "tattoo", "   ")).toEqual({
      ok: false,
      code: "IDENTIFIER_REQUIRED",
    });
    expect(buildClaimCommand("claim_free", "tattoo", "")).toEqual({
      ok: false,
      code: "IDENTIFIER_REQUIRED",
    });
  });

  it("does NOT apply the digit rule to a tattoo code", () => {
    expect(buildClaimCommand("lookup", "tattoo", "ABC-1234").ok).toBe(true);
  });
});

describe("claimInputMessage — every code says something", () => {
  it("covers EVERY code the contract declares, plus the null arm", () => {
    // Iterating the contract's array rather than listing codes here is the whole
    // point: when the vocabulary widens, this widens with it.
    for (const code of PET_CLAIM_COMMAND_INPUT_CODES) {
      expect(claimInputMessage(code).trim().length).toBeGreaterThan(0);
    }
    expect(claimInputMessage(null).trim().length).toBeGreaterThan(0);
  });

  it("tells a person WHAT TO COUNT TO on the microchip", () => {
    // A vet's sticker has the number on it and somebody is counting digits. "El
    // formato no es válido" would be true and useless.
    expect(claimInputMessage("MICROCHIP_MUST_BE_15_DIGITS")).toContain("15");
  });
});

describe("claimVariantHeadline / claimVariantBody — every variant says something", () => {
  it("covers EVERY variant the contract declares, in both", () => {
    // Collected into a record rather than asserted in the loop: jest's `expect`
    // takes no message argument, so a bare `toBeGreaterThan(0)` inside a loop
    // reports "expected 0 to be greater than 0" and never says WHICH variant.
    const empty = PET_CLAIM_VARIANTS_V1.filter((variant) => {
      const ack = anAck({ variant, petName: variant === "not_found" ? null : "Rocky" });
      return (
        claimVariantHeadline(ack).trim().length === 0 ||
        claimVariantBody(ack).trim().length === 0 ||
        !claimVariantTone(variant)
      );
    });
    expect(empty).toEqual([]);
  });

  it("never loses the animal's name to an empty string when the wire sends null", () => {
    // Every arm but `not_found` types `petName` as `string | null` because the
    // wire shape is flat. A heading that silently rendered "" reads as a
    // rendering bug rather than as a missing value.
    const headline = claimVariantHeadline(anAck({ variant: "lost", petName: null }));
    expect(headline).toContain("La mascota");
    expect(headline).not.toContain("null");
  });
});

describe("the `active_owner` copy — the one that must not offer what this app cannot do", () => {
  it("does not print owner initials that are not there, and does not say 'dueño' over a shelter", () => {
    // `ownerInitials` is null in TWO situations and only one of them is "no
    // custody": a refugio holding an animal under `shelter_custody` has no owner
    // row at all, and the variant is still `active_owner`. Printing "ya tiene
    // dueño/a registrado/a ()" would be both ugly and wrong.
    const withInitials = claimVariantHeadline(
      anAck({ variant: "active_owner", ownerInitials: "L.F.", canClaim: false }),
    );
    expect(withInitials).toContain("(L.F.)");

    const withoutInitials = claimVariantHeadline(
      anAck({ variant: "active_owner", ownerInitials: null, canClaim: false }),
    );
    expect(withoutInitials).not.toContain("(");
    expect(withoutInitials).toContain("custodia");
  });

  it("names the browser instead of leaving a dead end at the disputa", () => {
    // THE ASSERTION THIS DESCRIBE BLOCK IS FOR. The web's third step needs at
    // least one evidence file — the server refuses without one, absolutely — and
    // this build has no image picker. A screen that just said "no se puede"
    // would be hiding a capability the person actually has, one browser away.
    const body = claimVariantBody(anAck({ variant: "active_owner", canClaim: false }));
    expect(body).toContain("web");
    expect(body.toLowerCase()).toContain("disputa");
    expect(body.toLowerCase()).toMatch(/foto|video/);
  });

  it("sends a lost animal to an avistaje rather than to a claim", () => {
    const body = claimVariantBody(anAck({ variant: "lost", canClaim: false }));
    expect(body.toLowerCase()).toContain("avistaje");
    expect(body.toLowerCase()).not.toContain("reclamala");
  });
});

describe("the links out", () => {
  it("builds the sighting URL from the shared table, as https and never mimar://", () => {
    // `DEEP_LINK_MAP.credentialSighting` has `appPath: null` — there is no native
    // avistaje form — and a custom scheme resolves to nothing for the finder
    // this link is meant for.
    const url = claimSightingUrl(ORIGIN, "DIM-PAMP-0001");
    expect(url).toBe(`${ORIGIN}/p/DIM-PAMP-0001/sighting`);
    expect(url.startsWith("https://")).toBe(true);
  });

  it("percent-encodes a token rather than pasting it into a path", () => {
    expect(claimSightingUrl(ORIGIN, "DIM/../evil")).not.toContain("/../");
  });

  it("does not double a slash when the origin carries a trailing one", () => {
    expect(claimDisputeUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/mis-mascotas/reclamar`);
  });
});

describe("the field labels", () => {
  it("changes the label and the placeholder with the kind, the way the web does", () => {
    expect(claimIdentifierKindLabel("microchip")).toBe("Microchip");
    expect(claimIdentifierKindLabel("tattoo")).toBe("Tatuaje");
    expect(claimIdentifierFieldLabel("microchip")).toContain("microchip");
    expect(claimIdentifierFieldLabel("tattoo")).toContain("tatuaje");
    expect(claimIdentifierPlaceholder("microchip")).toMatch(/^\d{15}$/);
    expect(claimIdentifierPlaceholder("tattoo")).not.toMatch(/^\d+$/);
  });
});

describe("chipCodeFromScan — the camera and the keyboard share one door", () => {
  it("accepts fifteen digits and returns them exactly — the string the field would hold", () => {
    // The scanner sets the SAME string the keyboard sets, so what comes back
    // must survive `buildClaimCommand` unchanged: same value, same schema.
    const code = chipCodeFromScan("982000123456789");
    expect(code).toBe("982000123456789");
    expect(buildClaimCommand("lookup", "microchip", code as string)).toEqual({
      ok: true,
      input: { command: "lookup", identifierKind: "microchip", identifierValue: code },
    });
  });

  it("strips the separators a sticker's barcode carries", () => {
    expect(chipCodeFromScan("982 000 123 456 789")).toBe("982000123456789");
    expect(chipCodeFromScan("982-000-123456789")).toBe("982000123456789");
    expect(chipCodeFromScan("982.000.123.456.789")).toBe("982000123456789");
  });

  it("refuses everything that is not fifteen digits, with null and never a partial fill", () => {
    // A vet's sticker carries other barcodes — lot numbers, product codes. A
    // wrong scan must leave the field alone, not fill it with a value the
    // person has to notice and delete.
    expect(chipCodeFromScan("12345678901234")).toBeNull(); // fourteen
    expect(chipCodeFromScan("1234567890123456")).toBeNull(); // sixteen
    expect(chipCodeFromScan("LOT-2026-08-A")).toBeNull(); // a lot number
    expect(chipCodeFromScan("98200012345678A")).toBeNull(); // one letter
    expect(chipCodeFromScan("")).toBeNull();
    expect(chipCodeFromScan("   ")).toBeNull();
  });

  it("has a sentence for the refusal that names the keyboard as the way forward", () => {
    expect(SCAN_NOT_A_CHIP_MESSAGE).toContain("a mano");
  });
});
