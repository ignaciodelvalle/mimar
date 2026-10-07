// `legal-acceptance-input` — the re-acceptance boxes judged by the CONTRACT'S
// schema (2026-10-07; legal review 2026-10-02 rows P10/P9).

import { describe, expect, it } from "@jest/globals";

import { LEGAL_ACCEPTANCE_INPUT_CODES } from "@dim/contract/input";

import { NO_LEGAL_CONSENTS } from "./LegalConsentBoxes";
import {
  canSubmitLegalAcceptance,
  legalAcceptanceErrorMessage,
  toLegalAcceptanceInput,
} from "./legal-acceptance-input";

const ALL = { tosAccepted: true, transferAccepted: true, adultDeclared: true };

describe("toLegalAcceptanceInput", () => {
  it("sends the three boxes and the version this bundle displays (written out)", () => {
    expect(toLegalAcceptanceInput(ALL)).toEqual({
      ok: true,
      input: { ...ALL, legalVersion: "2026-10-07" },
    });
  });

  const CASES: Array<[keyof typeof ALL, string]> = [
    ["tosAccepted", "TOS_NOT_ACCEPTED"],
    ["transferAccepted", "TRANSFER_NOT_ACCEPTED"],
    ["adultDeclared", "ADULT_NOT_DECLARED"],
  ];
  it.each(CASES)("refuses %s=false with %s", (field, code) => {
    const verdict = toLegalAcceptanceInput({ ...ALL, [field]: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe(code);
  });

  it("starts with nothing ticked", () => {
    expect(NO_LEGAL_CONSENTS).toEqual({
      tosAccepted: false,
      transferAccepted: false,
      adultDeclared: false,
    });
    expect(canSubmitLegalAcceptance(NO_LEGAL_CONSENTS)).toBe(false);
    expect(canSubmitLegalAcceptance(ALL)).toBe(true);
  });

  it("has a distinct sentence for every code the contract declares", () => {
    const sentences = LEGAL_ACCEPTANCE_INPUT_CODES.map(legalAcceptanceErrorMessage);
    for (const s of sentences) expect(s.trim().length).toBeGreaterThan(0);
    expect(new Set(sentences).size).toBe(LEGAL_ACCEPTANCE_INPUT_CODES.length);
  });
});
