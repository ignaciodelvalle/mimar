// Upcaster coverage + golden fixture tests (R4 — operational hardening).
//
// Two concerns:
//
//   1. COVERAGE — every event type whose schema has `payload_version > 1` MUST
//      have at least one upcaster registered in lib/event-upcasters.ts. Adding a
//      new v(N+1) schema without a matching upcaster will fail CI here.
//
//   2. GOLDEN FIXTURES — for every registered upcaster, assert that a known old-
//      shape payload maps to the expected new-shape output. A change to an upcaster
//      that silently breaks historical rows is caught.
//
// How the coverage side works:
//   - PayloadSchemas lists every event type that has a schema.
//   - We parse a synthetic v1 payload through each schema with `payload_version: 1`
//     via safeParse (NOT validateEventPayload, which requires the LATEST version)
//     to find the schema's latest version literal.
//   - Any schema where `latest_version > 1` requires an upcaster. We compare
//     against registeredUpcasterTypes() from lib/event-upcasters.ts.
//
// Mirror style: vitest describe/it/expect, same as lib/event-schemas.test.ts and
// __tests__/event-upcasters.test.ts.

import { describe, expect, it } from "vitest";

import { PayloadSchemas } from "@/lib/events/event-schemas";
import { registeredUpcasterTypes, upcastPayload } from "@/lib/events/event-upcasters";

// ---------------------------------------------------------------------------
// Helper — extract the latest payload_version from a Zod schema's shape.
//
// Supports Zod v4's internal structure:
//   schema._def.shape.payload_version → { def: { type: 'default', innerType,
//                                                 defaultValue: N } }
//   innerType.def.type === 'literal', innerType.def.values === [N]
//
// Also handles schemas wrapped in ZodEffects (e.g. .refine) by unwrapping via
// the `schema` key on the outer def.
//
// Falls back to 1 if the version field cannot be read — safe because all v1
// schemas ARE version 1 by definition (any failure to introspect is conservative).
// ---------------------------------------------------------------------------
function latestVersionFromSchema(schema: unknown): number {
  if (!schema || typeof schema !== "object") return 1;

  // Unwrap ZodEffects / transforms by following .def.schema.
  // Zod v4: the outer def is at `.def` (not `._def`).
  type AnyDef = Record<string, unknown>;
  type AnySchema = { def?: AnyDef; _def?: AnyDef };

  let current: AnySchema = schema as AnySchema;
  for (let i = 0; i < 5; i++) {
    const d = current.def ?? current._def;
    if (!d) break;
    if (d.type === "effects" || d.type === "transform" || d.type === "refine") {
      const inner = d.schema ?? d.effect;
      if (inner && typeof inner === "object") {
        current = inner as AnySchema;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const def = (current.def ?? current._def) as AnyDef | undefined;
  if (!def || def.type !== "object") return 1;

  // The shape is a plain object in Zod v4 (not a function).
  const shape = def.shape as Record<string, AnySchema> | undefined;
  if (!shape || typeof shape !== "object") return 1;

  const pvField = shape.payload_version;
  if (!pvField || typeof pvField !== "object") return 1;

  // Unwrap ZodDefault: { def: { type: 'default', defaultValue: N, innerType } }
  const pvDef = (pvField.def ?? pvField._def) as AnyDef | undefined;
  if (!pvDef) return 1;

  // The defaultValue on the ZodDefault IS the version number.
  if (pvDef.type === "default" && typeof pvDef.defaultValue === "number") {
    return pvDef.defaultValue as number;
  }

  // Fallback: try to read literal values from the inner type.
  const innerType = pvDef.innerType as AnySchema | undefined;
  if (innerType) {
    const innerDef = (innerType.def ?? innerType._def) as AnyDef | undefined;
    if (innerDef?.type === "literal") {
      const values = innerDef.values;
      if (Array.isArray(values) && typeof values[0] === "number") return values[0];
      if (typeof values === "number") return values;
    }
  }

  return 1;
}

// ---------------------------------------------------------------------------
// R4 — Coverage: every versioned schema must have a registered upcaster
// ---------------------------------------------------------------------------

describe("upcaster coverage — every versioned schema must have a registered upcaster", () => {
  // Collect all event types that have a schema with payload_version > 1.
  // These are the types that NEED an upcaster path from v1 up to the latest.
  const versionedTypes = Object.entries(PayloadSchemas)
    .filter(([, schema]) => latestVersionFromSchema(schema) > 1)
    .map(([type]) => type);

  // The set of types that have at least one upcaster registered.
  const registeredTypes = new Set(registeredUpcasterTypes());

  it("finds at least one versioned schema (sanity check: adoption_application_submitted is v2)", () => {
    expect(versionedTypes).toContain("adoption_application_submitted");
    expect(versionedTypes.length).toBeGreaterThanOrEqual(1);
  });

  // This test is the regression gate. If a new event type bumps to v2 without
  // a registered upcaster, it FAILS CI here — the developer must add the
  // upcaster in the same PR that bumps the payload_version literal.
  it("every event type with payload_version > 1 has at least one upcaster registered", () => {
    const missing = versionedTypes.filter((t) => !registeredTypes.has(t as never));
    if (missing.length > 0) {
      throw new Error(
        `The following event types have payload_version > 1 but NO registered upcaster in lib/event-upcasters.ts:\n${missing.map((t) => `  - ${t}`).join("\n")}\n\nAdd the upcaster(s) to lib/event-upcasters.ts in the same PR that bumps the payload_version literal in lib/event-schemas.ts. See docs/superpowers/event-versioning.md for the step-by-step contract.`,
      );
    }
    expect(missing).toHaveLength(0);
  });

  // (test-suite audit 2026-07) The former "documents event types without a
  // schema" case was informational-only (a filter + toBeDefined() that could
  // never fail) — deleted. Schema coverage is enforced for real by
  // __tests__/event-schemas.test.ts "PayloadSchemas — coverage".
});

// ---------------------------------------------------------------------------
// R4 — Golden fixtures: upcaster shape contract
// Each registered upcaster must produce the expected output from a known input.
// A change that silently breaks the old-shape transformation FAILS here.
// ---------------------------------------------------------------------------

describe("golden fixtures — adoption_application_submitted v1 → v2", () => {
  // The canonical v1 shape: all fields present that existed before PR-14.
  // motivation and prior_pets are ABSENT (they were added in v2).
  const V1_CANONICAL: Record<string, unknown> = {
    payload_version: 1,
    applicant_user_id: "11111111-1111-4111-8111-111111111111",
    related_organization_id: "22222222-2222-4222-8222-222222222222",
    housing_type: "departamento",
    other_pets: null,
    daily_routine: "Trabajo desde casa, siempre estoy.",
    notes: "Tengo experiencia con perros grandes.",
    profile_sharing_consent_at: "2024-06-01T09:00:00.000Z",
    // motivation — absent in v1
    // prior_pets — absent in v1
  };

  const EXPECTED_V2: Record<string, unknown> = {
    ...V1_CANONICAL,
    payload_version: 2,
    motivation: null, // backfilled by upcaster
    prior_pets: null, // backfilled by upcaster
  };

  it("v1 payload upgrades to the exact v2 shape", () => {
    const result = upcastPayload("adoption_application_submitted", V1_CANONICAL) as Record<
      string,
      unknown
    >;

    expect(result).toEqual(EXPECTED_V2);
  });

  it("v1 payload: payload_version becomes 2", () => {
    const result = upcastPayload("adoption_application_submitted", V1_CANONICAL) as Record<
      string,
      unknown
    >;
    expect(result.payload_version).toBe(2);
  });

  it("v1 payload: motivation is null (not undefined)", () => {
    const result = upcastPayload("adoption_application_submitted", V1_CANONICAL) as Record<
      string,
      unknown
    >;
    expect(result.motivation).toBeNull();
    expect("motivation" in result).toBe(true);
  });

  it("v1 payload: prior_pets is null (not undefined)", () => {
    const result = upcastPayload("adoption_application_submitted", V1_CANONICAL) as Record<
      string,
      unknown
    >;
    expect(result.prior_pets).toBeNull();
    expect("prior_pets" in result).toBe(true);
  });

  it("v1 payload: all original fields are preserved unchanged", () => {
    const result = upcastPayload("adoption_application_submitted", V1_CANONICAL) as Record<
      string,
      unknown
    >;
    expect(result.applicant_user_id).toBe(V1_CANONICAL.applicant_user_id);
    expect(result.related_organization_id).toBe(V1_CANONICAL.related_organization_id);
    expect(result.housing_type).toBe(V1_CANONICAL.housing_type);
    expect(result.other_pets).toBeNull();
    expect(result.daily_routine).toBe(V1_CANONICAL.daily_routine);
    expect(result.notes).toBe(V1_CANONICAL.notes);
    expect(result.profile_sharing_consent_at).toBe(V1_CANONICAL.profile_sharing_consent_at);
  });

  it("v2 payload with explicit motivation and prior_pets is NOT re-processed", () => {
    const v2Input: Record<string, unknown> = {
      ...V1_CANONICAL,
      payload_version: 2,
      motivation: "Quiero darle un hogar estable.",
      prior_pets: "yes_before",
    };
    const result = upcastPayload("adoption_application_submitted", v2Input) as Record<
      string,
      unknown
    >;
    // Should come back identical — no second pass
    expect(result.payload_version).toBe(2);
    expect(result.motivation).toBe("Quiero darle un hogar estable.");
    expect(result.prior_pets).toBe("yes_before");
  });

  it("payload without payload_version is treated as v1 and upcast to v2", () => {
    const noVersionPayload = { ...V1_CANONICAL };
    // biome-ignore lint/performance/noDelete: intentional — simulating a pre-migration row
    delete (noVersionPayload as Partial<typeof noVersionPayload>).payload_version;

    const result = upcastPayload("adoption_application_submitted", noVersionPayload) as Record<
      string,
      unknown
    >;
    expect(result.payload_version).toBe(2);
    expect(result.motivation).toBeNull();
    expect(result.prior_pets).toBeNull();
  });

  it("edge case: existing motivation value is preserved (v1 row with motivation pre-set)", () => {
    // Some rows MAY have been written before strict schema validation;
    // the upcaster uses ?? null so an existing truthy value is preserved.
    const v1WithMotivation: Record<string, unknown> = {
      ...V1_CANONICAL,
      payload_version: 1,
      motivation: "Ya tenía esto guardado.",
    };
    const result = upcastPayload("adoption_application_submitted", v1WithMotivation) as Record<
      string,
      unknown
    >;
    expect(result.motivation).toBe("Ya tenía esto guardado.");
  });
});
