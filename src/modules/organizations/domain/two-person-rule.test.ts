// Unit tests for the two-person rule (H3, top-10 review 2026-08-22).
//
// The integration proof — a govt approving the org they founded, and the vet
// upgrade they proposed — lives in __tests__/admin-decisions.test.ts against a
// real database. This file pins the predicate itself, including the arm that
// integration test does not exercise (targetUserId) and the null handling,
// where the interesting mistake is treating "profile deleted" as "it is you".

import { describe, expect, it } from "vitest";

import {
  TWO_PERSON_ORG_REFUSAL,
  TWO_PERSON_REFUSAL,
  assertNotOwnOrganization,
  assertTwoPersonRule,
  isPartyToRequest,
} from "./two-person-rule";

const NOBODY = { applicantUserId: null, targetUserId: null, initiatedByUserId: null };
const ACTOR = "user-actor";

describe("isPartyToRequest — the three identities on an approval request", () => {
  it("catches the APPLICANT (the org founder verifying their own org)", () => {
    expect(isPartyToRequest(ACTOR, { ...NOBODY, applicantUserId: ACTOR })).toBe(true);
  });

  it("catches the TARGET (an authority-initiated upgrade that names them)", () => {
    // Not covered by the DB integration test. A govt self-approving their own
    // vet upgrade is counterproductive rather than an escalation — it
    // overwrites their role with `vet` and they LOSE their authority — but
    // refusing it with a sentence beats letting it demote them silently.
    expect(isPartyToRequest(ACTOR, { ...NOBODY, targetUserId: ACTOR })).toBe(true);
  });

  it("catches the INITIATOR (they proposed it on somebody else's behalf)", () => {
    expect(isPartyToRequest(ACTOR, { ...NOBODY, initiatedByUserId: ACTOR })).toBe(true);
  });

  it("lets a genuine third party through — all three identities are other people", () => {
    expect(
      isPartyToRequest(ACTOR, {
        applicantUserId: "user-applicant",
        targetUserId: "user-target",
        initiatedByUserId: "user-initiator",
      }),
    ).toBe(false);
  });

  it("does NOT read a null party as the actor", () => {
    // The FKs are ON DELETE SET NULL (migration 0080), so a null means the
    // person's profile is gone. Treating that as a match would make every
    // request with a deleted party permanently undecidable.
    expect(isPartyToRequest(ACTOR, NOBODY)).toBe(false);
  });
});

describe("assertTwoPersonRule", () => {
  it("refuses with the shared copy when the actor is a party", () => {
    expect(assertTwoPersonRule(ACTOR, { ...NOBODY, applicantUserId: ACTOR })).toEqual({
      ok: false,
      error: TWO_PERSON_REFUSAL,
    });
  });

  it("passes for a third party", () => {
    expect(assertTwoPersonRule(ACTOR, { ...NOBODY, applicantUserId: "somebody" })).toEqual({
      ok: true,
    });
  });
});

describe("assertNotOwnOrganization — the direct-verification mirror", () => {
  it("refuses verifying an organization you created", () => {
    expect(assertNotOwnOrganization(ACTOR, ACTOR)).toEqual({
      ok: false,
      error: TWO_PERSON_ORG_REFUSAL,
    });
  });

  it("allows verifying somebody else's organization", () => {
    expect(assertNotOwnOrganization(ACTOR, "user-founder")).toEqual({ ok: true });
  });

  it("allows verifying an organization whose creator is unknown", () => {
    // `created_by_user_id` is nullable and ON DELETE SET NULL, and rows predate
    // the column. A null must not freeze those organizations as unverifiable
    // forever — nobody could ever prove they are not the creator.
    expect(assertNotOwnOrganization(ACTOR, null)).toEqual({ ok: true });
  });
});
