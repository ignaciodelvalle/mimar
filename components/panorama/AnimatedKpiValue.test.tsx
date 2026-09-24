/**
 * The round-trip proof behind AnimatedKpiValue.
 *
 * `PanoramaKpi.value` arrives pre-formatted from the server, so animating it
 * means parsing a display string back into a number. That is only safe with a
 * guarantee, and the guarantee is: parse, re-format, and refuse unless the
 * characters come back identical. These tests pin both halves — the shapes it
 * MUST animate, and the shapes it must decline to touch.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnimatedKpiValue, parseEsArFigure } from "@/components/panorama/AnimatedKpiValue";

describe("parseEsArFigure — es-AR is the inverse of en-US, so it never guesses", () => {
  it("reads the thousands separator as thousands, not as a decimal point", () => {
    // "1.234" is one thousand two hundred thirty-four in es-AR. Misreading it
    // as 1.234 would tween a KPI from 1,234 to ~1 and look like a data loss.
    expect(parseEsArFigure("1.234")).toMatchObject({ n: 1234, decimals: 0 });
    expect(parseEsArFigure("1.234.567")).toMatchObject({ n: 1234567, decimals: 0 });
  });

  it("reads the comma as the decimal separator and keeps its precision", () => {
    expect(parseEsArFigure("12,5")).toMatchObject({ n: 12.5, decimals: 1 });
    expect(parseEsArFigure("0,25")).toMatchObject({ n: 0.25, decimals: 2 });
  });

  it("keeps a suffix and a prefix out of the number", () => {
    expect(parseEsArFigure("83%")).toMatchObject({ n: 83, suffix: "%" });
    expect(parseEsArFigure("12,5%")).toMatchObject({ n: 12.5, suffix: "%" });
    expect(parseEsArFigure("$ 1.500")).toMatchObject({ n: 1500, prefix: "$ " });
    expect(parseEsArFigure("310 eventos")).toMatchObject({ n: 310, suffix: " eventos" });
  });

  it("declines anything with no number in it", () => {
    expect(parseEsArFigure("—")).toBeNull();
    expect(parseEsArFigure("s/d")).toBeNull();
    expect(parseEsArFigure("")).toBeNull();
  });

  it("declines a figure it cannot reproduce character for character", () => {
    // Grouping the server did not apply: re-formatting 1234 yields "1.234",
    // which is not the input, so the round trip fails and the value is left
    // alone rather than silently re-formatted on screen.
    expect(parseEsArFigure("1234")).toBeNull();
    // A malformed group is not ours to normalise either.
    expect(parseEsArFigure("1.23")).toBeNull();
  });
});

// SSR is the "motion off" path (useEffect never runs → useCountUp returns the
// exact target) — the same output a reduced-motion viewer gets, and the same
// surface components/ui/AnimatedNumber.test.tsx pins.
describe("AnimatedKpiValue — rendering", () => {
  it("renders an unparseable value verbatim", () => {
    const html = renderToStaticMarkup(<AnimatedKpiValue value="—" temporalFrameActive={false} />);
    expect(html).toContain("—");
  });

  it("renders the exact server string on first paint (no count-up on mount)", () => {
    // useCountUp tweens ON CHANGE only, so the first frame is the target — an
    // operator landing on the board never sees a number climbing from zero,
    // and a no-JS viewer sees the real figure.
    const html = renderToStaticMarkup(
      <AnimatedKpiValue value="1.234" temporalFrameActive={false} />,
    );
    expect(html).toContain("1.234");
  });

  it("keeps prefix and suffix attached to the animated figure", () => {
    expect(
      renderToStaticMarkup(<AnimatedKpiValue value="83%" temporalFrameActive={true} />),
    ).toContain("83%");
    expect(
      renderToStaticMarkup(<AnimatedKpiValue value="$ 1.500" temporalFrameActive={false} />),
    ).toContain("$ 1.500");
  });
});
