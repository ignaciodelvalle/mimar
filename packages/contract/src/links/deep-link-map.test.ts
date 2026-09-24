// The ranking rule that decides between two patterns a path matches.
//
// WHY THIS TEST LIVES INSIDE THE PACKAGE, and not beside the rest of the
// deep-link fitness suite in `__tests__/deep-link-map.test.ts`.
//
// `outranksWebPath` is internal to `deep-link-map.ts`: it is what `matchWebPath`
// consults, not something a caller invokes. Exporting it from `links/index.ts`
// so a root test could import it looks free and is not — `apps/mobile/app.config.ts`
// imports `@dim/contract/links` for the bundle identifier, so expo-updates counts
// that module's file tree as a native config dependency under the fingerprint
// runtime policy. MEASURED 2026-09-07: adding that one export line moved the
// runtime from build 10's `160f6069f9791f2c3bda95ae3829fa1ea4c4d49f` to
// `3bd89d34fccf9000c08a60942a636a0c1aaa5d5f`, and the OTA published from that
// tree could reach no installed phone. Not an error anyone sees — an update that
// silently applies to nobody. Removing the line brought `eas fingerprint:compare`
// back to an exact match.
//
// The root test cannot import it by path either: `scripts/check-contract-purity.ts`
// refuses a path-form import of the contract, because that bypasses the exports
// map and re-couples the app to the package's internal layout. Both fences are
// right. A unit test of an internal rule belongs next to the rule.
//
// `packages/**` is inside the root vitest walk (`vitest.config.ts:126`), so this
// file runs in `test:verified` like any other.

import { describe, expect, it } from "vitest";

import { DEEP_LINK_MAP, outranksWebPath } from "./deep-link-map.ts";

const NAMES = Object.keys(DEEP_LINK_MAP) as (keyof typeof DEEP_LINK_MAP)[];

describe("outranksWebPath — the routers' rule, positionally", () => {
  it("ranks by the LEFTMOST literal, not by how many literals there are", () => {
    // For `/a/b/c/d`: Next resolves `app/a/b/[q]/[r]` before `app/a/[p]/c/d`,
    // because at position 2 one is static and the other dynamic. Counting
    // totals says the opposite — 4 literals against 3.
    //
    // WHY SYNTHETIC. Every pair the table carries today is ranked the same way
    // by positional order and by total literal count, which is precisely why a
    // divergence would ship unnoticed: no real row can demonstrate it. This is
    // what stops somebody "simplifying" the rule back into a count.
    expect(outranksWebPath("/a/b/:q/:r", "/a/:p/c/d")).toBe(true);
    expect(outranksWebPath("/a/:p/c/d", "/a/b/:q/:r")).toBe(false);
    const literalsOf = (p: string) => p.split("/").filter((s) => !s.startsWith(":")).length;
    expect(literalsOf("/a/b/:q/:r")).toBeLessThan(literalsOf("/a/:p/c/d"));
  });

  it("ranks the pair this table really has, and calls a tie a tie", () => {
    // NON-VACUITY against the real rows: the static sibling wins.
    expect(outranksWebPath("/mis-mascotas/postulaciones", "/mis-mascotas/:publicToken")).toBe(true);
    expect(outranksWebPath("/mis-mascotas/:publicToken", "/mis-mascotas/postulaciones")).toBe(
      false,
    );
    // Same shape at every position → neither outranks the other, which is what
    // the ambiguity check below keys off.
    expect(outranksWebPath("/casos/:code", "/refugios/:orgToken")).toBe(false);
    expect(outranksWebPath("/refugios/:orgToken", "/casos/:code")).toBe(false);
  });
});

describe("no two destinations are ambiguous", () => {
  it("every same-length pair is separable by a literal, or one outranks the other", () => {
    // The invariant used to be the stronger "for every pair with the same
    // segment count there is at least one position where both are literals and
    // the literals differ". `/mis-mascotas/postulaciones` vs
    // `/mis-mascotas/:publicToken` breaks that sentence and is legitimate, so
    // the rule now has two arms: separable, OR ranked.
    //
    // What is still forbidden is a pair that is neither: identical
    // literal/placeholder shape at every position with no differing literal,
    // where "which screen does this notification open" would be decided by key
    // order in an object literal.
    const collisions: string[] = [];
    for (let i = 0; i < NAMES.length; i += 1) {
      for (let j = i + 1; j < NAMES.length; j += 1) {
        const leftPath = DEEP_LINK_MAP[NAMES[i] as keyof typeof DEEP_LINK_MAP].webPath as string;
        const rightPath = DEEP_LINK_MAP[NAMES[j] as keyof typeof DEEP_LINK_MAP].webPath as string;
        const left = leftPath.split("/");
        const right = rightPath.split("/");
        if (left.length !== right.length) continue;
        const separable = left.some((segment, index) => {
          const other = right[index] as string;
          return !segment.startsWith(":") && !other.startsWith(":") && segment !== other;
        });
        if (separable) continue;
        if (outranksWebPath(leftPath, rightPath) || outranksWebPath(rightPath, leftPath)) continue;
        collisions.push(`${String(NAMES[i])} vs ${String(NAMES[j])}`);
      }
    }
    expect(
      collisions,
      "two destinations are shape-identical and neither outranks the other, so " +
        "matchWebPath's answer for a path matching both is whichever happens to " +
        "come first in the table",
    ).toEqual([]);
  });

  it("actually walked the table", () => {
    // The loop above is vacuously green over an empty or one-row table.
    expect(NAMES.length).toBeGreaterThanOrEqual(15);
  });
});
