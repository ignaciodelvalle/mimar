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
// THE VALUES ARE THE CHIP'S INK, transcribed from the old band tints. The
// painted band is navy for every key (`credentialBandSkin`). A render below
// fails if prenada's rosa moves back onto the stripe, and fails if the chip
// on the libreta face loses that rosa.

import { describe, expect, it } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { createElement } from "react";
import { StyleSheet } from "react-native";

import {
  DocumentChromeNative,
  type DocumentFace,
  bandSkin,
  credentialBandSkin,
} from "./DocumentChromeNative";

const prenada = { key: "prenada", tone: "info", icon: "perdida", label: "Preñada" };

/** jest has no Yoga: hand the band background the width a phone would. */
function layOutBand(width = 360) {
  fireEvent(screen.getByTestId("band-background"), "layout", {
    nativeEvent: { layout: { x: 0, y: 0, width, height: 106 } },
  });
}

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

describe("the painted band stays navy", () => {
  it("does not borrow prenada's rosa for the stripe", () => {
    expect(credentialBandSkin().stops[0]?.color).toBe("#0a3556");
    expect(bandSkin("prenada").stops[0]?.color).not.toBe(credentialBandSkin().stops[0]?.color);
  });

  it("paints navy on the credencial face even when the situation is prenada", () => {
    render(
      createElement(DocumentChromeNative, {
        face: "credencial",
        isLibretaActive: false,
        onTurn: () => {},
        situation: prenada,
      }),
    );
    layOutBand();
    const dumped = JSON.stringify(screen.toJSON());
    // react-native-svg stores a stop as a signed int. -16108202 is #0a3556
    // (navy); -4896386 is #b5497e (prenada). The chip is not on this face.
    expect(dumped).toContain("-16108202");
    expect(dumped).not.toContain("-4896386");
    expect(dumped).not.toContain("#b5497e");
  });

  it("keeps prenada's rosa border on the libreta-face pill, and the band navy", () => {
    render(
      createElement(DocumentChromeNative, {
        face: "libreta",
        isLibretaActive: true,
        onTurn: () => {},
        situation: prenada,
      }),
    );
    layOutBand();
    const dumped = JSON.stringify(screen.toJSON());
    expect(dumped).toContain("-16108202");
    // Pill uses stripe fill + rosa border + ink (web `.pc-sit-chip` prenada) —
    // not rosa as the chip fill (that was the old bare-text ink).
    expect(dumped).toContain("#f1c8dd");
    expect(dumped).not.toContain("#b5497e");
    expect(screen.getByText("Preñada")).toBeOnTheScreen();
  });

  it("matches the web band: no pinstripes, latent miMAR, mark + flip turn hits", () => {
    render(
      createElement(DocumentChromeNative, {
        face: "credencial",
        isLibretaActive: false,
        onTurn: () => {},
        situation: null,
      }),
    );
    layOutBand();
    const dumped = JSON.stringify(screen.toJSON());
    // Pinstripe era drew SVG <Line> hairlines; landing recipe is gradient only.
    expect(dumped).not.toContain('"type":"Line"');
    // Unicode ↻ paints as emoji-refresh on Android — flip is an SVG Path now.
    expect(dumped).not.toContain("↻");
    expect(dumped).not.toContain("↺");
    // Dual-layer engraved latent (hi + ink) — both say miMAR.
    expect(
      screen.getAllByText("miMAR", { includeHiddenElements: true }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Credencial · frente")).toBeOnTheScreen();
    expect(screen.getByLabelText("Girar a Libreta")).toBeOnTheScreen();
    expect(screen.getByLabelText("Marca miMAR: mostrar la libreta")).toBeOnTheScreen();
  });

  // The native twin of the web fence in __tests__/state-endorsement-fence.test.ts:
  // the band paints the DOCUMENT TYPE of the face on show. Literals, not the
  // contract recipe — the point is what the band says, not what a constant holds.
  it("names the document type on both faces", () => {
    const front = render(
      createElement(DocumentChromeNative, {
        face: "credencial",
        isLibretaActive: false,
        onTurn: () => {},
        situation: null,
      }),
    );
    expect(screen.getByText("Credencial · frente")).toBeOnTheScreen();
    front.unmount();
    render(
      createElement(DocumentChromeNative, {
        face: "libreta",
        isLibretaActive: true,
        onTurn: () => {},
        situation: null,
      }),
    );
    expect(screen.getByText("Libreta · dorso")).toBeOnTheScreen();
    expect(screen.queryByText("Libreta Sanitaria")).toBeNull();
  });

  // Two controls sharing one name and one toggle state read to TalkBack as
  // the same control listed twice (web parity: DocumentChrome's markAria).
  const TURN_CASES: Array<[DocumentFace, boolean, string, string]> = [
    ["credencial", false, "Girar a Libreta", "Marca miMAR: mostrar la libreta"],
    ["libreta", true, "Girar a Credencial", "Marca miMAR: mostrar la credencial"],
  ];
  it.each(TURN_CASES)(
    "on the %s face, mark and flip have distinct names and only the flip carries the state",
    (face, isLibretaActive, flipLabel, markLabel) => {
      render(
        createElement(DocumentChromeNative, {
          face,
          isLibretaActive,
          onTurn: () => {},
          situation: null,
        }),
      );
      const buttons = screen.getAllByRole("button");
      expect(buttons.map((b) => b.props.accessibilityLabel).sort()).toEqual(
        [flipLabel, markLabel].sort(),
      );
      const stateful = buttons.filter((b) => b.props.accessibilityState?.selected !== undefined);
      expect(stateful).toHaveLength(1);
      expect(stateful[0]?.props.accessibilityLabel).toBe(flipLabel);
      expect(stateful[0]?.props.accessibilityState.selected).toBe(isLibretaActive);
    },
  );
});

// J7, EAS preview (2026-10-06): an absolutely positioned Svg sized "100%" ×
// "100%" painted a ~613×45px strip of the band on Android and left the rest
// white. jest cannot paint, so the STRUCTURE is pinned: an absolute wrapper
// fills the band, and the Svg inside it has numeric dimensions and no
// positioning of its own.
describe("band background — the gradient covers the whole band on Android", () => {
  it("is an absolute wrapper holding a numerically sized, unpositioned Svg", () => {
    render(
      createElement(DocumentChromeNative, {
        face: "credencial",
        isLibretaActive: false,
        onTurn: () => {},
        situation: null,
      }),
    );
    const wrapper = screen.getByTestId("band-background");
    const wrapperStyle = StyleSheet.flatten(wrapper.props.style);
    expect(wrapperStyle).toMatchObject({
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    // Navy before the first layout: never a white band, not even for a frame.
    expect(wrapperStyle.backgroundColor).toBe("#0a3556");

    layOutBand(343);
    const svgs = screen
      .getByTestId("band-background")
      .findAll((node) => typeof node.props?.viewBox === "string");
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      expect(typeof svg.props.width).toBe("number");
      expect(typeof svg.props.height).toBe("number");
      expect(svg.props.width).toBe(343);
      const own = StyleSheet.flatten(svg.props.style) ?? {};
      expect(own.position).not.toBe("absolute");
    }
  });
});
