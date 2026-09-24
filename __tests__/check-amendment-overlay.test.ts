/**
 * Unit tests for scripts/check-amendment-overlay.ts's R3 "unnamed forgery"
 * helpers (splitTopLevelArgs / isForgedCastArgument / findForgedCastCalls)
 * and the R3 brand-cast regex (BRAND_CAST).
 *
 * FRESH-CONTEXT REVIEW (2026-09-22) found the old FORGED_CAST_ARG_RE —
 * `/(?:^|,)\s*[^,()]*\bas\s+(?:any|never)\b/` applied to a replayPet* call's
 * raw argument-list text — was BOTH too narrow and too broad:
 *   - too narrow: `replayPetWeight(pick(events, "x") as any)` was missed,
 *     because `[^,()]*` cannot cross the parens of the nested `pick(...)`
 *     call to reach the `as any` that follows it.
 *   - too broad: `replayPetWeight(events, { filter: buildFilter(a, b), meta:
 *     raw as any })` was flagged, because the comma INSIDE `buildFilter(a, b)`
 *     was treated as a top-level argument separator, and the comma splitting
 *     the object's `filter`/`meta` fields was too — landing the regex on a
 *     span that starts mid-object and happens to end in `as any`.
 *
 * The fix replaces the regex with a small depth-aware splitter
 * (splitTopLevelArgs) that tracks `()[]{}` depth and skips quoted/template
 * strings whole, plus a per-argument check (isForgedCastArgument) for whether
 * THAT argument, unwrapped of any parens enclosing it whole, ends in a
 * top-level `as any`/`as never`.
 *
 * NOTE ON THE FIXTURES BELOW: this file is itself inside the tree that
 * check-amendment-overlay.ts's brandForgers() scans for forgeries (R3 is
 * checked in __tests__/**, deliberately, so a forgery cannot hide behind a
 * ".test.ts" suffix). Two things follow from that:
 *   1. Fixtures that exercise findForgedCastCalls use a FAKE call name
 *      (`replayFixtureStream`) rather than a real replayPet* name, so this
 *      file's own literal fixture text can never be matched by the live
 *      script's callRe (built only from the real names amendableReplays()
 *      derives from lib/projections/*.ts).
 *   2. The BRAND_CAST fixture builds the brand name from two string pieces
 *      joined at runtime, so the literal substring "AmendmentOverlaid" never
 *      sits after "as" in this file's raw source text — the same class of
 *      self-match check-authz-guards.test.ts documents (see its "KNOWN false
 *      positive" test) that this file avoids outright rather than merely
 *      documents, since it would otherwise turn the live `pnpm
 *      lint:amendment-overlay` run red on this very file.
 */

import { describe, expect, it } from "vitest";

import {
  BRAND_CAST,
  argListAt,
  findForgedCastCalls,
  isForgedCastArgument,
  splitTopLevelArgs,
} from "@/scripts/check-amendment-overlay";

// ---------------------------------------------------------------------------
// argListAt — string-aware balanced-paren argument extraction
//
// Fresh-context review, pre-push, item 7a: the old char-scan counted EVERY
// `(`/`)` toward depth, including ones sitting inside a quoted string or
// template literal. A string argument that itself contains an unbalanced
// paren character — `pick(events, "(unbalanced")` — could close the scan
// early (or never), silently truncating or corrupting the argument-list text
// that isForgedCastArgument/splitTopLevelArgs read next.
// ---------------------------------------------------------------------------

describe("argListAt", () => {
  it("extracts a simple balanced argument list", () => {
    const src = "foo(a, b, c);";
    expect(argListAt(src, src.indexOf("("))).toBe("a, b, c");
  });

  it("does NOT let an unbalanced paren INSIDE a string literal break the scan", () => {
    // The string argument's own content — "(" — is not call structure. A scan
    // that miscounted it would either return early (missing ", x)") or never
    // find depth 0 at all.
    const src = 'foo("(", x);';
    expect(argListAt(src, src.indexOf("("))).toBe('"(", x');
  });

  it("does NOT let an unbalanced CLOSING paren inside a string break the scan", () => {
    const src = 'foo(")", x);';
    expect(argListAt(src, src.indexOf("("))).toBe('")", x');
  });

  it("stays correct through a template literal carrying stray parens", () => {
    const src = "foo(`note (with parens) here`, x);";
    expect(argListAt(src, src.indexOf("("))).toBe("`note (with parens) here`, x");
  });

  it("still balances a real nested call correctly", () => {
    const src = 'foo(pick(events, "x"), y);';
    expect(argListAt(src, src.indexOf("("))).toBe('pick(events, "x"), y');
  });

  // MUTATION PROOF: dropping the string-literal skip from argListAt (reverting
  // to the plain char-scan) makes this return "" instead — the unbalanced "("
  // inside the string ratchets depth up to 2, only one real ")" ever brings it
  // back down to 1, depth never reaches 0, and the function falls through to
  // its "" fallback. This assertion goes red the moment the fix is undone.
  it('MUTATION PROOF: a naive char-scan never reaches depth 0 and returns ""', () => {
    const src = 'foo("(", x);';
    const result = argListAt(src, src.indexOf("("));
    expect(result).not.toBe("");
    expect(result).toBe('"(", x');
  });
});

// ---------------------------------------------------------------------------
// splitTopLevelArgs — depth-aware, string-aware comma splitting
// ---------------------------------------------------------------------------

describe("splitTopLevelArgs", () => {
  it("returns [] for an empty argument list", () => {
    expect(splitTopLevelArgs("")).toEqual([]);
    expect(splitTopLevelArgs("   ")).toEqual([]);
  });

  it("splits simple top-level arguments", () => {
    expect(splitTopLevelArgs("a, b, c")).toEqual(["a", " b", " c"]);
  });

  it("does NOT split on a comma nested inside a call's parens", () => {
    // The too-narrow reviewer case's shape: a nested call carries its own
    // comma, which is not an argument boundary of the OUTER call.
    expect(splitTopLevelArgs('pick(events, "x") as any')).toEqual(['pick(events, "x") as any']);
  });

  it("does NOT split on a comma nested inside an object literal", () => {
    // The too-broad reviewer case's shape.
    const arg = "events, { filter: buildFilter(a, b), meta: raw as any }";
    expect(splitTopLevelArgs(arg)).toEqual([
      "events",
      " { filter: buildFilter(a, b), meta: raw as any }",
    ]);
  });

  it("does NOT split on a comma nested inside an array literal", () => {
    expect(splitTopLevelArgs("[a, b], c")).toEqual(["[a, b]", " c"]);
  });

  it("does NOT split on a comma inside a plain string literal", () => {
    // The exact shape a naive char-scan would get wrong: a comma AND the
    // literal text "as any" both sitting inside quotes, not code.
    expect(splitTopLevelArgs('events, ", x as any"')).toEqual(["events", ' ", x as any"']);
  });

  it("does NOT split on a comma inside a template literal, including one with ${} inside", () => {
    expect(splitTopLevelArgs("events, `note, ${a}, done`")).toEqual([
      "events",
      " `note, ${a}, done`",
    ]);
  });

  it("respects an escaped quote inside a string literal", () => {
    // `\"` does not end the string early — a naive quote-toggle would split
    // here on the comma that follows, one character too soon.
    expect(splitTopLevelArgs('events, "a \\" b, c"')).toEqual(["events", ' "a \\" b, c"']);
  });

  it("handles a trailing comma (a common biome/prettier multi-line shape) without dropping data", () => {
    expect(splitTopLevelArgs("a,\n")).toEqual(["a", "\n"]);
  });
});

// ---------------------------------------------------------------------------
// isForgedCastArgument — the per-argument "does THIS cast the whole thing" rule
// ---------------------------------------------------------------------------

describe("isForgedCastArgument", () => {
  it("flags a cast that applies to the whole argument expression", () => {
    expect(isForgedCastArgument('pick(events, "x") as any')).toBe(true);
    expect(isForgedCastArgument("events as never")).toBe(true);
  });

  it("flags a cast wrapped in parens that enclose the whole argument", () => {
    expect(isForgedCastArgument("(raw as any)")).toBe(true);
  });

  it("does NOT flag a cast nested inside an object literal the argument merely contains", () => {
    expect(isForgedCastArgument("{ meta: raw as any }")).toBe(false);
  });

  it("does NOT flag a legit overlay call with no cast at all", () => {
    expect(isForgedCastArgument("overlayAmendments(events)")).toBe(false);
  });

  it("does NOT flag a cast applied to an inner argument of a call that wraps the whole thing", () => {
    // overlayAmendments still runs on the (badly-typed) input before the
    // replay ever sees it — the argument ITSELF is the overlayAmendments(...)
    // call result, not a cast.
    expect(isForgedCastArgument("overlayAmendments(events as any)")).toBe(false);
  });

  it("matches across a biome/prettier line wrap between `as` and `any`/`never`", () => {
    expect(isForgedCastArgument("raw as\n    any")).toBe(true);
    expect(isForgedCastArgument("raw as\n    unknown as\n    never")).toBe(true);
  });

  it("does NOT flag plain, uncast code", () => {
    expect(isForgedCastArgument("events")).toBe(false);
    expect(isForgedCastArgument("pick(events, 'x')")).toBe(false);
  });

  // Item 7b, fresh-context review pre-push: the OTHER TypeScript cast syntax
  // — `<any>expr` / `<never>expr` — erases the type just as completely as a
  // trailing `as any`/`as never`, and was invisible to the old suffix-only
  // regex.
  describe("angle-bracket cast forgery (`<any>`/`<never>`)", () => {
    it("flags a leading angle-bracket `<any>` cast on the whole argument", () => {
      expect(isForgedCastArgument("<any>raw")).toBe(true);
    });

    it("flags a leading angle-bracket `<never>` cast on the whole argument", () => {
      expect(isForgedCastArgument("<never>raw")).toBe(true);
    });

    it("flags an angle-bracket cast wrapped in parens that enclose the whole argument", () => {
      expect(isForgedCastArgument("(<any>raw)")).toBe(true);
    });

    it("flags an angle-bracket cast on a call result, not just a bare identifier", () => {
      expect(isForgedCastArgument('<any>pick(events, "x")')).toBe(true);
    });

    it("does NOT flag an angle-bracket cast buried inside an object literal the argument merely contains", () => {
      expect(isForgedCastArgument("{ meta: <any>raw }")).toBe(false);
    });

    // MUTATION PROOF: removing TOP_LEVEL_CAST_PREFIX_RE from
    // isForgedCastArgument (reverting to the suffix-only check) makes every
    // assertion in this describe block that expects `true` return `false`
    // instead — the angle-bracket forgery would ship invisible again.
    it("MUTATION PROOF: the suffix-only `as any`/`as never` check alone would miss this", () => {
      const expr = "<any>raw";
      // Sanity: this expression does NOT end in a trailing `as any`/`as
      // never`, so a suffix-only check would answer false — the forgery
      // this fix exists to catch.
      expect(/\bas\s+(?:any|never)\b\s*$/.test(expr)).toBe(false);
      expect(isForgedCastArgument(expr)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// findForgedCastCalls — end to end over a full call-site source snippet
//
// FIXTURE NAME: every source string below calls "replayFixtureStream", a
// fake name passed explicitly via the `replayNames` argument — see the file
// header for why a real replayPet* name is deliberately avoided here.
// ---------------------------------------------------------------------------

describe("findForgedCastCalls", () => {
  const REPLAY_NAMES = ["replayFixtureStream"];

  it("REVIEWER CASE 1 (too narrow): catches an `as any` past a nested call", () => {
    const src = 'replayFixtureStream(pick(events, "x") as any);';
    const offenders = findForgedCastCalls(src, REPLAY_NAMES);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("replayFixtureStream");
    expect(offenders[0]).toContain("AmendmentOverlaid");
  });

  it("REVIEWER CASE 2 (too broad): does NOT flag a cast buried inside a nested object argument", () => {
    const src = "replayFixtureStream(events, { filter: buildFilter(a, b), meta: raw as any });";
    expect(findForgedCastCalls(src, REPLAY_NAMES)).toEqual([]);
  });

  it("flags a multi-line, biome-wrapped cast passed directly as the argument", () => {
    const src = ["replayFixtureStream(", "  raw as", "    any,", ");"].join("\n");
    const offenders = findForgedCastCalls(src, REPLAY_NAMES);
    expect(offenders).toHaveLength(1);
  });

  it("does NOT flag a legit overlayAmendments(raw) call passed as the argument", () => {
    const src = "replayFixtureStream(overlayAmendments(raw));";
    expect(findForgedCastCalls(src, REPLAY_NAMES)).toEqual([]);
  });

  it('does NOT flag a string-literal argument that merely CONTAINS ", x as any"', () => {
    const src = 'replayFixtureStream(events, ", x as any");';
    expect(findForgedCastCalls(src, REPLAY_NAMES)).toEqual([]);
  });

  it("flags a call with the forged cast on its FIRST of several arguments too", () => {
    const src = "replayFixtureStream(events as any, options);";
    expect(findForgedCastCalls(src, REPLAY_NAMES)).toHaveLength(1);
  });

  it("returns [] when no replay names are given", () => {
    expect(findForgedCastCalls("replayFixtureStream(events as any);", [])).toEqual([]);
  });

  it("returns [] when the file never calls any of the given replay names", () => {
    expect(findForgedCastCalls("otherFunction(events as any);", REPLAY_NAMES)).toEqual([]);
  });

  it("flags an angle-bracket `<any>` cast passed directly as the argument (item 7b)", () => {
    const src = "replayFixtureStream(<any>events);";
    const offenders = findForgedCastCalls(src, REPLAY_NAMES);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("replayFixtureStream");
  });

  it("does NOT let a string literal containing stray parens corrupt the argument scan (item 7a)", () => {
    // Exercises argListAt end to end through findForgedCastCalls: a string
    // argument carrying an unbalanced "(" sits BEFORE the forged-cast
    // argument. A broken argListAt would corrupt the whole argument-list
    // slice here and either miss the real forgery or throw.
    const src = 'replayFixtureStream("note (unbalanced", raw as any);';
    const offenders = findForgedCastCalls(src, REPLAY_NAMES);
    expect(offenders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BRAND_CAST — R3's named-forgery half (`as X & AmendmentOverlaid...`)
// ---------------------------------------------------------------------------

describe("BRAND_CAST", () => {
  // Built from two pieces and joined at runtime — see the file header. Do NOT
  // inline this as one string literal.
  const brandName = ["Amendment", "Overlaid"].join("");

  it("flags a named cast to the brand outside its minter", () => {
    const src = `const x = raw as ${brandName}<ProjectionEvent>;`;
    expect(BRAND_CAST.test(src)).toBe(true);
  });

  it("flags a double cast through `unknown` (a common way to force an incompatible cast)", () => {
    const src = `const x = raw as unknown as ${brandName}<ProjectionEvent>;`;
    expect(BRAND_CAST.test(src)).toBe(true);
  });

  it("flags a cast wrapped across lines by a formatter", () => {
    const src = ["const x = raw as unknown as", `  ${brandName}<ProjectionEvent>;`].join("\n");
    expect(BRAND_CAST.test(src)).toBe(true);
  });

  it("does NOT flag ordinary code that never mentions the brand", () => {
    expect(BRAND_CAST.test("const x = overlayAmendments(raw);")).toBe(false);
  });

  it("does NOT flag the brand name appearing without a cast (e.g. a type annotation)", () => {
    const src = `function f(x: ${brandName}<ProjectionEvent>) { return x; }`;
    expect(BRAND_CAST.test(src)).toBe(false);
  });
});
