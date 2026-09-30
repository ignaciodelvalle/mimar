// condition_at_intake_recorded — the payload contract, the form parser, and
// where the type is (and is not) allowed to appear (vet-visit-record).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INTAKE_VITAL_BOUNDS, validateEventPayload } from "@/lib/events/event-schemas";
import { isAmendableEventType } from "@/lib/infra/amendment";
import { LIBRETA_SANITARIA_EVENT_TYPES } from "@/lib/infra/libreta-sanitaria";

import { parseConditionAtIntakeForm } from "./condition-at-intake-form";

const T = "condition_at_intake_recorded" as const;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    modality: "clinic",
    general_condition: "good",
    presenting_complaint: "Vómitos desde ayer",
    findings: null,
    ...overrides,
  };
}

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("condition_at_intake_recorded — zod schema", () => {
  it("accepts a minimal intake and stamps payload_version 1", () => {
    expect(validateEventPayload(T, payload())).toMatchObject({
      payload_version: 1,
      modality: "clinic",
    });
  });

  it("accepts a full intake with every vital", () => {
    const full = payload({
      modality: "home",
      general_condition: "critical",
      findings: "Mucosas pálidas, TRC 3 s",
      vitals: {
        temperature_c: 39.4,
        heart_rate_bpm: 180,
        respiratory_rate_rpm: 40,
        body_condition_score: 3,
        hydration: "moderate",
        mucous_membranes: "pale",
      },
    });
    expect(() => validateEventPayload(T, full)).not.toThrow();
  });

  it("is STRICT at the top level and inside vitals", () => {
    expect(() => validateEventPayload(T, payload({ weight_kg: "10.00" }))).toThrow();
    expect(() =>
      validateEventPayload(T, payload({ vitals: { temperature_c: 38, pulse: 90 } })),
    ).toThrow();
  });

  it("refuses an unknown general condition or modality", () => {
    expect(() => validateEventPayload(T, payload({ general_condition: "bueno" }))).toThrow();
    expect(() => validateEventPayload(T, payload({ modality: "remote" }))).toThrow();
  });

  it("holds every vital to its bounds, and the integer vitals to integers", () => {
    for (const [key, { min, max }] of Object.entries(INTAKE_VITAL_BOUNDS)) {
      expect(() => validateEventPayload(T, payload({ vitals: { [key]: min } })), key).not.toThrow();
      expect(() => validateEventPayload(T, payload({ vitals: { [key]: max } })), key).not.toThrow();
      expect(() => validateEventPayload(T, payload({ vitals: { [key]: min - 1 } })), key).toThrow();
      expect(() => validateEventPayload(T, payload({ vitals: { [key]: max + 1 } })), key).toThrow();
    }
    expect(() => validateEventPayload(T, payload({ vitals: { heart_rate_bpm: 90.5 } }))).toThrow();
    expect(() =>
      validateEventPayload(T, payload({ vitals: { temperature_c: 38.7 } })),
    ).not.toThrow();
  });

  it("refuses an empty vitals object and over-long prose", () => {
    expect(() => validateEventPayload(T, payload({ vitals: {} }))).toThrow();
    expect(() =>
      validateEventPayload(T, payload({ presenting_complaint: "x".repeat(501) })),
    ).toThrow();
    expect(() => validateEventPayload(T, payload({ findings: "x".repeat(2001) }))).toThrow();
  });
});

describe("parseConditionAtIntakeForm", () => {
  it("parses a full form, with es-AR decimal commas", () => {
    const parsed = parseConditionAtIntakeForm(
      form({
        generalCondition: "fair",
        presentingComplaint: "  Tos  ",
        findings: "Soplo grado II",
        temperatureC: "38,9",
        heartRateBpm: "120",
        respiratoryRateRpm: "30",
        bodyConditionScore: "5",
        hydration: "normal",
        mucousMembranes: "pink",
        weightKg: "12,5",
        clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        generalCondition: "fair",
        presentingComplaint: "Tos",
        findings: "Soplo grado II",
        vitals: {
          temperature_c: 38.9,
          heart_rate_bpm: 120,
          respiratory_rate_rpm: 30,
          body_condition_score: 5,
          hydration: "normal",
          mucous_membranes: "pink",
        },
        weightKg: "12.50",
        clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  it("omits vitals and weight when none were entered", () => {
    const parsed = parseConditionAtIntakeForm(form({ generalCondition: "good" }));
    expect(parsed).toMatchObject({
      ok: true,
      value: { vitals: null, weightKg: null, presentingComplaint: null, findings: null },
    });
  });

  it("requires a general condition", () => {
    expect(parseConditionAtIntakeForm(form({}))).toEqual({
      ok: false,
      error: "Elegí el estado general del animal al ingreso.",
    });
    expect(parseConditionAtIntakeForm(form({ generalCondition: "bueno" })).ok).toBe(false);
  });

  it("refuses out-of-range and non-integer vitals with a sentence about the field", () => {
    const hot = parseConditionAtIntakeForm(form({ generalCondition: "good", temperatureC: "385" }));
    expect(hot).toEqual({ ok: false, error: "Temperatura: tiene que estar entre 30 y 45 °C." });
    const frac = parseConditionAtIntakeForm(
      form({ generalCondition: "good", heartRateBpm: "90,5" }),
    );
    expect(frac.ok).toBe(false);
    if (!frac.ok) expect(frac.error).toMatch(/^Frecuencia cardíaca: ingresá un número entero/);
    const text = parseConditionAtIntakeForm(
      form({ generalCondition: "good", bodyConditionScore: "5/9" }),
    );
    expect(text.ok).toBe(false);
  });

  it("refuses an unknown hydration or mucosa code, and an impossible weight", () => {
    expect(parseConditionAtIntakeForm(form({ generalCondition: "good", hydration: "x" })).ok).toBe(
      false,
    );
    expect(
      parseConditionAtIntakeForm(form({ generalCondition: "good", mucousMembranes: "x" })).ok,
    ).toBe(false);
    expect(parseConditionAtIntakeForm(form({ generalCondition: "good", weightKg: "0" })).ok).toBe(
      false,
    );
    expect(parseConditionAtIntakeForm(form({ generalCondition: "good", weightKg: "500" })).ok).toBe(
      false,
    );
  });

  // Suggestion from the verify report: client_idempotency_key is a Postgres
  // `uuid` column, so a malformed value must be refused HERE with a sentence,
  // never reach the insert as a raw "invalid input syntax for type uuid".
  it("refuses a malformed clientIdempotencyKey with a sentence, not a raw DB error", () => {
    const malformed = parseConditionAtIntakeForm(
      form({ generalCondition: "good", clientIdempotencyKey: "not-a-uuid" }),
    );
    expect(malformed).toEqual({
      ok: false,
      error: "Identificador de envío inválido. Volvé a intentar.",
    });
  });

  it("accepts a well-formed clientIdempotencyKey and omits it when absent", () => {
    const withKey = parseConditionAtIntakeForm(
      form({
        generalCondition: "good",
        clientIdempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(withKey).toMatchObject({
      ok: true,
      value: { clientIdempotencyKey: "11111111-1111-4111-8111-111111111111" },
    });
    const withoutKey = parseConditionAtIntakeForm(form({ generalCondition: "good" }));
    expect(withoutKey).toMatchObject({ ok: true, value: { clientIdempotencyKey: null } });
  });

  it("every parsed form validates against the schema (the two agree)", () => {
    const parsed = parseConditionAtIntakeForm(
      form({ generalCondition: "poor", temperatureC: "45", heartRateBpm: "20" }),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(() =>
      validateEventPayload(T, {
        modality: "clinic",
        general_condition: parsed.value.generalCondition,
        presenting_complaint: parsed.value.presentingComplaint,
        vitals: parsed.value.vitals ?? undefined,
        findings: parsed.value.findings,
      }),
    ).not.toThrow();
  });
});

describe("where the type lives", () => {
  it("is part of the libreta sanitaria (owner + org audience)", () => {
    expect(LIBRETA_SANITARIA_EVENT_TYPES).toContain(T);
  });

  it("is on the amendment allowlist (corrections are event_amended, never edits)", () => {
    expect(isAmendableEventType(T)).toBe(true);
  });

  it("never appears in the public credential's source (it queries explicit types)", () => {
    const root = join(process.cwd(), "app", "(public)");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && readFileSync(p, "utf8").includes(T)) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
    // Non-vacuity: the walk really reads the credential page's event query.
    const credential = readFileSync(
      join(root, "p", "[publicToken]", "CredentialStreamedSections.tsx"),
      "utf8",
    );
    expect(credential).toContain("vaccination_administered");
  });
});
