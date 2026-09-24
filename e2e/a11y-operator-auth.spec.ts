import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { ACCOUNTS, assertRealPage, discoverPetToken, loginAs } from "./demo/_helpers";

/**
 * A11y e2e tests for operator + authenticated surfaces (Wave 2 Item 11).
 *
 * EVERY AXE SCAN HERE IS PRECEDED BY assertRealPage (e2e/demo/_helpers.ts).
 * Until 2026-07-31 none of them were, and this file was the only axe spec in
 * the tree that never imported it (a11y-regression.spec.ts has used it for six
 * scans; A7 fixed that file and not this one). The defect it exists to prevent
 * was live here: the login step below swallowed its own failure with
 * `.catch(() => {})`, so a refused or slow sign-in left the browser on /login
 * or on a branded 404 — and axe measured THAT. A not-found boundary is a small,
 * clean, correct page: `critical/serious = 0`, green, route never loaded. The
 * only guard was `not.toBeVisible(/application error/i)`, which is trivially
 * true on a 404. The /anotar test's own comment admitted it did not know what
 * page it had measured.
 *
 * Scope:
 *   - /gob, /admin, /org/*  — require institutional role (govt/admin) or
 *     org membership. The seeded test DB only has `owner@dim.test` (personal
 *     role=owner), so these routes redirect to / or /mis-mascotas. We axe-test
 *     the REDIRECT TARGET because the browser always lands on that page, and
 *     that page must be axe-clean.
 *   - /mis-mascotas/[token]/anotar — accessible to any authenticated owner.
 *     (Listed as "/anotar" until 2026-07-31. That route does not exist.)
 *
 * WS-C (2026-07-01): authenticated axe passes for /admin and /gob added below,
 * using the seeded admin@dim.test and govt@dim.test accounts. They assert no
 * critical/serious WCAG 2.1 AA violations (the WS-C acceptance bar). These run
 * in the Playwright CI job (not `pnpm verify`); if they surface violations, that
 * is the operator-a11y fix worklist (June U1: table semantics + color-only
 * status). /org/[orgToken] authenticated coverage still needs org-token
 * resolution — tracked as a follow-up.
 */

// Sign-in goes through the shared `loginAs` (e2e/demo/_helpers.ts), which waits
// for "left /login" rather than for a specific landing URL. The three inline
// copies that used to live in this file all waited on `/\/inicio/`, a pathname
// the address bar NEVER shows: app/(app)/inicio/page.tsx is a redirect-only
// router, so the redirect resolves before the navigation commits. e2e/owner-
// shell.spec.ts carried the same copy and died on it in every CI run
// (TimeoutError: page.waitForURL, run 30614542320 failures 13/14/15). Waiting
// on the landing is unnecessary here anyway — each test navigates to its own
// route immediately afterwards and asserts THAT.
const AUTHED_OPERATOR_ROUTES = [
  { path: "/admin", email: ACCOUNTS.admin },
  { path: "/gob", email: ACCOUNTS.govt },
] as const;

test.describe("authenticated operator surfaces — axe-clean (WCAG 2.1 AA, WS-C)", () => {
  for (const { path, email } of AUTHED_OPERATOR_ROUTES) {
    test(`a11y(axe) ${path} authenticated — no critical/serious`, async ({ page }) => {
      // Throws on a refused sign-in. The version this replaced ended in
      // `.catch(() => {})`, which turned a failed login into "we are somewhere,
      // axe it" — the scan then measured the login page or a 404 and reported
      // critical=0.
      await loginAs(page, email);

      await page.goto(path);
      await page.waitForLoadState("networkidle");
      // Prove WHICH page we are about to measure. `application error` alone was
      // no guard at all — a branded 404 does not contain that string.
      await assertRealPage(page, path);

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .disableRules(["color-contrast"])
        .analyze();

      const blocking = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      expect(blocking, `${path}: ${blocking.map((v) => v.id).join(", ")}`).toEqual([]);
    });
  }
});

// These operator routes redirect non-privileged owners. The redirect
// DESTINATION is the subject, and both destinations changed after this table
// was written (CI-red unit, 2026-08-03 — the stale patterns were 2 of the 16
// standing failures):
//   /admin → requireAdminOrRedirect bounces to "/", but the root page never
//     renders for a signed-in owner — it chains through pathForRole → /inicio
//     → /mis-mascotas/<most-urgent-pet>, so the SETTLED page an owner actually
//     sees (and axe must measure) is the pet profile. owner@dim.test always
//     has pets (seed-test-users guarantees 3), so the chain never stops at "/".
//   /gob → requireAdminOrGovtOrRedirect sends personal-role users to
//     /acceso-denegado?portal=gob (A4 — deliberately no longer the silent
//     bounce to /mis-mascotas this pattern encoded).
const OPERATOR_REDIRECT_SOURCES = [
  { path: "/admin", redirectPattern: /\/mis-mascotas/, allowBrandedNotFound: false },
  // /acceso-denegado deliberately renders the BrandedNotFound component
  // (app/acceso-denegado/page.tsx) — the boundary IS the surface to measure.
  { path: "/gob", redirectPattern: /\/acceso-denegado/, allowBrandedNotFound: true },
] as const;

test.describe("operator routes — redirect targets are axe-clean (WCAG 2.1 AA)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, ACCOUNTS.owner);
  });

  for (const { path, redirectPattern, allowBrandedNotFound } of OPERATOR_REDIRECT_SOURCES) {
    test(`a11y(axe) ${path} redirect target — WCAG 2.1 AA`, async ({ page }) => {
      await page.goto(path);

      // Wait for the redirect to settle.
      await page.waitForURL(
        (url) => redirectPattern.test(url.pathname) || !url.pathname.startsWith(path),
        { timeout: 10_000 },
      );
      await page.waitForLoadState("networkidle");
      // The DESTINATION is the subject, so assert the destination. Passing a
      // prose label here ("/admin -> redirect target") is what the old version
      // did, and since assertRealPage only used its second argument for error
      // text, the destination was never checked at all.
      await assertRealPage(page, redirectPattern, undefined, { allowBrandedNotFound });

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .disableRules(["color-contrast"])
        .analyze();

      expect(results.violations).toEqual([]);
    });
  }
});

// THE ROUTE IS /mis-mascotas/[publicToken]/anotar. There is no top-level
// `/anotar`: no app/(app)/anotar/**, not one `href="/anotar"` anywhere in app/,
// components/ or lib/, and next.config.ts declares headers() only — no rewrite.
//
// This whole describe block audited `/anotar` and the comment on it asserted
// the premise that made it look reasonable: "without a petToken it redirects or
// shows a picker. Either is a real surface." Neither happens. It 404s, and a
// branded 404 is a small clean page that axe scores at zero violations. The
// route literal is discovered from the owner's own registry for the same reason
// the rest of the suite does it (DIM-B4KS-KWZA, then DIM-DEMO-0001, both rotted).
test.describe("owner route /mis-mascotas/[token]/anotar — axe-clean (WCAG 2.1 AA)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, ACCOUNTS.owner);
  });

  test("a11y(axe) /mis-mascotas/[token]/anotar — WCAG 2.1 AA (no critical violations)", async ({
    page,
  }) => {
    const token = await discoverPetToken(page);
    const route = `/mis-mascotas/${token}/anotar`;
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    await assertRealPage(page, route);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .disableRules(["color-contrast"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});
