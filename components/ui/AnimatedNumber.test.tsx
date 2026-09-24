import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnimatedNumber } from "./AnimatedNumber";

// SSR is the "motion off" path (useEffect never runs → useCountUp returns the
// exact target) — the same value a reduced-motion user sees. So it is the ideal
// deterministic surface to assert what the component actually renders.
describe("AnimatedNumber", () => {
  it("renders the exact target, es-AR formatted, by default", () => {
    const html = renderToStaticMarkup(<AnimatedNumber value={67343} />);
    expect(html).toContain("67.343");
    expect(html).toContain("tabular-nums");
  });

  it("uses a custom format (rounding + suffix) for the display value", () => {
    const html = renderToStaticMarkup(
      <AnimatedNumber value={38.5} format={(n) => `${n.toFixed(1).replace(".", ",")}%`} />,
    );
    expect(html).toContain("38,5%");
  });

  it("rounds a fractional target with the default formatter", () => {
    // Mid-tween the animated value is fractional; the default formatter rounds.
    const html = renderToStaticMarkup(<AnimatedNumber value={41.7} />);
    expect(html).toContain("42");
  });
});
