// THE OUTPUT OF AN INPUT SCHEMA MUST BE A VALID INPUT TO IT — for every schema
// this package exports, not just the one that got caught.
//
// WHAT THIS FENCES, AND WHY IT IS A PACKAGE-LEVEL TEST
// ---------------------------------------------------------------------------
// A schema in `@dim/contract/input` is parsed TWICE: the client validates its
// draft locally, sends `parsed.data` as the request body, and the route parses
// that body with the same object. One verdict, reached twice. It holds only if
// everything a schema EMITS is something it ACCEPTS.
//
// It did not hold for `register-pet.ts` (35f6e9430): the optional helpers emitted
// `null` for a blank field and their input side was `.optional()`, which admits
// `undefined` and refuses `null`. Every optional filled in, it passed — which is
// why an emulator run never caught it and the PO's first real registration from
// the Play build answered 400 `invalid_request` with no field detail
// (2026-09-05). The fix was per-file and the class was not closed: `intake.ts`
// had thirteen of them plus an `ageCount` that emitted a NUMBER out of a
// string-only input, and `auth.ts`'s `returnTo` had one (A5-ciudadanas-11). All
// three were latent for the same accidental reason — their only consumers build
// the body from `FormData`, which omits a blank key rather than nulling it — and
// the next client to adopt "parse the draft, post the output" would have been the
// same 400 again.
//
// SO THE FENCE IS GENERIC, and deliberately needs no fixtures. A fixture table
// is a list of the schemas somebody remembered; this walks the schemas the index
// actually exports and probes every top-level field of each. A new input module
// is covered the day it is exported, by nobody's diligence.
//
// HOW THE PROBE WORKS
//   1. Collect every zod schema exported from `../index.ts`, descending through
//      unions into their member objects.
//   2. For each top-level field, feed it a handful of generic wire values
//      (absent, null, a string, a number, a boolean, …).
//   3. Every one the field ACCEPTS produces an output. Feed that output back in.
//      If the field refuses its own output, that is the defect — reported with
//      the schema, the field and the value that produced it.
//
// It cannot check object-level `.refine()`s or cross-field rules, and it does
// not try: those need a valid whole body, which is what the per-schema tests
// beside this file already build.

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import * as inputs from "../index.ts";

// ---------------------------------------------------------------------------
// Walking the exports
// ---------------------------------------------------------------------------

type AnySchema = z.ZodType<unknown, unknown>;

function isSchema(value: unknown): value is AnySchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse: unknown }).safeParse === "function"
  );
}

function schemaKind(schema: AnySchema): string {
  return (schema as unknown as { def?: { type?: string } }).def?.type ?? "unknown";
}

/**
 * The object schemas reachable from `schema`: itself if it is one, or the member
 * objects if it is a union (every command schema in this package is a
 * discriminated union of one object per command).
 */
function objectsWithin(schema: AnySchema): AnySchema[] {
  const kind = schemaKind(schema);
  if (kind === "object") return [schema];
  if (kind === "union") {
    const options = (schema as unknown as { options?: AnySchema[] }).options ?? [];
    return options.flatMap(objectsWithin);
  }
  return [];
}

/** Every exported schema, by its export name. */
const EXPORTED_SCHEMAS: Array<[string, AnySchema]> = (
  Object.entries(inputs) as Array<[string, unknown]>
)
  .filter((entry): entry is [string, AnySchema] => isSchema(entry[1]))
  .sort(([a], [b]) => a.localeCompare(b));

// ---------------------------------------------------------------------------
// The probe values
// ---------------------------------------------------------------------------
//
// Generic on purpose: a value a field REFUSES teaches this test nothing, and a
// value it accepts is a real wire shape whose output has to come back in. The
// list covers what `JSON.parse` can hand a field plus the two absent forms.

const PROBES: Array<[label: string, value: unknown]> = [
  ["absent", undefined],
  ["null", null],
  ["a blank string", ""],
  ["a padded string", "  texto  "],
  ["a digit string", "3"],
  ["a number", 3],
  ["a boolean", true],
  ["an array", []],
];

/** A field's output, described for a failure message without dumping an object. */
function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

type Violation = {
  schema: string;
  field: string;
  probe: string;
  emitted: string;
};

function violationsFor(name: string, schema: AnySchema): Violation[] {
  const found: Violation[] = [];
  for (const object of objectsWithin(schema)) {
    const shape = (object as unknown as { shape?: Record<string, AnySchema> }).shape ?? {};
    for (const [field, fieldSchema] of Object.entries(shape)) {
      for (const [probe, value] of PROBES) {
        const out = fieldSchema.safeParse(value);
        if (!out.success) continue;
        // A field that emits `undefined` for an absent value is an optional key,
        // not a transform: `{ key: undefined }` and `{}` are the same body once
        // `JSON.stringify` has run, so there is nothing to re-accept.
        if (out.data === undefined) continue;
        const again = fieldSchema.safeParse(out.data);
        if (again.success) continue;
        found.push({ schema: name, field, probe, emitted: describeValue(out.data) });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

describe("@dim/contract/input — every schema accepts its own output", () => {
  it.each(EXPORTED_SCHEMAS)("%s", (name, schema) => {
    const violations = violationsFor(name, schema);
    // The message carries the field and the value, because "round-trip failed"
    // on a schema with twenty optionals is a bug report nobody can act on.
    expect(
      violations.map((v) => `${v.schema}.${v.field}: ${v.probe} → ${v.emitted}, refused back`),
    ).toEqual([]);
  });
});

describe("@dim/contract/input — the fence is not vacuous", () => {
  // Three ways this test could pass while checking nothing: no schemas found, no
  // fields probed, or a probe set so narrow that nothing is ever accepted. Each
  // gets a floor.

  it("finds the package's exported schemas", () => {
    expect(EXPORTED_SCHEMAS.length).toBeGreaterThanOrEqual(20);
    // Named ones, so a refactor that stops exporting a schema fails here rather
    // than silently shrinking the fence.
    const names = EXPORTED_SCHEMAS.map(([n]) => n);
    expect(names).toContain("registerPetInputSchema");
    expect(names).toContain("createIntakeInputSchema");
    expect(names).toContain("loginInputSchema");
  });

  it("actually probes fields, and the probes are actually accepted", () => {
    let fields = 0;
    let accepted = 0;
    for (const [, schema] of EXPORTED_SCHEMAS) {
      for (const object of objectsWithin(schema)) {
        const shape = (object as unknown as { shape?: Record<string, AnySchema> }).shape ?? {};
        for (const [, fieldSchema] of Object.entries(shape)) {
          fields += 1;
          for (const [, value] of PROBES) {
            if (fieldSchema.safeParse(value).success) accepted += 1;
          }
        }
      }
    }
    expect(fields).toBeGreaterThanOrEqual(100);
    expect(accepted).toBeGreaterThanOrEqual(100);
  });

  it("catches the exact defect it was written for", async () => {
    // The `register-pet.ts` shape as it was before 35f6e9430: emits `null`,
    // refuses `null`. A synthetic schema rather than a historical import — the
    // point is that the WALKER sees it, and this is the smallest thing that
    // proves the walker is not returning an empty list for everything.
    const { z: zod } = await import("zod");
    const broken = zod.object({
      breed: zod
        .string()
        .trim()
        .optional()
        .transform((v) => (v ? v : null)),
    });
    const violations = violationsFor("broken", broken as unknown as AnySchema);
    expect(violations.map((v) => v.field)).toContain("breed");
  });
});
