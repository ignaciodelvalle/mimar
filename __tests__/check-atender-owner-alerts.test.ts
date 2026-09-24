// Unit tests for the walk-in owner-alert fence.
//
// The fence's whole value is that it FAILS when a writer forgets. A test that
// only proves the current tree is clean would pass even if the fence were
// `return []` — so every case here builds a synthetic module that SHOULD trip
// it, and the last case is the real repo.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  callsAny,
  checkAtenderOwnerAlerts,
  deriveWriterUseCases,
  extractExportedFunctions,
} from "@/scripts/check-atender-owner-alerts";
import { stripComments } from "@/scripts/check-scope-discipline";

const ACTIONS = "app/org/[orgToken]/atender/actions.ts";
const COMPLETION = "app/org/[orgToken]/atender/atender-signature-completion.ts";

const IMPORTS = `
import { createVaccination } from "@/src/modules/events/application/medical/vaccination-use-case";
import { createNote } from "@/src/modules/events/application/identity/note-use-case";
import { completeAtenderSignature } from "./atender-signature-completion";
`;

function goodWriter(name: string, useCase = "createVaccination"): string {
  return `
export async function ${name}(orgToken: string, publicToken: string) {
  const result = await ${useCase}({ pet }, { repo });
  return completeAtenderSignature({ orgToken, publicToken, eventId: result.value.eventId });
}
`;
}

function silentWriter(name: string, useCase = "createVaccination"): string {
  return `
export async function ${name}(orgToken: string, publicToken: string) {
  const result = await ${useCase}({ pet }, { repo });
  return { error: null, ok: true, redirectTo: "/somewhere" };
}
`;
}

/** Only surface file scanned for the receipt bypass; empty = nothing to flag. */
const CLEAN_SURFACE: Record<string, string> = {};

describe("check-atender-owner-alerts — derivation", () => {
  it("derives the writer set from the module's own events-application imports", () => {
    expect(deriveWriterUseCases(IMPORTS)).toEqual(["createNote", "createVaccination"]);
  });

  it("ignores imports from anywhere else, so unrelated helpers are not writers", () => {
    const src = `
import { parseDateInput } from "@/lib/utils/format";
import { resolveAtenderPet } from "./atender-access";
`;
    expect(deriveWriterUseCases(src)).toEqual([]);
  });

  it("extracts each exported async function with its own body", () => {
    const fns = extractExportedFunctions(goodWriter("a") + silentWriter("b"));
    expect(fns.map((f) => f.name)).toEqual(["a", "b"]);
    expect(fns[0].body).toContain("completeAtenderSignature(");
    expect(fns[1].body).not.toContain("completeAtenderSignature(");
  });

  // The docstring promises this fence catches a walk-in writer "whatever it is
  // named", and that a NEW writer enters scope "the moment it is written". Until
  // 2026-08-09 the header regex only matched `export async function NAME(`, so
  // the arrow-assignment form walked straight past the ONLY barrier behind the
  // walk-in mitigation. No live instance — closed before the eighth writer.
  it("extracts the arrow-assignment export form", () => {
    const src = `export const atenderArrowAction = async (orgToken, formData) => {
  await createNote({ pet });
};`;
    const fns = extractExportedFunctions(src);

    expect(fns.map((f) => f.name)).toEqual(["atenderArrowAction"]);
    expect(fns[0].body).toContain("createNote(");
  });

  it("extracts the arrow form with a type annotation", () => {
    const src = `export const atenderTypedAction: ActionFn = async (a, b) => {
  await createNote({ pet });
};`;

    expect(extractExportedFunctions(src).map((f) => f.name)).toEqual(["atenderTypedAction"]);
  });

  // The body scan used to take the first `{` after the header, which for a
  // destructured parameter list is the DESTRUCTURING OBJECT — yielding a
  // two-token "body" that contains no call at all, so the writer read as clean.
  it("takes the body, not the destructured parameter object", () => {
    const src = `export const atenderDestructuredAction = async ({ orgToken, publicToken }) => {
  await createNote({ pet });
};`;
    const [fn] = extractExportedFunctions(src);

    expect(fn.name).toBe("atenderDestructuredAction");
    expect(fn.body).toContain("createNote(");
    expect(fn.body).not.toContain("publicToken");
  });

  it("FAILS an arrow-form writer that never tells the owner", () => {
    const src = `${IMPORTS}
export const atenderArrowAction = async ({ orgToken }) => {
  await createNote({ pet });
};`;
    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(writerCount).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0].where).toBe(`${ACTIONS} › atenderArrowAction()`);
  });

  it("matches a use-case only as a CALL, not as a bare mention", () => {
    expect(callsAny("await createNote({ pet })", ["createNote"])).toBe(true);
    expect(callsAny("const x: typeof createNote = f;", ["createNote"])).toBe(false);
  });
});

describe("check-atender-owner-alerts — it fails when a writer stays silent", () => {
  it("passes a module whose every writer closes through completeAtenderSignature()", () => {
    const src =
      IMPORTS +
      goodWriter("atenderVaccinationAction") +
      goodWriter("atenderNoteAction", "createNote");
    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(violations).toEqual([]);
    expect(writerCount).toBe(2);
  });

  it("FAILS on writer #8 — the one added later that forgets the owner alert", () => {
    const src =
      IMPORTS +
      goodWriter("atenderVaccinationAction") +
      // Nothing about this function is registered anywhere. It is caught purely
      // because it calls a derived use-case. That IS the fail-closed property.
      silentWriter("atenderBrandNewThingAction", "createNote");

    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(writerCount).toBe(2);
    expect(violations).toHaveLength(1);
    expect(violations[0].where).toBe(`${ACTIONS} › atenderBrandNewThingAction()`);
    expect(violations[0].reason).toContain("completeAtenderSignature()");
  });

  it("does NOT flag a non-writer action (the code lookup writes no event)", () => {
    const lookup = `
export async function lookupAtenderPetAction(orgToken: string) {
  const access = await resolveAtenderPet(orgToken, code);
  return { error: null, ok: true, redirectTo: "/org/x/atender/y" };
}
`;
    const { violations, writerCount } = checkAtenderOwnerAlerts(
      { [ACTIONS]: IMPORTS + goodWriter("atenderVaccinationAction") + lookup },
      CLEAN_SURFACE,
    );

    expect(violations).toEqual([]);
    expect(writerCount).toBe(1);
  });

  it("FAILS on the bypass: a hand-rolled ?firmado=1 receipt outside the completion module", () => {
    const { violations } = checkAtenderOwnerAlerts(
      { [ACTIONS]: IMPORTS + goodWriter("atenderVaccinationAction") },
      { [ACTIONS]: "const r = `/org/${o}/atender/${p}?firmado=1`;" },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0].where).toBe(ACTIONS);
    expect(violations[0].reason).toContain("?firmado=1");
  });

  it("allows the receipt inside the completion module — the one place that alerts first", () => {
    const { violations } = checkAtenderOwnerAlerts(
      { [ACTIONS]: IMPORTS + goodWriter("atenderVaccinationAction") },
      { [COMPLETION]: "return `/org/${o}/atender/${p}?firmado=1`;" },
    );

    expect(violations).toEqual([]);
  });
});

describe("check-atender-owner-alerts — the fence itself must not fail open", () => {
  it("FAILS when the glob finds no action module at all (surface moved / renamed)", () => {
    const { violations } = checkAtenderOwnerAlerts({}, CLEAN_SURFACE);

    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("cannot pass vacuously");
  });

  it("FAILS when the derivation yields zero writers (import path refactored away)", () => {
    // Real writers, but imported from a path the fence no longer recognises.
    const src = `
import { createVaccination } from "@/src/modules/clinical/vaccination-use-case";
${silentWriter("atenderVaccinationAction")}
`;
    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(writerCount).toBe(0);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("derived ZERO clinical writers");
  });
});

// 2026-09-18. The body scan balanced the parameter list and then took the NEXT
// `{` — for a function with an inline object RETURN TYPE, that is the type's
// brace. It read ~45 characters of `{ error: string | null; redirectTo?: string }`
// as the body, found no call in it, and let a live writer through: the vet's
// close of a rabies observation. The walk is now check-authz-guards.ts's
// angle-aware phase machine, which fixed the same bug on 2026-08-06.
describe("check-atender-owner-alerts — the body behind the signature", () => {
  it("reads a function with an inline object return type to its REAL body", () => {
    const src = `export async function atenderCloseAction(
  orgToken: string,
): Promise<{ error: string | null; redirectTo?: string }> {
  await createNote({ pet });
  return { error: null };
}`;
    const [fn] = extractExportedFunctions(src);

    expect(fn.name).toBe("atenderCloseAction");
    expect(fn.body.startsWith("{\n  await createNote(")).toBe(true);
    expect(fn.body).not.toContain("redirectTo?: string");
  });

  it("FAILS a silent writer that hides behind an inline return type", () => {
    const src = `${IMPORTS}
export async function atenderCloseAction(
  orgToken: string,
): Promise<{ error: string | null; redirectTo?: string }> {
  await createNote({ pet });
  return { error: null, redirectTo: "/somewhere" };
}`;
    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(writerCount).toBe(1);
    expect(violations.map((v) => v.where)).toEqual([`${ACTIONS} › atenderCloseAction()`]);
  });

  it("does not take an arrow inside the annotation for a closing angle", () => {
    // The arrow comes BEFORE the object type on purpose: read as a closing
    // angle, its `>` drops the depth to zero and the TYPE's brace becomes the
    // body.
    const src = `export const atenderArrowAction = async (
  orgToken: string,
): Promise<(() => void) | { ok: boolean }> => {
  await createNote({ pet });
};`;
    const [fn] = extractExportedFunctions(src);

    expect(fn.name).toBe("atenderArrowAction");
    expect(fn.body.startsWith("{\n  await createNote(")).toBe(true);
  });

  it("extracts a generic signature, type parameters and all", () => {
    const src = `export async function atenderGenericAction<T extends { id: string }>(
  input: T,
): Promise<{ ok: boolean }> {
  await createNote(input);
  return { ok: true };
}`;
    const [fn] = extractExportedFunctions(src);

    expect(fn.name).toBe("atenderGenericAction");
    expect(fn.body.startsWith("{\n  await createNote(input)")).toBe(true);
  });
});

describe("check-atender-owner-alerts — surveillance writers are writers", () => {
  it("derives the surveillance use-cases a walk-in module imports", () => {
    const src = `
import { professionalCloseObservation } from "@/src/modules/surveillance/application/professional-close-observation";
import type { RabiesObservationOutcome } from "@/src/modules/surveillance/domain/rabies-observation";
`;
    expect(deriveWriterUseCases(src)).toEqual(["professionalCloseObservation"]);
  });

  it("FAILS a rabies close that never tells the owner", () => {
    const src = `
import { professionalCloseObservation } from "@/src/modules/surveillance/application/professional-close-observation";
export async function atenderCloseRabiesObservationAction(orgToken: string) {
  const result = await professionalCloseObservation({ pet }, { repo });
  return { error: null, redirectTo: "/org/x" };
}`;
    const { violations, writerCount } = checkAtenderOwnerAlerts({ [ACTIONS]: src }, CLEAN_SURFACE);

    expect(writerCount).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0].where).toBe(`${ACTIONS} › atenderCloseRabiesObservationAction()`);
  });
});

// The real module, which is the case the header of this file promises. Not a
// count of writers — that would pin a list — but the one writer this fence
// failed to see: it must be derived as a writer, and it must close through the
// completion.
describe("check-atender-owner-alerts — the real walk-in module", () => {
  it("sees the vet's rabies close as a writer that closes through completeAtenderSignature()", () => {
    const source = stripComments(readFileSync("app/org/[orgToken]/atender/actions.ts", "utf8"));
    const useCases = deriveWriterUseCases(source);
    const writers = extractExportedFunctions(source).filter((fn) => callsAny(fn.body, useCases));
    const close = writers.find((fn) => fn.name === "atenderCloseRabiesObservationAction");

    expect(close, "the rabies close is not derived as a walk-in writer").toBeDefined();
    expect(close?.body).toContain("professionalCloseObservation(");
    expect(close?.body).toContain("completeAtenderSignature(");
  });
});
