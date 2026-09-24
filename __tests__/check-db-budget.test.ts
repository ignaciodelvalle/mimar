/**
 * Unit tests for scripts/check-db-budget.ts helpers.
 *
 * Pure fixture tests (no filesystem I/O) plus integration assertions that the
 * REAL heavy call sites in the repo are all budgeted — so the guard is proven to
 * pass on the current tree, not just on fixtures.
 *
 * The fixtures below encode the 2026-08-09 hardening (S8). Before it, the check
 * was `src.includes(wrapper)`: a substring, satisfied by a mention in a comment
 * or by a dead import. Several cases here assert that those NO LONGER pass —
 * they are the regression tests for a fence that used to certify a property it
 * did not check.
 */

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BUDGET_WRAPPERS,
  DELEGATING_ROUTES,
  FANOUT_THRESHOLD,
  delegationLinkProblems,
  delegationViolations,
  discoverFanOuts,
  listBudgetTargets,
  missingRegisteredPages,
  readBaseline,
  referencesBudgetWrapper,
  scanAll,
  stripNonCode,
  widestFanOut,
} from "../scripts/check-db-budget";

describe("referencesBudgetWrapper — accepts real call sites", () => {
  it("accepts a direct withDbBudget call", () => {
    expect(referencesBudgetWrapper('const x = await withDbBudget(p, 8000, "l", f);')).toBe(true);
  });

  it("accepts loadWithTimeout (the dashboard deadline wrapper)", () => {
    expect(
      referencesBudgetWrapper("const load = await loadWithTimeout(Promise.all([a, b]));"),
    ).toBe(true);
  });

  it("accepts a call carrying an explicit type argument list", () => {
    // Two registered modules write it this way; matching only `name(` rejected
    // them and produced a false build failure.
    expect(
      referencesBudgetWrapper(
        "return withDbBudget<WorklistItem[] | null>(promise, MS, label, null)",
      ),
    ).toBe(true);
  });

  it("accepts the loadLayerFeaturesCachedWithMeta variant via the identifier prefix", () => {
    expect(referencesBudgetWrapper("await loadLayerFeaturesCachedWithMeta(layer, opts)")).toBe(
      true,
    );
  });
});

describe("referencesBudgetWrapper — rejects what only LOOKS budgeted (S8)", () => {
  it("rejects a raw unbudgeted DB fan-out", () => {
    expect(
      referencesBudgetWrapper("const rows = await Promise.all([db.select()..., analyticsDb...]);"),
    ).toBe(false);
  });

  it("rejects a wrapper named only in a line comment", () => {
    // THE regression: app/gob/perdidas/page.tsx passed on exactly this shape
    // while it still had an unbounded await outside its budgeted block.
    expect(referencesBudgetWrapper("// bounded with loadWithTimeout\nawait db.select();")).toBe(
      false,
    );
  });

  it("rejects a wrapper named only in a block comment", () => {
    expect(
      referencesBudgetWrapper(
        "/* Budget wrapper: withDbBudget via sections */\nawait db.select();",
      ),
    ).toBe(false);
  });

  it("rejects an import that nothing calls", () => {
    expect(referencesBudgetWrapper("import { loadCachedPanoramaKpis } from '@/lib/x';")).toBe(
      false,
    );
  });

  it("rejects a wrapper name that only appears inside a string literal", () => {
    expect(referencesBudgetWrapper('const label = "loadWithTimeout(x)";')).toBe(false);
  });
});

describe("stripNonCode", () => {
  it("keeps code that follows a URL on the same line", () => {
    // A naive `//`-stripping regex eats the rest of any line holding a URL,
    // which would delete real call sites and fail the build for no reason.
    const src = 'const u = "https://mimar.ar"; await loadWithTimeout(p);';
    expect(stripNonCode(src)).toContain("loadWithTimeout(p)");
  });

  it("keeps the code inside a template literal's ${…}", () => {
    expect(stripNonCode("`x ${loadWithTimeout(p)} y`")).toContain("loadWithTimeout(p)");
  });
});

describe("widestFanOut", () => {
  it("counts top-level elements of a Promise.all array", () => {
    expect(widestFanOut("await Promise.all([a(), b(), c(), d()])")).toBe(4);
  });

  it("does not let nested calls or arrays inflate the count", () => {
    expect(widestFanOut("await Promise.all([f(a, b, c), g([1, 2, 3])])")).toBe(2);
  });

  it("tolerates a trailing comma", () => {
    expect(widestFanOut("await Promise.all([a(), b(),])")).toBe(2);
  });

  it("scores a mapped Promise.all as 0 (not an array literal)", () => {
    expect(widestFanOut("await Promise.all(items.map(f))")).toBe(0);
  });

  it("returns 0 when there is no Promise.all", () => {
    expect(widestFanOut("const x = 1;")).toBe(0);
  });
});

describe("real repo tree", () => {
  it("finds the known heavy call sites (routes + dashboard pages)", () => {
    const targets = listBudgetTargets();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets).toContain("app/api/panorama/kpis/route.ts");
    expect(targets).toContain("app/admin/programa/page.tsx");
  });

  it("has no registered path that has gone missing from disk", () => {
    // Hole #2: a renamed path used to fall out of the scan in silence.
    expect(missingRegisteredPages()).toEqual([]);
  });

  it("has ZERO unbudgeted registered call sites (the guard passes on HEAD)", () => {
    expect(scanAll()).toEqual([]);
  });

  it("has ZERO undiscovered heavy fan-outs outside the baseline", () => {
    const baseline = new Set(readBaseline());
    expect(discoverFanOuts().filter((d) => !baseline.has(d.file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DELEGATING_ROUTES — the exemption lane, and the reason it is not a hole
// ---------------------------------------------------------------------------
//
// The 2026-08-21 review proved the hole with a fixture: pointing a delegation
// entry at `app/api/panorama/[layer]/route.ts` — a route that has never heard
// of `lookupPublicCredential` — produced ZERO violations and the runner printed
// "2 delegating route(s) name a budgeted owner that really is budgeted". The
// check verified that the OWNER was budgeted and never that the route reached
// it, which is the "someone else handled it" exemption this repo keeps finding
// to be false. The controls below are that fixture, kept.

/** A reason long enough to clear the prose-length check, so it cannot be why a case fails. */
const LONG_ENOUGH_REASON =
  "RED CONTROL — eighty characters of prose was the entire bar the old check set for an exemption, so this string clears it deliberately.";

const CREDENTIAL_ROUTE = "app/api/v1/pets/[publicToken]/credential/route.ts";
const CREDENTIAL_DOOR = "src/modules/pets/application/read/lookup-public-credential.ts";

describe("DELEGATING_ROUTES — the exemption must be a link that is really followed", () => {
  it("rejects a route that names a budgeted owner it never imports", () => {
    const problems = delegationViolations({
      "app/api/panorama/[layer]/route.ts": {
        reason: LONG_ENOUGH_REASON,
        budgetedBy: [CREDENTIAL_DOOR],
      },
    });
    expect(problems.join("\n")).toContain("never imports");
  });

  it("rejects a route that imports the owner but never calls it", () => {
    // Hole #1 of the 2026-08-09 hardening, one level up: an import that nothing
    // calls proves nothing. A route that merely mentions its door in an import
    // list has not delegated anything to it.
    const problems = delegationLinkProblems(
      CREDENTIAL_ROUTE,
      `import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
       export async function GET() {
         return Response.json({ ok: true });
       }`,
      [CREDENTIAL_DOOR],
    );
    expect(problems.join("\n")).toContain("never calls");
  });

  it("rejects an owner named only inside a string literal", () => {
    const problems = delegationLinkProblems(
      CREDENTIAL_ROUTE,
      `import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
       const label = "lookupPublicCredential(x)";`,
      [CREDENTIAL_DOOR],
    );
    expect(problems.join("\n")).toContain("never calls");
  });

  it("accepts an import that IS called — the two rejections above are not vacuous", () => {
    expect(
      delegationLinkProblems(
        CREDENTIAL_ROUTE,
        `import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
         export async function GET() {
           return Response.json(await lookupPublicCredential({ publicToken: "x" }));
         }`,
        [CREDENTIAL_DOOR],
      ),
    ).toEqual([]);
  });

  it("accepts the real credential route against its real owners", () => {
    const { budgetedBy } = DELEGATING_ROUTES[CREDENTIAL_ROUTE];
    expect(
      delegationLinkProblems(CREDENTIAL_ROUTE, readFileSync(CREDENTIAL_ROUTE, "utf8"), budgetedBy),
    ).toEqual([]);
  });

  it("is NON-VACUOUS: the real map has entries and every one of them resolves", () => {
    // A check whose input is empty passes for the wrong reason. The map must
    // hold something, and each entry must name files that exist — otherwise the
    // clean verdict above is measuring nothing.
    const entries = Object.entries(DELEGATING_ROUTES);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const [route, { budgetedBy }] of entries) {
      expect(existsSync(route)).toBe(true);
      expect(budgetedBy.length).toBeGreaterThanOrEqual(1);
      for (const owner of budgetedBy) expect(existsSync(owner)).toBe(true);
    }
  });

  it("has ZERO broken delegation claims on HEAD (the guard passes)", () => {
    expect(delegationViolations()).toEqual([]);
  });
});

describe("BUDGET_WRAPPERS", () => {
  it("includes the two budget primitives", () => {
    expect(BUDGET_WRAPPERS).toContain("withDbBudget");
    expect(BUDGET_WRAPPERS).toContain("loadWithTimeout");
  });
});

describe("FANOUT_THRESHOLD", () => {
  it("is low enough to catch a dashboard-shaped fan-out", () => {
    expect(FANOUT_THRESHOLD).toBeLessThanOrEqual(4);
  });
});
