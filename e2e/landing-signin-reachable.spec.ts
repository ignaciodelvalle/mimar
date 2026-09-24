// D.7 — the landing's sign-in entry point survives every phone width.
//
// WHY AN E2E: the defect was a CSS media query (`display: none` below 560px)
// and the excuse for it lived in a comment — "sign-in stays reachable from the
// footer and the hero". No unit test can catch a claim like that; only a real
// layout engine at a real width can. Live review 2026-07-28 measured what it
// cost: at 375px the nearest /login sat at y = 12.260px, roughly fifteen
// screenfuls down, and LandingNav has no hamburger at ANY width — so the nav
// did not collapse, it lost its way in. A returning user on a phone was stuck.
//
// Three things are asserted at each width, because fixing one by breaking
// another is exactly how this got here:
//   1. the entry point is VISIBLE (the original defect),
//   2. it is at least 44px tall to touch (the same review found several
//      sub-44px controls on this page — shedding button chrome must not add
//      one more),
//   3. the document does not scroll sideways (the row overflow that motivated
//      hiding the link in the first place — the real problem, never fixed).

import { expect, test } from "@playwright/test";

import { SIGN_IN_PATH } from "./_sign-in-route";

// 320 = SE-class, 375 = the most common iPhone, 390 = the most common width in
// Argentina, 560/561 = the exact boundary the media query used to switch on.
const PHONE_WIDTHS = [320, 375, 390, 480, 560, 561];

const MIN_TOUCH_PX = 44;

for (const width of PHONE_WIDTHS) {
  test(`landing keeps a usable sign-in entry point at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const signIn = page.locator(`header a[href="${SIGN_IN_PATH}"]`).first();
    await expect(signIn, `no sign-in link in the header at ${width}px`).toBeVisible();

    const box = await signIn.boundingBox();
    expect(box, `sign-in link has no box at ${width}px`).not.toBeNull();
    expect(
      box?.height ?? 0,
      `sign-in link is only ${Math.round(box?.height ?? 0)}px tall at ${width}px`,
    ).toBeGreaterThanOrEqual(MIN_TOUCH_PX);

    const scrollsSideways = await page.evaluate(() => {
      const d = document.documentElement;
      // 1px of slack: sub-pixel rounding at some widths is not a defect.
      return d.scrollWidth - d.clientWidth > 1;
    });
    expect(scrollsSideways, `the landing scrolls horizontally at ${width}px`).toBe(false);
  });
}

test("the sign-in link is reachable without scrolling the page", async ({ page }) => {
  // The heart of D.7. The old CSS comment promised reachability "from the
  // footer and the hero" while the nearest /login was twelve thousand pixels
  // down. Anchoring on the HEADER's own link keeps that promise checkable.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const box = await page.locator(`header a[href="${SIGN_IN_PATH}"]`).first().boundingBox();
  expect(box).not.toBeNull();
  expect(
    box?.y ?? Number.POSITIVE_INFINITY,
    "the sign-in link is below the first screenful",
  ).toBeLessThan(800);
});
