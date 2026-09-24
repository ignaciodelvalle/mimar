// The phone's local refusal and the server's refusal must be the SAME refusal.
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `adoptionApplicationInputSchema` (@dim/contract/input) is a TRANSCRIPTION of
// `validateApplicationInput` (src/modules/adoption/domain/application-rules.ts).
// The domain function stays the rule — the use-case runs it on every submission
// from either door — and the schema exists so a phone can refuse a form without
// spending a round trip.
//
// A transcription drifts. Both directions cost something real:
//
//   · STRICTER SCHEMA → a form the client will not send and the server would
//     have accepted, with no server message to explain the refusal. The person
//     retypes the same sentence and the button stays dead.
//   · LOOSER SCHEMA → the client draws "Enviar" over a submission it has
//     already been told will fail, and hands back a generic `invalid_request`
//     envelope instead of naming the field.
//
// So the numbers are not compared as numbers. Both validators are RUN over the
// same inputs and their verdicts must agree, which is the only comparison that
// survives one of them changing shape.
//
// WHAT IS DELIBERATELY NOT IN PARITY, AND IS ASSERTED AS SUCH
// ---------------------------------------------------------------------------
// The domain function carries two rules a client cannot possibly check for
// itself: the institutional-account refusal and the duplicate-pending refusal.
// Both need state only the server has. They are asserted BELOW as an asymmetry
// the schema is expected to have — not skipped — so that "the schema is looser
// here" stays a decision with a reason rather than a gap somebody widens.

import {
  ADOPTION_MOTIVATION_MIN_LENGTH,
  ADOPTION_TEXT_MAX_LENGTH,
  adoptionApplicationInputSchema,
} from "@dim/contract/input";

import { describe, expect, it } from "vitest";

import { validateApplicationInput } from "@/src/modules/adoption/domain/application-rules";
import type { ApplicationInput } from "@/src/modules/adoption/domain/types";

/** A submission that both validators must accept, as the baseline to mutate. */
function validInput(): Record<string, unknown> {
  return {
    housingType: "casa_con_patio",
    motivation: "Quiero adoptar porque tengo tiempo y espacio para cuidarla todos los dias.",
    priorPets: "yes_before",
    otherPets: "Un gato de ocho anios.",
    dailyRoutine: "Trabajo desde casa.",
    notes: null,
    profileSharingConsent: true,
  };
}

/** The schema's verdict, as a boolean. */
function schemaAccepts(input: Record<string, unknown>): boolean {
  return adoptionApplicationInputSchema.safeParse(input).success;
}

/**
 * The domain's verdict over the FIELD rules only: a personal account with no
 * pending application, so the two server-only refusals cannot fire and the
 * verdict is about the fields alone.
 */
function domainAccepts(input: Record<string, unknown>): boolean {
  return validateApplicationInput(
    input as unknown as ApplicationInput,
    { accountType: "personal" },
    null,
  ).ok;
}

/** Every case below is run through both validators and compared. */
const CASES: ReadonlyArray<{ label: string; input: Record<string, unknown> }> = [
  { label: "a complete, ordinary submission", input: validInput() },
  {
    label: "a motivation one character under the minimum",
    input: { ...validInput(), motivation: "a".repeat(ADOPTION_MOTIVATION_MIN_LENGTH - 1) },
  },
  {
    label: "a motivation exactly at the minimum",
    input: { ...validInput(), motivation: "a".repeat(ADOPTION_MOTIVATION_MIN_LENGTH) },
  },
  {
    label: "a motivation that is long enough only because of whitespace",
    input: { ...validInput(), motivation: `${" ".repeat(40)}corto${" ".repeat(40)}` },
  },
  {
    label: "no motivation at all",
    input: { ...validInput(), motivation: undefined },
  },
  {
    label: "consent withheld",
    input: { ...validInput(), profileSharingConsent: false },
  },
  {
    label: "consent absent",
    input: { ...validInput(), profileSharingConsent: undefined },
  },
  {
    label: "prior-pets unanswered",
    input: { ...validInput(), priorPets: null },
  },
  {
    label: "prior-pets answered with a value nobody offers",
    input: { ...validInput(), priorPets: "maybe" },
  },
  {
    label: "a free-text answer one character over the cap",
    input: { ...validInput(), notes: "a".repeat(ADOPTION_TEXT_MAX_LENGTH + 1) },
  },
  {
    label: "a free-text answer exactly at the cap",
    input: { ...validInput(), notes: "a".repeat(ADOPTION_TEXT_MAX_LENGTH) },
  },
  {
    label: "a free-text answer over the cap only because of whitespace",
    input: {
      ...validInput(),
      notes: `   ${"a".repeat(ADOPTION_TEXT_MAX_LENGTH)}   `,
    },
  },
  {
    label: "the optional answers omitted entirely",
    input: {
      housingType: "departamento",
      motivation: "a".repeat(ADOPTION_MOTIVATION_MIN_LENGTH),
      priorPets: "no",
      profileSharingConsent: true,
    },
  },
];

describe("the apply form's local refusal matches the server's", () => {
  for (const { label, input } of CASES) {
    it(`agrees about ${label}`, () => {
      const schema = schemaAccepts(input);
      const domain = domainAccepts(input);
      expect(
        { case: label, schema, domain },
        "the contract schema and application-rules.ts disagree about this " +
          "submission — a stricter schema is a form that cannot be sent, a " +
          "looser one is a button that draws over a refusal",
      ).toEqual({ case: label, schema: domain, domain });
    });
  }

  it("agrees about the ordinary submission by ACCEPTING it, not by both refusing", () => {
    // NON-VACUITY. Every assertion above compares two booleans, so a schema and
    // a domain function that both rejected everything would pass all of them.
    expect(schemaAccepts(validInput())).toBe(true);
    expect(domainAccepts(validInput())).toBe(true);
  });

  it("refuses at least one case, so the comparison is not over a single verdict", () => {
    const refusals = CASES.filter(({ input }) => !schemaAccepts(input));
    expect(refusals.length).toBeGreaterThan(5);
  });
});

describe("the two rules only the server can check", () => {
  it("lets the schema accept an institutional applicant the domain refuses", () => {
    // The asymmetry, stated as a test rather than left to be discovered. A
    // client does not know its own account type is institutional at parse time
    // — `/api/v1/adoptions/{token}` reports it as `applyBlockedReason` so the
    // screen never draws the form — and the domain is what actually refuses.
    const input = validInput();
    expect(schemaAccepts(input)).toBe(true);
    expect(
      validateApplicationInput(
        input as unknown as ApplicationInput,
        { accountType: "institutional" },
        null,
      ).ok,
    ).toBe(false);
  });

  it("lets the schema accept a duplicate the domain refuses", () => {
    const input = validInput();
    expect(schemaAccepts(input)).toBe(true);
    expect(
      validateApplicationInput(input as unknown as ApplicationInput, { accountType: "personal" }, {
        id: "an-unresolved-application",
      } as never).ok,
    ).toBe(false);
  });
});
