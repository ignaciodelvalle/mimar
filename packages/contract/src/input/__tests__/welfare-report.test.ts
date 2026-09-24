// What a client may send to `POST /api/v1/welfare-reports`.
//
// TWO THINGS ARE WORTH TESTING HERE AND THE REST IS THE COMPILER'S
// ---------------------------------------------------------------------------
//   1. THE ANONYMOUS MEMBER HAS NOWHERE TO PUT A CONTACT. That is the property
//      the whole lane exists for, it is claimed by a SHAPE, and a shape claim is
//      exactly the kind that survives an edit which breaks it. There is a
//      compile-time proof in the module (`AnonymousCarriesNoContact`); this is
//      the runtime half, which answers a different question — not "does the type
//      have the field" but "does a body carrying one get it stripped".
//   2. `firstWelfareReportInputCode` CAN ACTUALLY RETURN A FIELD CODE on a body
//      whose issues zod NESTED. The top-level `z.union` reports one
//      `invalid_union` with the per-field messages inside `errors` — but only
//      when more than one member complains; a body that fails exactly one member
//      comes back hoisted. Both shapes exist on this schema and the first
//      version of the test below only exercised the hoisted one, which is how a
//      fence that could not fail got written. It is pinned on the nested body
//      now, with a non-vacuity assertion that the issue really is nested.
//
//      The walk's LIMIT is pinned too, in its own test: on a nested body it
//      yields the first MEMBER's complaint, which for a `file` body is
//      `resolve_location`'s. That is why a client parses the member it sends.
//
// The vocabularies themselves are pinned elsewhere and deliberately not here:
// `__tests__/welfare-report-kind-catalog.test.ts` (in the web app, which can
// import `db/schema.ts`) holds the nine kinds against the PostgreSQL enum. A
// second list in this file would be a fifth copy of the thing that fence exists
// to keep at one.

import { describe, expect, it } from "vitest";

import {
  WELFARE_DESCRIPTION_MIN_LENGTH,
  WELFARE_REPORT_CITIZEN_SEVERITIES,
  WELFARE_REPORT_SUBJECT_KINDS,
  firstWelfareReportInputCode,
  welfareReportCommandInputSchema,
  welfareReportFileInputSchema,
} from "../index.ts";

const FACTS = {
  command: "file" as const,
  kind: "physical_abuse",
  severity: "critical",
  description: "Vi al perro atado al sol sin agua y con golpes visibles en el lomo.",
  subjectKind: "unowned_animal",
  subjectDescription: "Perro mestizo marrón, atado en el fondo de una casa.",
  locationLat: -41.135,
  locationLng: -71.3103,
  locationAddress: "Av. Bustillo 1200",
};

/** The code a failed parse of the FILE member yields. */
function fileCode(body: unknown): string | null {
  const parsed = welfareReportFileInputSchema.safeParse(body);
  if (parsed.success) return null;
  return firstWelfareReportInputCode(parsed.error);
}

describe("the anonymous member has nowhere to put an identity", () => {
  it("strips a contact sent alongside `contactMode: anonymous`", () => {
    // THE MUTATION: give the anonymous member `reporterContactEmail` /
    // `reporterContactPhone`. Applied: this fails AND `tsc` fails on
    // `AnonymousCarriesNoContact`, which is the fence for the type half.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "anonymous",
      reporterContactEmail: "vecina@example.com",
      reporterContactPhone: "+54 294 4123456",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).not.toHaveProperty("reporterContactEmail");
    expect(parsed.data).not.toHaveProperty("reporterContactPhone");
    expect(JSON.stringify(parsed.data)).not.toContain("vecina@example.com");
  });

  it("keeps the contact on a `with_contact` submission", () => {
    // NON-VACUITY for the assertion above: a schema that stripped BOTH members'
    // contact fields would satisfy it and be useless.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "with_contact",
      reporterContactEmail: "vecina@example.com",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ reporterContactEmail: "vecina@example.com" });
  });

  it("refuses a `with_contact` submission with no channel at all", () => {
    expect(fileCode({ ...FACTS, contactMode: "with_contact" })).toBe("CONTACT_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // A5-ciudadanas-01 — A BLANK E-MAIL BOX IS NOT A MALFORMED ADDRESS
  // -------------------------------------------------------------------------
  it("accepts a phone-only submission whose e-mail box was left empty", () => {
    // What a form sends for a box nobody typed in is `""`, and `z.email()` ran
    // before `.nullable()` could help — so "dejo mi teléfono" answered
    // CONTACT_REQUIRED pointing at the e-mail field, and the at-least-one rule
    // below it never ran. The whole contact path was unsendable that way.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "with_contact",
      reporterContactEmail: "",
      reporterContactPhone: "11 5555 4444",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      reporterContactEmail: null,
      reporterContactPhone: "11 5555 4444",
    });
  });

  it("accepts a phone-only submission whose e-mail key is ABSENT, not blank", () => {
    // THE SHAPE THE NATIVE CLIENT ACTUALLY SENDS, and the one the `""` tests
    // above cannot speak for. `buildWelfareReportDraft` spreads the key in only
    // when the box is non-empty (`denuncia-view-model.ts:270-271`), so a
    // phone-only denuncia arrives with NO `reporterContactEmail` key at all —
    // `undefined`, which travels a different path through
    // `.optional().transform().pipe()` than `""` does.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "with_contact",
      reporterContactPhone: "11 5555 4444",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      reporterContactEmail: null,
      reporterContactPhone: "11 5555 4444",
    });
  });

  it("still refuses a REAL malformed address on that field", () => {
    // The control: normalising the blank must not turn the check off.
    expect(
      fileCode({
        ...FACTS,
        contactMode: "with_contact",
        reporterContactEmail: "no-es-un-mail",
      }),
    ).toBe("CONTACT_REQUIRED");
  });

  it("still refuses two blank contact boxes", () => {
    // The second control: `""` becoming `null` must not satisfy the
    // at-least-one rule by accident.
    expect(
      fileCode({
        ...FACTS,
        contactMode: "with_contact",
        reporterContactEmail: "",
        reporterContactPhone: "",
      }),
    ).toBe("CONTACT_REQUIRED");
  });
});

describe("firstWelfareReportInputCode names the field that failed", () => {
  it("reaches a code NESTED inside a union's issue tree", () => {
    // THE BODY MATTERS AND THE FIRST VERSION OF THIS TEST HAD THE WRONG ONE.
    // zod HOISTS the single-member case: `description: "corto"` fails only the
    // `file` member, so its issues arrive on `error.issues` directly and the
    // assertion passed with `flattenIssues` deleted — a fence that could not
    // fail, measured by applying the mutation and watching it stay green.
    //
    // A body with NO COORDINATES fails BOTH members (the `resolve_location`
    // member objects to the missing `addressText`), which is the shape that
    // produces `{ code: "invalid_union", errors: [[…], […]] }` and the shape the
    // walk exists for.
    //
    // THE MUTATION: replace `flattenIssues(error.issues)` with `error.issues`.
    // Applied: this fails — the answer degrades to `CONTACT_MODE_REQUIRED`.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "anonymous",
      locationLat: undefined,
      locationLng: undefined,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    // NON-VACUITY: the issue really is nested, or this test is about nothing.
    expect(parsed.error.issues[0]?.code).toBe("invalid_union");
    expect(firstWelfareReportInputCode(parsed.error)).not.toBe("CONTACT_MODE_REQUIRED");
  });

  it("yields the FIRST member's complaint on a nested body, which is why a client parses the member", () => {
    // THE LIMIT OF THE WALK, pinned rather than left as prose. On a `file` body
    // that fails both members, the flattened order puts `resolve_location`'s
    // `ADDRESS_REQUIRED` first — a real code about a field the caller never
    // meant to send. That is better than the fallback and it is not right, and
    // the fix is not here: a client parses `welfareReportFileInputSchema`, which
    // narrows and answers `COORDS_REQUIRED`.
    //
    // If this ever changes — a zod version that orders differently, a member
    // added — this test is where somebody finds out, instead of a screen quietly
    // telling people to fill in an address they already filled in.
    const viaUnion = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "anonymous",
      locationLat: undefined,
      locationLng: undefined,
    });
    expect(viaUnion.success).toBe(false);
    if (viaUnion.success) return;
    expect(firstWelfareReportInputCode(viaUnion.error)).toBe("ADDRESS_REQUIRED");

    // …and the member the client actually sends answers about the right field.
    expect(
      fileCode({
        ...FACTS,
        contactMode: "anonymous",
        locationLat: undefined,
        locationLng: undefined,
      }),
    ).toBe("COORDS_REQUIRED");
  });

  it("names the description floor, the point, the severity and the subject", () => {
    expect(fileCode({ ...FACTS, contactMode: "anonymous", description: "corto" })).toBe(
      "DESCRIPTION_TOO_SHORT",
    );
    expect(
      fileCode({
        ...FACTS,
        contactMode: "anonymous",
        locationLat: undefined,
        locationLng: undefined,
      }),
    ).toBe("COORDS_REQUIRED");
    expect(fileCode({ ...FACTS, contactMode: "anonymous", locationLat: 999 })).toBe(
      "COORDS_OUT_OF_RANGE",
    );
    expect(fileCode({ ...FACTS, contactMode: "anonymous", severity: "high" })).toBe(
      "SEVERITY_REQUIRED",
    );
    expect(fileCode({ ...FACTS, contactMode: "anonymous", subjectKind: "registered_pet" })).toBe(
      "SUBJECT_KIND_REQUIRED",
    );
  });

  it("answers CONTACT_MODE_REQUIRED only when the mode really is the problem", () => {
    // The fallback must still work — it is what a body with no `contactMode` at
    // all gets — and it must no longer be the answer to everything.
    expect(fileCode({ ...FACTS })).toBe("CONTACT_MODE_REQUIRED");
  });
});

describe("the narrowings this door makes on purpose", () => {
  it("refuses `high`, the severity no citizen wizard can produce", () => {
    // The column holds four; `Step2Severity.tsx` can produce three. This door is
    // the citizen wizard, so it accepts the three.
    expect([...WELFARE_REPORT_CITIZEN_SEVERITIES]).toEqual(["low", "medium", "critical"]);
    expect(fileCode({ ...FACTS, contactMode: "anonymous", severity: "high" })).toBe(
      "SEVERITY_REQUIRED",
    );
  });

  it("refuses `registered_pet`, so no public token can aim a denuncia at a pet", () => {
    expect([...WELFARE_REPORT_SUBJECT_KINDS]).toEqual(["unowned_animal", "location", "general"]);
  });

  it("drops a `subjectPetToken` a client sends anyway", () => {
    // Belt to the braces: the field is not in any member, so it is stripped
    // rather than merely unused. A token that never reaches the server cannot be
    // put into a `where` by a later edit.
    const parsed = welfareReportCommandInputSchema.safeParse({
      ...FACTS,
      contactMode: "anonymous",
      subjectPetToken: "DIM-PAMP-0001",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(JSON.stringify(parsed.data)).not.toContain("DIM-PAMP-0001");
  });

  it("holds the description floor at the number the web's own action enforces", () => {
    expect(WELFARE_DESCRIPTION_MIN_LENGTH).toBe(20);
    const justUnder = "x".repeat(WELFARE_DESCRIPTION_MIN_LENGTH - 1);
    const justOver = "x".repeat(WELFARE_DESCRIPTION_MIN_LENGTH);
    expect(fileCode({ ...FACTS, contactMode: "anonymous", description: justUnder })).toBe(
      "DESCRIPTION_TOO_SHORT",
    );
    expect(fileCode({ ...FACTS, contactMode: "anonymous", description: justOver })).toBeNull();
  });
});
