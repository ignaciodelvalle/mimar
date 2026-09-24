import { type Page, expect, test } from "@playwright/test";

import { ACCOUNTS, assertRealPage, discoverPetToken, loginAs } from "./demo/_helpers";

/**
 * CSP regression guard — public pages only.
 *
 * This session found a real Content-Security-Policy violation on
 * /denuncias/nueva: a modulepreload for the lazy `LocationPicker` (maplibre)
 * chunk loads outside the nonce chain —
 *   "Loading the script '/_next/static/chunks/NNNN.*.js' violates the
 *    following Content Security Policy directive: script-src 'self'
 *    'nonce-...' 'strict-dynamic'"
 * — and was verified COSMETIC: the step-3 map still renders because the
 * chunk reloads via the nonce-trusted runtime. A cheap console listener
 * would have caught it, and will catch any NEW, non-cosmetic CSP
 * regression on these pages going forward.
 *
 * Each test attaches a page.on("console") listener BEFORE navigation,
 * collects messages matching the CSP-violation signature, navigates, waits
 * for the page to settle, then asserts no un-allowlisted violations
 * occurred. The ONLY allowlisted violation is the known-cosmetic
 * /denuncias/nueva chunk preload above — matched by a STABLE signature
 * (chunk path + page), not by the build-specific chunk hash. Any other CSP
 * violation — on any page, including a different chunk on
 * /denuncias/nueva, or any inline-script refusal anywhere — fails the test.
 *
 * ---------------------------------------------------------------------------
 * P2.3 — THE PAGE MUST BE THE PAGE BEFORE ANYTHING IS MEASURED
 * ---------------------------------------------------------------------------
 * A CSP listener measures ABSENCE. A not-found boundary is a small static page
 * with no map, no QR, no lazy chunk and no inline script: it raises zero
 * violations, so this suite reported GREEN for a route it never loaded. That is
 * the same silent pass A7 found in a11y-regression (axe scoring a 404
 * "critical=0"). It first bit on `/p/DIM-DEMO-0001` — a demo-tier token
 * `pnpm db:bootstrap` never seeds — but the hole was never specific to that
 * route: NONE of the pages below proved they had rendered either.
 *
 * So every route now carries a MARKER — an element only the real page renders —
 * and goes through the shared `assertRealPage()` (e2e/demo/_helpers.ts) before
 * the violation list is read. Absence-of-404 alone is not enough; the marker is
 * the positive half.
 *
 * Do not add a route here without a marker, and do not hardcode a pet token —
 * the credential test discovers one from the owner's own registry at runtime.
 */

const CSP_VIOLATION_PATTERN =
  /Content Security Policy|violates the following Content Security Policy|Refused to (load|execute)/i;

/**
 * Public routes, each with the element that PROVES it rendered. Markers are
 * anchored on the route's own `<h1>` (or, for the wizard, its first step
 * control) — the one thing a not-found boundary cannot produce.
 */
const PUBLIC_PAGES: ReadonlyArray<{
  path: string;
  marker: (page: Page) => ReturnType<Page["locator"]>;
}> = [
  {
    // Landing: the crisis band is above the fold on every viewport and is the
    // landing's own markup, not shared chrome. Anchored on the band's landmark
    // label rather than its copy: a60e4f1a rewrote the copy ("three doors, no
    // code lookup") and this marker kept chasing the old sentence for three
    // pushes — a label names WHAT the region is, so it survives a rewording.
    path: "/",
    marker: (page) => page.getByLabel(/^emergencias — sin cuenta$/i).first(),
  },
  {
    path: "/adoptar",
    marker: (page) => page.getByRole("heading", { name: /adoptar en/i, level: 1 }),
  },
  {
    path: "/perdidas",
    marker: (page) => page.getByRole("heading", { name: /mascotas\s+perdidas/i, level: 1 }),
  },
  {
    // The wizard's step-1 card group. Server-rendered copy would be enough to
    // prove the route resolved, but this also proves the client bundle ran —
    // and CSP violations are precisely a thing that stops it running.
    path: "/denuncias/nueva",
    marker: (page) => page.locator('label:has(input[name="kindCard"])').first(),
  },
  {
    path: "/refugios",
    marker: (page) => page.getByRole("heading", { name: /refugios y redes de rescate/i, level: 1 }),
  },
];

// The one verified-cosmetic violation: a modulepreload for the lazy
// LocationPicker (maplibre) chunk on /denuncias/nueva, refused because it
// loads outside the nonce chain. Chunk hashes are build-specific, so we
// match on the stable parts of the signature instead of a hardcoded hash.
function isKnownCosmeticViolation(path: string, message: string): boolean {
  return path === "/denuncias/nueva" && message.includes("_next/static/chunks/");
}

/** Collect CSP-violation console messages from BEFORE navigation onwards. */
function watchCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (CSP_VIOLATION_PATTERN.test(text)) violations.push(text);
  });
  return violations;
}

for (const { path, marker } of PUBLIC_PAGES) {
  test(`${path} → no unexpected CSP violations`, async ({ page }) => {
    const violations = watchCspViolations(page);

    await page.goto(path);
    await page.waitForLoadState("networkidle");

    // Gate first: a 404 or a crashed route raises no CSP violations, so
    // measuring one would report green for a page that never loaded.
    await assertRealPage(page, path, marker(page));

    const unexpected = violations.filter((text) => !isKnownCosmeticViolation(path, text));

    expect(unexpected, `Unexpected CSP violation(s) on ${path}:\n${unexpected.join("\n")}`).toEqual(
      [],
    );
  });
}

test("/p/[token] → no unexpected CSP violations (on a credential that exists)", async ({
  browser,
  page,
}) => {
  // Token discovered from the owner's registry, then loaded anonymously.
  // NEVER a literal: `DIM-DEMO-0001` lives in scripts/seed-owner-demo.ts, which
  // `pnpm db:bootstrap` does not run, so in CI it resolves to the (public)
  // not-found boundary.
  const owner = await browser.newContext();
  let token: string;
  try {
    const ownerPage = await owner.newPage();
    await loginAs(ownerPage, ACCOUNTS.owner);
    token = await discoverPetToken(ownerPage);
  } finally {
    await owner.close();
  }

  const violations = watchCspViolations(page);

  await page.goto(`/p/${token}`);
  await page.waitForLoadState("networkidle");

  // PROVE the credential rendered, via the SHARED guard — which, unlike the
  // bespoke check that used to be here, also recognises the (public) group's
  // "No encontramos esa credencial" boundary.
  await assertRealPage(
    page,
    `/p/${token}`,
    page.getByText("Credencial pública", { exact: true }).first(),
  );

  expect(
    violations,
    `Unexpected CSP violation(s) on /p/${token}:\n${violations.join("\n")}`,
  ).toEqual([]);
});
