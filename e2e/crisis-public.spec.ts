import { expect, test } from "@playwright/test";

/**
 * Crisis-path e2e — PUBLIC surfaces only (no auth).
 *
 * The lost-pet flow is DIM/MiMAR's core value: a stranger finds a pet,
 * scans its QR or types a code, and has to reach the right public page in
 * seconds. Integration tests (task #33) already cover the writer/query
 * logic behind this; this suite adds BROWSER-level regression armor for the
 * exact click/type path a real user takes.
 *
 * Real tokens are discovered from public listings at runtime — never
 * hardcoded DB ids — same convention as e2e/public-smoke.spec.ts. Tests
 * skip cleanly (not fail) when the environment has no seeded pet in the
 * relevant listing.
 */

test.describe("crisis entry — public credential + denuncia lookup (no login)", () => {
  // These used to drive the landing's code-lookup input. That control left the
  // band on 2026-08-19 (PO decision): both of its jobs had a better-labelled
  // door elsewhere, and it held the widest column of the highest-traffic page.
  //
  // What the control was a VEHICLE for is still covered here, at the surfaces
  // that own each job now. A direct hit on /p/[token] is also the truer
  // simulation of the real entry point: a stranger scans a QR, which navigates,
  // it does not type.
  test("a valid DIM code resolves to the pet's public credential", async ({ page }) => {
    // Discover a real, non-lost pet token from the public adoption listing.
    // queryAdoptionListing (src/modules/adoption/infrastructure/adoption-listing-read.ts,
    // D18 guard) excludes status='lost' and status='deceased', so any token
    // found here is guaranteed to render the ACTIVE (non-lost) branch.
    await page.goto("/adoptar");
    await page.waitForLoadState("networkidle").catch(() => {});
    const petLink = page.locator('a[href^="/adoptar/DIM"]').first();
    test.skip(
      (await petLink.count()) === 0,
      "No adoptable pets seeded — skipping public-credential smoke.",
    );
    const href = await petLink.getAttribute("href");
    const token = (href ?? "").split("/adoptar/")[1];
    expect(token, "token parsed from /adoptar listing").toBeTruthy();

    await page.goto(`/p/${token}`);
    await expect(page.getByText(/no encontramos esa credencial/i)).not.toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  });

  test("a pet-shaped bogus code resolves to the branded not-found (no crash)", async ({ page }) => {
    await page.goto("/p/DIM-ZZZZ-ZZZZ");
    await expect(page.getByText(/no encontramos esa credencial/i)).toBeVisible();
    await expect(page.getByText(/application error/i)).not.toBeVisible();
    await expect(page.getByText(/this page could not be found/i)).not.toBeVisible();
  });

  test("a malformed denuncia code is rejected inline, no navigation", async ({ page }) => {
    // Same guard, at the surface that owns the DEN lookup now.
    await page.goto("/denuncias/buscar");
    await page.locator("#code").fill("DEN-BAD");
    await page.getByRole("button", { name: /^buscar$/i }).click();

    await expect(page.getByText(/c[oó]digo inv[aá]lido/i)).toBeVisible();
    expect(page.url()).not.toContain("/denuncias/codigo/");
  });

  test("the landing crisis band offers three doors and no typed lookup", async ({ page }) => {
    await page.goto("/");
    const band = page.locator('[data-section="crisis-band"]');
    await expect(band.locator('[data-t="perdi"]')).toBeVisible();
    await expect(band.locator('[data-t="encontre"]')).toBeVisible();
    await expect(band.locator('[data-t="maltrato"]')).toBeVisible();
    await expect(band.locator("input")).toHaveCount(0);
  });
});

test.describe("public credential — lost vs non-lost contrast", () => {
  test("/p/[token] non-lost pet shows the Tier 0 view, no lost CTAs", async ({ page }) => {
    await page.goto("/adoptar");
    await page.waitForLoadState("networkidle").catch(() => {});
    const petLink = page.locator('a[href^="/adoptar/DIM"]').first();
    test.skip(
      (await petLink.count()) === 0,
      "No adoptable pets seeded — skipping tier-0 contrast case.",
    );
    const href = await petLink.getAttribute("href");
    const token = (href ?? "").split("/adoptar/")[1];

    const response = await page.goto(`/p/${token}`);
    expect(response?.status()).toBeLessThan(400);

    // Tier 0 identity chip, no lost-mode banner/CTAs. The chip copy reads
    // "NIVEL 0 · IDENTIDAD" in the es-AR UI; accept the legacy "TIER 0" wording
    // too so the guard is resilient to either.
    await expect(page.getByText(/(nivel|tier) 0 · identidad/i)).toBeVisible();
    await expect(page.locator('[data-section="lost-urgent-strip"]')).toHaveCount(0);
    await expect(page.getByText(/estoy perdid[oa]/i)).not.toBeVisible();
    // The "found this pet?" affordance is the active-credential equivalent
    // of the lost-mode finder CTAs — present here instead.
    await expect(page.getByText(/¿encontraste a esta mascota\?/i)).toBeVisible();
  });

  test("/p/[token] lost pet shows the lost state with finder CTAs (regression guard)", async ({
    page,
  }) => {
    // Best-effort discovery from the public lost-pets board. The
    // authenticated flow in e2e/crisis-owner-lost-flow.spec.ts drives and
    // asserts the full lost-mode field set precisely; this test is a light
    // guard that also catches a lost pet seeded by ANY other means (demo
    // seeds, storylines) so the render path stays covered even when this
    // spec runs alone.
    await page.goto("/perdidas");
    await page.waitForLoadState("networkidle").catch(() => {});
    const credLink = page.locator('a[href^="/p/"]').first();
    test.skip(
      (await credLink.count()) === 0,
      "No lost pets seeded — skipping lost-state contrast case.",
    );
    const href = await credLink.getAttribute("href");

    const response = await page.goto(href as string);
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByText(/application error/i)).not.toBeVisible();

    // A lost credential must expose SOME finder pathway — but the shape depends
    // on the pet's credential tier, and /perdidas can surface any tier. Higher
    // tiers render the lost-urgent-strip plus explicit finder channels; Tier 0
    // ("identidad") deliberately renders the "¿Encontraste a esta mascota?"
    // affordance instead (asserted in the Tier-0 case above). Accept either so
    // this guard stays green regardless of which tier the first lost pet is.
    const urgentBanner = page.locator('[data-section="lost-urgent-strip"]');
    const foundAffordance = page.getByText(/¿encontraste a esta mascota\?/i);
    await expect(urgentBanner.or(foundAffordance).first()).toBeVisible();

    // When the higher-tier banner is present, assert at least one explicit
    // finder channel (call / finder form / sighting form) rides along with it.
    if ((await urgentBanner.count()) > 0) {
      const hasCallBtn = await page.getByRole("link", { name: /llamar/i }).count();
      const hasFinderForm = await page
        .getByRole("link", { name: /(la|lo) tengo conmigo|está conmigo/i })
        .count();
      const hasSightingForm = await page.getByRole("link", { name: /la vi cerca de acá/i }).count();
      expect(hasCallBtn + hasFinderForm + hasSightingForm).toBeGreaterThan(0);
    }
  });
});
