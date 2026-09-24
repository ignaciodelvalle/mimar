import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { ACCOUNTS, assertRealPage, loginAs } from "./demo/_helpers";

/**
 * Owner AppShell e2e — covers the citizen-variant chrome migrated in Item 7
 * Phase C (owner (app) layout → AppShell variant=citizen).
 *
 * Asserts on the OWNER home (/inicio) and a public surface visited WHILE logged
 * in (/adoptar) that:
 *   1. The migrated citizen masthead renders (the brand wordmark is present).
 *   2. There is exactly one #main-content landmark (no duplicate <main>).
 *   3. On the public surface, the logged-in owner is NOT stranded: a guaranteed
 *      role-return affordance is present (the headline stranded-user fix, D4).
 *   4. axe finds no WCAG 2.1 AA violations on the migrated chrome.
 *
 * Uses the OWNER account seeded by `pnpm seed:test` (owner@dim.test).
 */

// The owner landing reached THROUGH /inicio. Not "/inicio" itself:
// app/(app)/inicio/page.tsx is a redirect-only router (every branch ends in
// redirect(); no JSX return), so the browser never rests on that pathname.
//
// That is also why this file's beforeEach was failing on EVERY CI run — it
// waited for `/\/inicio/` after sign-in, a URL the address bar never shows
// because the redirect resolves before the navigation commits. All three tests
// died at `TimeoutError: page.waitForURL` (run 30614542320, failures 13/14/15)
// and had never executed their bodies. Replaced with the shared `loginAs`,
// which waits for "left /login" and is role-agnostic.
const OWNER_LANDING = /^\/mis-mascotas(\/DIM-[A-Z0-9-]+)?$/;

test.beforeEach(async ({ page }) => {
  await loginAs(page, ACCOUNTS.owner);
});

test("owner landing renders the citizen masthead with a single #main-content", async ({ page }) => {
  await page.goto("/inicio");
  await page.waitForLoadState("networkidle");
  await assertRealPage(page, OWNER_LANDING);

  // Citizen masthead present (brand wordmark).
  await expect(page.getByRole("banner").getByText("MiMAR").first()).toBeVisible();

  // Exactly one main-content landmark — the AppShell owns it.
  await expect(page.locator("#main-content")).toHaveCount(1);
});

test("a11y(axe) owner landing — citizen chrome (WCAG 2.1 AA)", async ({ page }) => {
  await page.goto("/inicio");
  await page.waitForLoadState("networkidle");
  // The subject is the CITIZEN CHROME, so prove the chrome is on screen AND
  // that we are on the landing rather than any page that happens to carry the
  // same banner — the masthead alone does not distinguish them.
  await assertRealPage(page, OWNER_LANDING, page.getByRole("banner").getByText("MiMAR").first());

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .disableRules(["color-contrast"]) // contrast validated via design tokens separately
    .analyze();

  expect(results.violations).toEqual([]);
});

test("logged-in owner on /adoptar is NOT stranded — keeps a role return (D4)", async ({ page }) => {
  await page.goto("/adoptar");
  await page.waitForLoadState("networkidle");
  await assertRealPage(page, "/adoptar");

  // Still exactly one #main-content (citizen shell, not a duplicate).
  await expect(page.locator("#main-content")).toHaveCount(1);

  // The stranded-user fix: a guaranteed ≤1-click return to the role home.
  // Wave-3 P6 (PO decision #645 point 5) dropped the separate "Volver a mi
  // app" affordance for this exact citizen+owner case because a nav item
  // already covered it.
  //
  // CORRECTED 2026-07-31 (PO): that item is **"Mis mascotas"**, not "Inicio".
  // "Inicio" was deliberately retired and `/mis-mascotas` IS the owner's home
  // now — it carries the pet list, open cases and the rest. The old comment
  // here named `/inicio` and this assertion waited for a nav label that
  // OWNER_NAV has not contained since. A CI run read that as "the D4 role
  // return is gone" and reported a product defect; there is none — the return
  // exists, the test was describing a retired IA.
  //
  // Keep matching BOTH labels via .or(): a discreet "Volver a mi app" return
  // still renders for other roles/surfaces (D13 token-landing, operator
  // stranded on a public page), so this stays true whichever affordance a
  // given session gets.
  const banner = page.getByRole("banner");
  const returnLink = banner.getByRole("link", { name: /volver a mi app/i });
  const homeLink = banner.getByRole("link", { name: /^mis mascotas$/i });
  // At least one role-return path must be present.
  await expect(returnLink.or(homeLink).first()).toBeVisible();
});
