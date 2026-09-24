// The PPP attestation evidence rule — T4-I1 / issue #753.
//
// A TABLE, not a narrative, because the rule is a disjunction of two arms and
// what matters is that each arm decides ALONE and that neither arm decides the
// other's cases by accident. The projection test
// (lib/projections/pet-compliance.test.ts) asserts what the CARD does with the
// answer; this one asserts the answer.

import { describe, expect, it } from "vitest";

import {
  PPP_DECLARED_HINT,
  attestationCountsAsCompliant,
  attestationIsInstitutional,
  citesRegistryId,
} from "./ppp-attestation";

const OWNER = { authorRole: "owner", authorVerified: false, authorOrganizationId: null };

describe("citesRegistryId — arm (a), the checkable number", () => {
  it("true for a number the registry issued", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: "RUPPPA-12345" } })).toBe(true);
  });

  it("false when the field is absent", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry: "caba_4078" } })).toBe(false);
  });

  it("false for null — what the web form posts when the field was left empty", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: null } })).toBe(false);
  });

  // The API accepts `registry_id: string | null` and a client may send spaces.
  // Without the trim this is a bare assertion wearing a number's clothes, and
  // the SQL mirror trims for the same case.
  it("false for spaces only", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: "   " } })).toBe(false);
  });

  // NOT JUST SPACES, and the distinction cost a real divergence. `.trim()`
  // strips every WhiteSpace and LineTerminator codepoint; the SQL mirror used
  // bare `btrim`, which strips SPACES ONLY, so a TAB was evidence there and not
  // here (security review 2026-09-23). The fixture that was supposed to catch
  // it used spaces — which `btrim` does strip — so it caught nothing. These pin
  // the TS side of the set, one per family.
  it("false for a tab, a non-breaking space and an ideographic space", () => {
    for (const raw of ["\t", "\u00a0", "\u3000", "\n\u2028", "\u202f\u205f"]) {
      expect(citesRegistryId({ ...OWNER, payload: { registry_id: raw } })).toBe(false);
    }
  });

  // The other direction, so the class cannot be widened into uselessness: a
  // real number wearing that padding is still a real number, and U+200B is NOT
  // whitespace to either side, so it stays evidence.
  it("true for a number wearing whitespace, and for a zero-width space", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: "\t RUPPPA-9 \u00a0" } })).toBe(
      true,
    );
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: "\u200b" } })).toBe(true);
  });

  it("false for a non-string — a number is not the registry's identifier format", () => {
    expect(citesRegistryId({ ...OWNER, payload: { registry_id: 12345 } })).toBe(false);
  });

  it("false when there is no payload at all", () => {
    expect(citesRegistryId({ ...OWNER })).toBe(false);
    expect(citesRegistryId({ ...OWNER, payload: null })).toBe(false);
  });
});

describe("attestationIsInstitutional — arm (b), the accountable name", () => {
  it("true for a verified govt actor — the registry operator itself", () => {
    expect(
      attestationIsInstitutional({
        authorRole: "govt",
        authorVerified: true,
        authorOrganizationId: null,
        payload: {},
      }),
    ).toBe(true);
  });

  it("true for a verified shelter acting for an organization", () => {
    expect(
      attestationIsInstitutional({
        authorRole: "shelter",
        authorVerified: true,
        authorOrganizationId: "org-1",
        payload: {},
      }),
    ).toBe(true);
  });

  // The VET-role trust keystone (#43): an org member WITHOUT a validated
  // matrícula is `org_registered`, which never clears a compliance gate. If
  // this flips, the PPP card and the rabies card have started disagreeing
  // about what "verificada" means.
  it("false for an unverified org member", () => {
    expect(
      attestationIsInstitutional({
        authorRole: "shelter",
        authorVerified: false,
        authorOrganizationId: "org-1",
        payload: {},
      }),
    ).toBe(false);
  });

  it("false for a plain owner", () => {
    expect(attestationIsInstitutional({ ...OWNER, payload: {} })).toBe(false);
  });

  // THE A4 BUMPER MUST NOT REACH HERE. `computeConfidence` returns
  // institutional_verified for ANY author whose payload carries
  // `confirmed_by_lab: true` — right for a disease report, wrong for a
  // REGISTRY INSCRIPTION, which no laboratory can attest to. Left in, a stray
  // key would clear the PPP obligation on nobody's authority, and the SQL
  // mirror (which has no such term) would disagree. A review measured exactly
  // that disagreement.
  it("false for an owner whose payload carries confirmed_by_lab", () => {
    expect(attestationIsInstitutional({ ...OWNER, payload: { confirmed_by_lab: true } })).toBe(
      false,
    );
    expect(
      attestationCountsAsCompliant({
        ...OWNER,
        payload: { registry_id: null, confirmed_by_lab: true },
      }),
    ).toBe(false);
  });

  // The author rules themselves are still the shared ones — only the payload
  // bumpers are withheld. A verified govt actor carrying the same key is TRUE
  // because of WHO they are, and this pins that the withholding did not break
  // arm (b) generally.
  it("still true for a verified govt actor whose payload carries confirmed_by_lab", () => {
    expect(
      attestationIsInstitutional({
        authorRole: "govt",
        authorVerified: true,
        authorOrganizationId: null,
        payload: { confirmed_by_lab: true },
      }),
    ).toBe(true);
  });

  it("false for an unverified govt actor", () => {
    expect(
      attestationIsInstitutional({
        authorRole: "govt",
        authorVerified: false,
        authorOrganizationId: null,
        payload: {},
      }),
    ).toBe(false);
  });
});

describe("attestationCountsAsCompliant — the rule", () => {
  it("either arm alone is enough", () => {
    // (a) only
    expect(attestationCountsAsCompliant({ ...OWNER, payload: { registry_id: "RUPPPA-1" } })).toBe(
      true,
    );
    // (b) only
    expect(
      attestationCountsAsCompliant({
        authorRole: "govt",
        authorVerified: true,
        authorOrganizationId: null,
        payload: { registry_id: null },
      }),
    ).toBe(true);
  });

  it("neither arm is not enough — this is the hole #753 named", () => {
    expect(attestationCountsAsCompliant({ ...OWNER, payload: { registry: "caba_4078" } })).toBe(
      false,
    );
  });
});

describe("PPP_DECLARED_HINT", () => {
  // The hint must name the ARTIFACT that fixes the state. A hint that just says
  // "no está verificada" tells an owner who did everything right that the
  // product does not believe them and gives them nothing to do about it.
  it("names the inscription number", () => {
    expect(PPP_DECLARED_HINT).toContain("número de inscripción");
  });
});
