import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { BRANDED_NOT_FOUND_TESTID } from "./_page-identity";
import { SEED_PROFILE, seedFixtureVerdict } from "./_seed-profile";
import { SIGN_IN_PATH } from "./_sign-in-route";
import { assertRealPage } from "./demo/_helpers";

/**
 * Fixture gate. The three checks below need data the seed may or may not
 * publish, and they used to `test.skip()` on DATA PRESENCE — which self-retires
 * the day the data goes away and reports green forever after.
 *
 * They now branch on the ENVIRONMENT instead (e2e/_seed-profile.ts): a missing
 * fixture is a documented state of `pnpm db:bootstrap` and skips there, and is
 * a FAILURE on the fully seeded staging origin the nightly pass drives.
 */
function requireSeedFixture(found: number, fixture: string, untested: string): void {
  const outcome = seedFixtureVerdict(found, fixture, untested, SEED_PROFILE);
  if (outcome.verdict === "fail") throw new Error(outcome.reason);
  if (outcome.verdict === "skip") test.skip(true, outcome.reason);
}

/**
 * Public smoke tests — no auth required.
 *
 * Each test navigates to a public route and asserts:
 *   1. The page returns 200 (navigation succeeds, no 500).
 *   2. No React error boundary / unhandled error is rendered.
 *   3. A meaningful landmark element is visible (page actually rendered).
 *
 * This suite would have caught:
 *   - The /denuncias 404 (route missing).
 *   - A /p-style 500 (server crash before SSR completes).
 *
 * A11y check (WCAG 2.1 AA):
 *   - /denuncias and /denuncias/buscar are checked with axe-core (static).
 *   - A public DYNAMIC pet page is covered via /adoptar/[token]: the test
 *     discovers a real adoptable-pet link from the /adoptar listing (no
 *     hardcoded DB token) and skips cleanly if none are seeded.
 *   - /p/[token] (QR credential) is still not axe-tested directly — it isn't
 *     linked from any public page, so it needs an authed token-discovery flow.
 */

const PUBLIC_ROUTES = [
  { path: "/", landmark: "main" },
  { path: "/adoptar", landmark: "main" },
  { path: "/perdidas", landmark: "main" },
  { path: "/refugios", landmark: "main" },
  { path: "/denuncias", landmark: "main" },
  // La canónica, no la vieja: el 308 de `/login` tiene su propia cobertura en
  // e2e/auth.spec.ts, y humear la vieja acá medía la redirección, no la página.
  { path: SIGN_IN_PATH, landmark: "main" },
  { path: "/registro", landmark: "main" },
] as const;

for (const { path, landmark } of PUBLIC_ROUTES) {
  test(`${path} → 200 and no error boundary`, async ({ page }) => {
    const response = await page.goto(path);

    // 1. HTTP status must be 2xx (or 3xx redirect that resolves to 2xx).
    expect(response?.status()).toBeLessThan(400);

    // 2. No error boundary visible. Next.js renders a <h2> or <p> with
    //    "Application error" on unhandled server errors in production builds.
    await expect(page.getByText(/application error/i)).not.toBeVisible();
    await expect(page.getByText(/internal server error/i)).not.toBeVisible();
    await expect(page.getByText(/this page isn't working/i)).not.toBeVisible();

    // 3. Page rendered a content landmark.
    await expect(page.locator(landmark).first()).toBeVisible();

    // 4. At most ONE #main-content landmark. The (public) layout migrated to
    //    AppShell variant=citizen (Item 7, Phase C) which owns #main-content;
    //    this guards against the duplicate-<main> regression where a page that
    //    used to own its own <main> ends up wrapped by a shell that adds another
    //    (the skip-link target must be unambiguous — WCAG 2.4.1).
    expect(await page.locator("#main-content").count()).toBeLessThanOrEqual(1);
  });
}

// Invalid / expired / mistyped credential token must render the BRANDED Spanish
// not-found (app/(public)/not-found.tsx) — not Next.js's black English default
// 404 ("This page could not be found"). UX audit remediation — Fase 0 item 0.4.
test("/p/[invalid token] → branded Spanish not-found (not the English default)", async ({
  page,
}) => {
  const response = await page.goto("/p/DIM-0000-0000");

  // notFound() returns a 404, never a 500.
  expect(response?.status()).toBeLessThan(500);

  // Branded Spanish copy + a way forward (link to lost-pet directory).
  await expect(page.getByText(/no encontramos esa credencial/i)).toBeVisible();
  await expect(page.locator('a[href="/perdidas"]').first()).toBeVisible();

  // Must NOT be the Next.js black English default 404.
  await expect(page.getByText(/this page could not be found/i)).not.toBeVisible();
});

// A VALID lost-mode credential must render (200, no error boundary).
// UX audit remediation — Fase 0 item 0.1, the WORST crash: a stranger scanning
// the QR of a LOST pet got "Algo salió mal" instead of the contact/sighting
// credential. The lost render path threw in a Server Components render.
// /perdidas lists lost pets and links each to /p/[token]; we discover one
// (no hardcoded DB token) and assert the lost path no longer throws. Skips
// cleanly when no lost pets are seeded so it never flakes on an empty DB.
test("/p/[token] lost-mode credential → 200, no error boundary (UX 0.1 regression)", async ({
  page,
}) => {
  await page.goto("/perdidas");
  await page.waitForLoadState("networkidle");

  const credLink = page.locator('a[href^="/p/"]').first();
  requireSeedFixture(
    await credLink.count(),
    "lost-pet credential link on /perdidas",
    "the UX-0.1 lost-mode render regression guard",
  );

  const href = await credLink.getAttribute("href");
  expect(href).toBeTruthy();

  const response = await page.goto(href as string);

  // The lost render path must not 5xx (0.1 was a Server Components render throw).
  expect(response?.status()).toBeLessThan(500);

  // No React error boundary / branded error screen.
  await expect(page.getByText(/application error/i)).not.toBeVisible();
  await expect(page.getByText(/internal server error/i)).not.toBeVisible();
  await expect(page.getByText(/algo salió mal/i)).not.toBeVisible();

  // It rendered a real credential — not the invalid-token not-found.
  await expect(page.getByText(/no encontramos esa credencial/i)).not.toBeVisible();
  await expect(page.locator("main").first()).toBeVisible();
});

// A11y on a VALID lost-mode credential — the hero moment, and Ley 26.653 applies.
// The file header notes /p/[token] was not axe-tested directly because it isn't
// linked from any public page; /perdidas DOES link lost credentials, so we can
// now cover the lost-mode render. Skips cleanly when no lost pets are seeded.
test("a11y(axe) /p/[token] lost-mode credential — WCAG 2.1 AA", async ({ page }) => {
  await page.goto("/perdidas");
  await page.waitForLoadState("networkidle");

  const credLink = page.locator('a[href^="/p/"]').first();
  // A SKIP HERE MEANS THIS SURFACE HAS NO COVERAGE ON THIS RUN. `pnpm
  // db:bootstrap` (all the CI e2e job runs) seeds reference data plus
  // scripts/seed-test-users.ts, and neither marks a pet lost — so /perdidas is
  // empty in CI and this scan, on the surface the file itself calls "the hero
  // moment" under Ley 26.653, had almost certainly never executed there.
  //
  // That fixture gap must be closed in scripts/, not here, so absence still
  // skips under the bootstrap seed. But it is no longer keyed on the DATA: on
  // the nightly staging pass — where /perdidas listed 317 lost pets when this
  // was written — an empty listing now FAILS instead of quietly retiring the
  // only axe audit this surface has.
  requireSeedFixture(
    await credLink.count(),
    "lost-pet credential link on /perdidas",
    "the axe audit of the lost-mode credential (Ley 26.653 hero surface)",
  );

  const href = await credLink.getAttribute("href");
  await page.goto(href as string);
  await page.waitForLoadState("networkidle");
  // /p/[token] is a (public) route, so its boundary reads "No encontramos esa
  // credencial" — the exact copy that once let a11y-regression and csp-smoke
  // both audit a 404 and report clean. Never measure this route unguarded.
  await assertRealPage(page, href as string);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .disableRules(["color-contrast"]) // contrast validated via design tokens separately
    .analyze();

  expect(results.violations).toEqual([]);
});

// A11y checks on static public pages (no auth / no dynamic token required).
// Scoped to WCAG 2.1 AA; color-contrast is excluded because design-token
// contrast ratios are validated separately (P-1 in the a11y audit).
//
// Wave 2 Item 11 extends coverage to all high-exposure public surfaces
// (Ley 26.653 applies to all government-facing web pages):
//   /adoptar, /refugios, /casos, /libreta/compartir, /r/invite
//   (previously only /denuncias and /denuncias/buscar were covered)
//
// `/refugios` was added when the public (public) layout migrated to AppShell
// variant=citizen (Item 7, Phase C): it exercises the new citizen masthead +
// footer chrome so the migration cannot regress a11y. (The home `/` lives at
// app/page.tsx, outside the (public) group, and is not migrated by Phase C.)
// `/casos` WAS LISTED HERE AND IS NOT A ROUTE. app/(public)/casos/ contains
// only `[publicCode]/` — there is no casos/page.tsx, a single dynamic segment
// does not match zero segments, and next.config.ts declares headers() only, no
// rewrites. `/casos` resolves to the branded 404, and the comment that used to
// sit on this line ("renders a search/listing landing — static, no DB token
// required") was simply false. The string appears exactly ONCE in the whole
// repo: right here. Nothing links to it, nothing serves it.
//
// It is removed rather than repointed at /casos/[publicCode], which would need
// a discovered code and belongs with the other token-gated scans below.
//
// Third instance of this class (after DIM-B4KS-KWZA and DIM-DEMO-0001): a route
// literal that no longer resolves, audited as if it did, reporting clean.
const A11Y_ROUTES = ["/refugios", "/adoptar", "/denuncias", "/denuncias/buscar"] as const;

for (const path of A11Y_ROUTES) {
  test(`a11y(axe) ${path} — WCAG 2.1 AA (no critical violations)`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // NOT redundant with the PUBLIC_ROUTES block above — that list and this one
    // are separate, and nothing status-asserts A11Y_ROUTES. (An earlier version
    // of this comment claimed "these routes are asserted 200 above"; it was
    // wrong, and `/casos` sat in this list precisely because nothing checked.)
    await assertRealPage(page, path);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .disableRules(["color-contrast"]) // contrast validated via design tokens separately
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

// A11y on token-gated public pages using a fake/nonexistent token.
// When the token is invalid/expired the page must render a surface a human can
// read, and that surface must itself be axe-clean (Ley 26.653).
//
// EACH ROUTE DECLARES WHICH SURFACE IT OWES. This block used to end with
//
//     if (response?.status() === 404) return;   // "no content to audit"
//
// which disarmed the scan for exactly the case it was written to cover. It was
// not hypothetical: /libreta/compartir/[shareToken] calls notFound() on an
// unknown token, so that route took the early return on EVERY run and its axe
// audit has never executed. Worse, the same line is a silent kill switch — a
// change turning /r/invite's friendly state into a bare notFound() would remove
// both the surface AND its audit, and this file would stay green.
//
// A 404 page is still a page, and Ley 26.653 still applies to it. So the 404 is
// asserted as the DECLARED outcome and audited, rather than treated as an
// excuse to measure nothing.
// Route-specific copy. The shared boundary identity comes from
// e2e/_page-identity.ts (kept honest by __tests__/e2e-page-identity.test.ts) —
// do not re-derive it here.
const INVITE_INVALID_HEADING = /Invitación (no encontrada|ya aceptada|revocada|vencida)/i;

for (const { path, description, expectedStatus, surface } of [
  {
    path: "/libreta/compartir/axe-test-invalid-token",
    description: "/libreta/compartir/[shareToken] — expired/invalid state",
    // page.tsx: `if (!share) notFound()` — the branded boundary IS this route's
    // invalid-token surface. Keyed on the testid, not the copy, so a wording
    // change cannot disarm it.
    //
    // Status 200, not 404: the route streams (a Suspense skeleton flushes the
    // shell before the token lookup resolves — CSP/no-prerender move), so
    // notFound() fires after headers went out and the status can no longer
    // carry the verdict. The SURFACE assertion below is the real guard; the
    // 200 is declared so a future return to a blocking 404 shows up here as
    // a deliberate shape change rather than silently passing both ways.
    expectedStatus: 200,
    surface: (page: Page) => page.getByTestId(BRANDED_NOT_FOUND_TESTID),
  },
  {
    path: "/r/invite/axe-test-invalid-token",
    description: "/r/invite/[token] — expired/invalid invite state",
    // page.tsx documents "Invalid/expired/revoked tokens render a friendly
    // error, NOT notFound()" — so a 404 here is a regression, not an
    // acceptable alternative.
    expectedStatus: 200,
    surface: (page: Page) => page.getByText(INVITE_INVALID_HEADING).first(),
  },
]) {
  test(`a11y(axe) ${description} — WCAG 2.1 AA`, async ({ page }) => {
    const response = await page.goto(path);

    expect(
      response?.status(),
      `${path}: the invalid-token surface changed shape — update the declaration above, do not widen the assertion`,
    ).toBe(expectedStatus);

    await page.waitForLoadState("networkidle");

    // Prove WHICH surface axe is about to measure. Without this, a blank body
    // scores critical=0 and the audit reports clean.
    await expect(
      surface(page),
      `${path}: the declared invalid-token surface never rendered — axe would audit nothing`,
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .disableRules(["color-contrast"])
      .analyze();

    expect(results.violations).toEqual([]);
  });
}

// A11y on a PUBLIC DYNAMIC pet page. /p/[token] (the QR credential) isn't
// linked from any public page, so instead we cover the public adoption detail
// /adoptar/[token]: discover a real adoptable-pet link from the /adoptar
// listing (no hardcoded DB token), then axe it. Skips cleanly when no
// adoptable pets are seeded so it never flakes on an empty DB.
test("a11y(axe) /adoptar/[token] — public pet detail (WCAG 2.1 AA)", async ({ page }) => {
  await page.goto("/adoptar");
  await page.waitForLoadState("networkidle");

  const petLink = page.locator('a[href^="/adoptar/"]').first();
  // Same class as the lost-credential gate above: db:bootstrap publishes no
  // adoption listing, so this skips under that seed — and fails on staging,
  // which publishes them.
  requireSeedFixture(
    await petLink.count(),
    "adoptable-pet link on /adoptar",
    "the axe audit of the public pet detail /adoptar/[token]",
  );

  const href = await petLink.getAttribute("href");
  expect(href).toBeTruthy();

  await page.goto(href as string);
  await page.waitForLoadState("networkidle");
  // The link came from the listing, so the detail page should exist — "should"
  // is exactly the assumption this guard is for (a delisted pet 404s).
  await assertRealPage(page, href as string);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .disableRules(["color-contrast"])
    .analyze();

  expect(results.violations).toEqual([]);
});
