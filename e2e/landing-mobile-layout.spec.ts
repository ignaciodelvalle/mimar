// Landing on a phone — the page must fit, and its first screen must say what
// miMAR is (design critique 2026-09-29, C1 + C3 + C4).
//
// WHY THIS SPEC EXISTS WHEN mobile-390 ALREADY CHECKS `/`. It does, and it
// CAUGHT the C1 overflow: `landing no scrollea horizontal a 390px` has failed
// on every push to main since the rail restructure (scrollWidth 596 vs 390),
// together with six landing-signin-reachable widths and the milestone CTA at
// 390 — all eight reds of the E2E job, one defect. Nobody read them because
// the job was already red. So the lesson is not "the assertion was wrong";
// it is that a red job hides the next red. What this file adds on top:
//
//   1. More than one width. 390 alone let a reader believe 360 (small
//      Android, the bulk of the AR market) and 414 were covered.
//   2. A SWEEP down the page, not one reading at the top. The story's device
//      frames use `content-visibility: auto`: until they near the viewport
//      the browser skips their layout and sizes them from
//      `contain-intrinsic-size`. A reading taken only at load measures the
//      placeholders. Scrolling through makes every section lay out for real.
//   3. The first screen (C3/C4): at 390×690 — a phone's usable height once
//      the browser chrome is gone — the H1, the primary CTA and the "Perdí
//      una mascota" way out are visible without scrolling, and the sticky
//      nav stays one row (≤ 64px) instead of eating a fifth of the screen.

import { type Page, expect, test } from "@playwright/test";

const PHONE_WIDTHS = [360, 390, 414];

/** Widest `documentElement.scrollWidth` seen while stepping down the page. */
async function widestScrollWidthDownThePage(page: Page): Promise<{
  widest: number;
  clientWidth: number;
  atY: number;
}> {
  return page.evaluate(async () => {
    const el = document.documentElement;
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    let widest = el.scrollWidth;
    let atY = 0;
    for (let y = 0; y <= el.scrollHeight; y += step) {
      window.scrollTo(0, y);
      // Two frames: one for the scroll, one for content-visibility to lay
      // out whatever just entered its margin.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (el.scrollWidth > widest) {
        widest = el.scrollWidth;
        atY = y;
      }
    }
    window.scrollTo(0, 0);
    return { widest, clientWidth: el.clientWidth, atY };
  });
}

for (const width of PHONE_WIDTHS) {
  test(`landing no scrollea horizontal en ningún tramo a ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const response = await page.goto("/");
    expect(response?.status(), "/ no respondió OK").toBeLessThan(400);

    const { widest, clientWidth, atY } = await widestScrollWidthDownThePage(page);
    // 1px of slack for sub-pixel rounding, as in mobile-390 and D.7's spec.
    expect(
      widest - clientWidth,
      `the landing scrolls sideways at ${width}px (scrollWidth ${widest} vs ${clientWidth}, first seen at y=${atY})`,
    ).toBeLessThanOrEqual(1);
  });
}
