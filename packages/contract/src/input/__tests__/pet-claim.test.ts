// `petClaimCommandInputSchema` — what a client may send to
// `POST /me/pet-claims`.
//
// THE CASE A REVIEWER SHOULD READ FIRST is the `dispute` block. The member was
// a REFUSAL until D6 (2026-09-25) — a dispute requires at least one evidence
// file and this app could not attach one — and it landed the day the app could
// stage a photo. What the block pins is that the web's rules travel with it:
// 20-2000 characters of reason, at least one and at most five staged keys, and
// nothing but a key the server minted.
//
// THE SECOND is `never carries a pet token`. Both writers resolve the animal FROM
// the private identifier and consult no caller-supplied token anywhere; a token
// that never reaches the wire cannot be trusted by accident later.

import { describe, expect, it } from "vitest";

import {
  CLAIM_EVIDENCE_MAX_FILES,
  PET_CLAIM_COMMAND_INPUT_CODES,
  firstPetClaimCommandInputCode,
  petClaimCommandInputSchema,
} from "../pet-claim.ts";

/** The first input code for a body, or `null` when the body parses. */
function codeFor(body: unknown): string | null {
  const parsed = petClaimCommandInputSchema.safeParse(body);
  return parsed.success ? null : firstPetClaimCommandInputCode(parsed.error);
}

const CHIP = "982000123456789";
const TATTOO = "ABC-1234";

describe("petClaimCommandInputSchema — the command discriminator", () => {
  it("accepts the two commands a phone can honestly run", () => {
    expect(codeFor({ command: "lookup", identifierKind: "microchip", identifierValue: CHIP })).toBe(
      null,
    );
    expect(
      codeFor({ command: "claim_free", identifierKind: "microchip", identifierValue: CHIP }),
    ).toBe(null);
  });

  it("names a missing command rather than falling through to null", () => {
    expect(codeFor({})).toBe("COMMAND_REQUIRED");
    expect(codeFor({ identifierKind: "microchip", identifierValue: CHIP })).toBe(
      "COMMAND_REQUIRED",
    );
    expect(codeFor(null)).toBe("COMMAND_REQUIRED");
  });
});

describe("petClaimCommandInputSchema — the identifier is the authorization", () => {
  it("never carries a pet token — an extra one is dropped, not honoured", () => {
    // The wire shape has no token field at all. This asserts the DATA the server
    // receives after parsing, not merely that the schema tolerates the key: a
    // token that survived parsing is a token a handler could reach for.
    const parsed = petClaimCommandInputSchema.safeParse({
      command: "claim_free",
      identifierKind: "microchip",
      identifierValue: CHIP,
      petToken: "DIM-AAAA-BBBB",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("petToken" in parsed.data).toBe(false);
  });

  it("refuses an absent, empty or whitespace-only value", () => {
    expect(codeFor({ command: "lookup", identifierKind: "tattoo" })).toBe("IDENTIFIER_REQUIRED");
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: "" })).toBe(
      "IDENTIFIER_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: "   " })).toBe(
      "IDENTIFIER_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: 42 })).toBe(
      "IDENTIFIER_REQUIRED",
    );
  });

  it("refuses a kind outside the web's own two", () => {
    expect(codeFor({ command: "lookup", identifierKind: "dni", identifierValue: "20123456" })).toBe(
      "IDENTIFIER_KIND_REQUIRED",
    );
    expect(codeFor({ command: "lookup", identifierValue: CHIP })).toBe("IDENTIFIER_KIND_REQUIRED");
  });

  it("trims, so a chip pasted with a trailing newline still matches fifteen digits", () => {
    const parsed = petClaimCommandInputSchema.safeParse({
      command: "lookup",
      identifierKind: "microchip",
      identifierValue: `  ${CHIP}\n`,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.command === "lookup") {
      expect(parsed.data.identifierValue).toBe(CHIP);
    }
  });
});

describe("petClaimCommandInputSchema — the fifteen digits", () => {
  it("refuses a microchip that is not exactly fifteen digits, on BOTH commands", () => {
    // The rule is cross-field (kind + value) and both writers enforce it, so a
    // client that skipped it would spend a rate-limit token on a value that
    // cannot resolve to any animal.
    for (const command of ["lookup", "claim_free"]) {
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "12345678901234" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "1234567890123456" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
      expect(
        codeFor({ command, identifierKind: "microchip", identifierValue: "98200012345678A" }),
      ).toBe("MICROCHIP_MUST_BE_15_DIGITS");
    }
  });

  it("does NOT apply the digit rule to a tattoo code", () => {
    // `pet_identifications.code` is unbounded text for a tattoo and neither
    // writer caps or shapes it. A rule invented here would refuse a code the
    // registry already holds.
    expect(codeFor({ command: "lookup", identifierKind: "tattoo", identifierValue: TATTOO })).toBe(
      null,
    );
    expect(
      codeFor({
        command: "claim_free",
        identifierKind: "tattoo",
        identifierValue: "x".repeat(120),
      }),
    ).toBe(null);
  });
});

describe("firstPetClaimCommandInputCode", () => {
  it("only ever returns a code the vocabulary declares", () => {
    // The app's copy switch is exhaustive over this array with no `default`, so a
    // code outside it renders as a blank line under a "no se pudo" heading.
    for (const body of [
      {},
      { command: "lookup" },
      { command: "dispute" },
      { command: "lookup", identifierKind: "microchip", identifierValue: "1" },
      { command: "claim_free", identifierKind: "nope", identifierValue: CHIP },
    ]) {
      const code = codeFor(body);
      expect(code === null || PET_CLAIM_COMMAND_INPUT_CODES.includes(code as never)).toBe(true);
    }
  });
});

describe("petClaimCommandInputSchema — the dispute carries the web's rules", () => {
  const KEY = (n: number) => `welfare/${String(n).repeat(8)}-1111-4111-8111-111111111111.jpg`;
  const DISPUTE = {
    command: "dispute",
    identifierKind: "microchip",
    identifierValue: CHIP,
    reason: "Es mi perra, la perdí en marzo y tengo la libreta.",
    evidence: [KEY(1)],
  };

  it("accepts a dispute with a reason and one staged photo", () => {
    expect(codeFor(DISPUTE)).toBe(null);
  });

  it("refuses a dispute with NO evidence — the web's absolute gate, said before the round trip", () => {
    expect(codeFor({ ...DISPUTE, evidence: [] })).toBe("EVIDENCE_REQUIRED");
    const { evidence: _dropped, ...noEvidence } = DISPUTE;
    expect(codeFor(noEvidence)).toBe("EVIDENCE_REQUIRED");
  });

  it("counts the reason TRIMMED, as the use-case does: 20 to 2000", () => {
    expect(codeFor({ ...DISPUTE, reason: `   ${"x".repeat(19)}   ` })).toBe("REASON_TOO_SHORT");
    expect(codeFor({ ...DISPUTE, reason: "x".repeat(20) })).toBe(null);
    expect(codeFor({ ...DISPUTE, reason: "x".repeat(2000) })).toBe(null);
    expect(codeFor({ ...DISPUTE, reason: "x".repeat(2001) })).toBe("REASON_TOO_LONG");
  });

  it("takes at most the web's five photos, and no key twice", () => {
    expect(CLAIM_EVIDENCE_MAX_FILES).toBe(5);
    expect(codeFor({ ...DISPUTE, evidence: [1, 2, 3, 4, 5].map(KEY) })).toBe(null);
    expect(codeFor({ ...DISPUTE, evidence: [1, 2, 3, 4, 5, 6].map(KEY) })).toBe(
      "EVIDENCE_TOO_MANY",
    );
    expect(codeFor({ ...DISPUTE, evidence: [KEY(1), KEY(1)] })).toBe("EVIDENCE_INVALID");
  });

  it("refuses any key the staging ticket could not have minted", () => {
    for (const key of ["claims/x.jpg", "welfare/../x.jpg", `${KEY(1)}.heic`, "welfare/abc.jpg"]) {
      expect(codeFor({ ...DISPUTE, evidence: [key] }), key).toBe("EVIDENCE_INVALID");
    }
  });

  it("still checks the fifteen digits on a dispute", () => {
    expect(codeFor({ ...DISPUTE, identifierValue: "1234" })).toBe("MICROCHIP_MUST_BE_15_DIGITS");
  });

  it("never carries a pet token on a dispute either", () => {
    const parsed = petClaimCommandInputSchema.parse({ ...DISPUTE, petToken: "DIM-EVIL-TOKN" });
    expect("petToken" in parsed).toBe(false);
  });

  it("mints tickets for photos only — no video, no HEIC", () => {
    expect(codeFor({ command: "request_evidence_ticket", contentType: "image/jpeg" })).toBe(null);
    expect(codeFor({ command: "request_evidence_ticket", contentType: "video/mp4" })).toBe(
      "CONTENT_TYPE_INVALID",
    );
    expect(codeFor({ command: "request_evidence_ticket", contentType: "image/heic" })).toBe(
      "CONTENT_TYPE_INVALID",
    );
  });
});
