// The PUBLIC privacy promise must match the code that keeps it.
//
// A3 (2026-07-31). `/transparencia` is the citizen-facing statement of the
// open-data privacy policy: "k-anonimato con k = 5", "la celda muestra
// «suprimido por privacidad» — nunca un 0", "supresión complementaria a nivel
// nacional". Every one of those clauses is a legal claim under Ley 27.275
// (transparencia activa) and Ley 25.326, and every one of them was written by
// hand into JSX while the behaviour it describes lives in constants three
// directories away.
//
// Nothing connected the two. `OPEN_DATA_K` could drop to 3, `SUPPRESSED_MARKER`
// could change wording, the complementary pass could be deleted — and the page
// would keep promising the old guarantee to the public with a green suite. The
// suppression MATH is well tested (lib/open-data/__tests__/province-suppression,
// lib/metrics/anonymity); the DISCLOSURE that describes it to citizens was not
// tested at all.
//
// These assertions are computed FROM the constants, never from a copy of their
// current values — that is what gives them teeth. Source-scan rather than render
// because the page is a server component (same style as
// __tests__/welfare-coordinates-precision.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import { OPEN_DATA_K, SUPPRESSED_MARKER } from "@/lib/open-data/province-suppression";

const PAGE = join(process.cwd(), "app", "(public)", "transparencia", "page.tsx");
const SUPPRESSION = join(process.cwd(), "lib", "open-data", "province-suppression.ts");

/** Source with comments blanked out (line offsets preserved). A source-scan
 *  assertion over raw text can be satisfied by prose in a comment — the exact
 *  trap that made a toothless fence look green on 2026-07-30. Every assertion
 *  below is therefore about CODE/JSX, never about a comment quoting it. */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, before) => before + " ".repeat(m.length - before.length));
}

const page = readCode(PAGE);

describe("/transparencia — the published k-anonymity threshold IS the implemented one", () => {
  it("the two thresholds agree with each other before the page is judged against either", () => {
    // The open-data tier and the shared engine must not drift apart, or "k = 5"
    // on the page would be true of one path and false of the other.
    expect(OPEN_DATA_K).toBe(ANONYMITY_K);
  });

  it("OPEN_DATA_K is DERIVED from ANONYMITY_K, not a second literal that happens to match", () => {
    // The assertion above went tautological on 2026-08-17, when OPEN_DATA_K
    // became `= ANONYMITY_K`. `toBe` can no longer fail — a test that cannot
    // fail is not a fence, it is a comment with a green tick. What CAN still
    // regress is someone re-typing a literal in a future edit ("just make it
    // explicit"), which restores the two-unlinked-numbers shape this parity
    // suite was written to prevent. So the fence moves to the SOURCE: the
    // export must name the shared constant.
    const suppression = readCode(SUPPRESSION);
    const decl = suppression.match(/export\s+const\s+OPEN_DATA_K\s*=\s*([^;]+);/);
    expect(decl, "OPEN_DATA_K is no longer exported from province-suppression.ts").not.toBeNull();
    // Non-vacuity: the scan really found a declaration with a right-hand side.
    expect((decl?.[1] ?? "").trim().length).toBeGreaterThan(0);
    expect(decl?.[1]).toContain("ANONYMITY_K");
    expect(decl?.[1], "OPEN_DATA_K re-typed as a bare number").not.toMatch(/^\s*\d+\s*$/);
  });

  it("states the LIVE k value, not a hardcoded 5", () => {
    // Interpolated: lower OPEN_DATA_K to 3 and this fails, because the page
    // still says "k = 5". That is the whole point.
    expect(page).toContain(`k-anonimato con k = ${OPEN_DATA_K}`);
    expect(page).toContain(`menos de ${OPEN_DATA_K} individuos`);
  });

  it("never advertises a threshold the code does not implement", () => {
    // Any "k = N" on the page must be the real N. Catches a second, stale
    // mention left behind when the first one is updated.
    const claimed = [...page.matchAll(/k\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(claimed.length).toBeGreaterThan(0);
    for (const k of claimed) expect(k).toBe(OPEN_DATA_K);
  });
});

describe("/transparencia — the marker it shows citizens IS the marker the exports emit", () => {
  it("quotes SUPPRESSED_MARKER verbatim", () => {
    expect(page).toContain(SUPPRESSED_MARKER);
  });

  it("promises a withheld cell, never a zero — the marker is not 0 and not empty", () => {
    // The page's exact words: "«suprimido por privacidad» — nunca un 0".
    expect(page).toContain("nunca un 0");
    expect(SUPPRESSED_MARKER.trim()).not.toBe("");
    expect(SUPPRESSED_MARKER).not.toBe("0");
  });
});

describe("/transparencia — the complementary-suppression promise is actually implemented", () => {
  it("the page promises a national complementary pass", () => {
    expect(page).toContain("supresión complementaria a nivel nacional");
  });

  it("the province tier really runs complementarySuppress", () => {
    // If the complementary pass were removed, the page would still promise that
    // "ningún valor oculto pueda reconstruirse restando las provincias
    // visibles de un total nacional" — a false guarantee to the public.
    // Comment-stripped: the module's header prose names complementarySuppress
    // three times, so a raw scan would survive the call being deleted.
    const suppression = readCode(SUPPRESSION);
    expect(suppression).toMatch(/=\s*complementarySuppress\(|\bcomplementarySuppress\(\s*$/m);
  });
});
