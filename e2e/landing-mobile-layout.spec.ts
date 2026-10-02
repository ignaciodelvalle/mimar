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
//   3. The first screen (C3): at 390×690 — a phone's usable height once the
//      browser chrome is gone — the H1 and the nav's sign-up CTA are visible
//      without scrolling, and the sticky nav stays one row (≤ 64px) instead
//      of eating a fifth of the screen. The hero's own CTA row was replaced
//      by the three crisis doors (PO 2026-10-02): at 390×844 — the size the
//      PO named — all three sit on the first screen with the H1 and the lead.

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

/** True when the element's whole box sits inside the viewport, no scrolling. */
async function fullyInFirstScreen(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
}

test("a 390×690 la primera pantalla dice qué es miMAR y ofrece la acción (C3)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 690 });
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  expect(await fullyInFirstScreen(page, "h1"), "the H1 is below the fold").toBe(true);
  // The hero no longer carries its own sign-up button: the sticky nav's is
  // the one, and it must be on screen from the start.
  await expect(page.locator('header.lp-nav a[href="/registro"]')).toBeVisible();
  expect(
    await fullyInFirstScreen(page, 'header.lp-nav a[href="/registro"]'),
    "the nav's sign-up CTA is off screen",
  ).toBe(true);
});

test("a 390×844 las tres puertas de emergencia entran en la primera pantalla", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const doors = page.locator('[data-section="crisis-doors"] a');
  await expect(doors).toHaveCount(3);
  for (const selector of ["h1", ".lp-hero-copy .lp-lead"]) {
    expect(await fullyInFirstScreen(page, selector), `${selector} is below the fold`).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    const href = await doors.nth(i).getAttribute("href");
    expect(
      await fullyInFirstScreen(page, `[data-section="crisis-doors"] a[href="${href}"]`),
      `the crisis door to ${href} is below the fold`,
    ).toBe(true);
    // A finger, not a cursor: every door is a 44px target at least.
    const box = await doors.nth(i).boundingBox();
    expect(box?.height ?? 0, `the door to ${href} is under 44px tall`).toBeGreaterThanOrEqual(44);
  }
});

for (const width of PHONE_WIDTHS) {
  test(`el nav queda en una fila de 64px o menos a ${width}px (C3)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const height = await page
      .locator("header.lp-nav")
      .evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(height, `the nav is ${height}px tall at ${width}px`).toBeLessThanOrEqual(64);
  });
}
