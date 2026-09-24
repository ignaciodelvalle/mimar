// `bandSkin` — the credential band's gradient stops + face border, per
// situation key.
//
// WHY THIS FILE EXISTS (T4-M6, 2026-09-22). `bandSkin` used to fall through to
// the shared DEFAULT navy band for exactly two keys — `prenada` and
// `fallecida` — because their tint tokens were not yet restated in
// `@dim/contract/tokens` (see that file's own note, and
// `DocumentChromeNative.tsx`'s header). Nothing was visibly broken: the
// situation chip still carried the state as icon + text, so no WCAG rule was
// bent. But it was debt in the shared layer with no fence over it, and a
// mutation that quietly deleted the `prenada`/`fallecida` cases entirely —
// folding them back onto `default` — would have passed every existing test in
// this package, because no test named the exact colour either case resolves
// to. This file is that fence.
//
// THE VALUES ARE PINNED AGAINST THE WEB'S OWN CSS, not re-derived from the
// token file that also feeds this function — `app/globals.css`'s
// `.ln-face[data-situation="prenada"] .ln-band` and `[...="fallecida"] .ln-band`
// rules are the source of truth this native chrome mirrors, and the literals
// below are transcribed from them.

import { describe, expect, it } from "@jest/globals";

import { bandSkin } from "./DocumentChromeNative";

describe("bandSkin — prenada (T4-M6)", () => {
  it("is a FLAT rosa tint, not the shared default navy band", () => {
    // MUTATION TO PROVE THIS CATCHES: delete the `case "prenada":` arm
    // entirely (folding it onto `default`) → this assertion fails, because the
    // default band's first stop is `COLORS.bandDeep` (navy), not rosa.
    const skin = bandSkin("prenada");
    expect(skin.stops).toEqual([
      { offset: "0%", color: "#b5497e" },
      { offset: "100%", color: "#b5497e" },
    ]);
    expect(skin.border).toBe("#f1c8dd");
  });

  it("both stops are the SAME colour — a flat tint, unlike every other band here", () => {
    // Named separately from the assertion above because it is the one thing
    // about this case that is NOT like its neighbours: `perdida`,
    // `observacion-antirrabica` and `en-adopcion` all interpolate between two
    // different colours. A "fix" that gave `prenada` a second, DIFFERENT stop
    // (reading the flat gradient as an oversight rather than the web's own
    // rule) would pass a `toBe(rosa)` check on the first stop alone and still
    // be wrong.
    const skin = bandSkin("prenada");
    expect(skin.stops[0]?.color).toBe(skin.stops[1]?.color);
  });
});

describe("bandSkin — fallecida / memorial (T4-M6)", () => {
  it("is the sepia gradient, not the shared default navy band", () => {
    // MUTATION TO PROVE THIS CATCHES: delete the `case "fallecida":` arm →
    // this fails against the default band's celeste end stop.
    const skin = bandSkin("fallecida");
    expect(skin.stops).toEqual([
      { offset: "0%", color: "#5d5240" },
      { offset: "100%", color: "#6a5a3f" },
    ]);
    expect(skin.border).toBe("#e0d4b8");
  });

  it("is a TWO-TONE gradient, unlike prenada's flat one", () => {
    const skin = bandSkin("fallecida");
    expect(skin.stops[0]?.color).not.toBe(skin.stops[1]?.color);
  });
});

describe("bandSkin — the fallback is still honest", () => {
  it("still falls to the default navy band for a key this build does not recognise", () => {
    // A situation key from a server ahead of this build — the fallback this
    // function's header promises stays true after T4-M6, it is just no
    // longer reachable for `prenada`/`fallecida` specifically.
    const skin = bandSkin("un-key-que-todavia-no-existe");
    expect(skin.stops[0]?.color).toBe("#0a3556");
  });

  it("resolves the same default for `undefined` (no active situation)", () => {
    expect(bandSkin(undefined)).toEqual(bandSkin("something-unrecognised"));
  });
});
