import { type Page, expect, test } from "@playwright/test";

import { passwordForPage } from "./_credentials";
import { passSecondFactorIfAsked, skipUnlessRemoteLoginAllowed } from "./_mfa";
import { SIGN_IN_PATH, leftSignIn } from "./_sign-in-route";

/**
 * WP3 / D1 — admin topbar polish.
 *
 * Asserts the two D1 acceptance criteria for /admin:
 *   1. The topbar stays on a SINGLE line at ≥1280px (1280 and 1366) — the
 *      breadcrumb truncates instead of wrapping the chrome onto a second row.
 *   2. The page H1 carries more visual weight than the scope chip — the chip is
 *      now a neutral/outline element, not a saturated badge that competes with
 *      the heading.
 *
 * Auth: page-level login as admin (same mechanism as executive-smoke.spec.ts).
 * Seeding: pnpm db:bootstrap → pnpm seed:test (admin@dim.test).
 */

const WIDTHS = [1280, 1366] as const;

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(SIGN_IN_PATH);
  // admin@ is not a rotated e2e account and is locked on staging: skip on a
  // remote target BEFORE the password is resolved or typed.
  skipUnlessRemoteLoginAllowed(page.url(), "admin@dim.test");
  const password = passwordForPage(page.url(), "admin@dim.test");
  await page.getByLabel(/correo electrónico/i).fill("admin@dim.test");
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: /iniciar sesión/i }).click();
  await page.waitForURL(leftSignIn, { timeout: 20_000 });
  await passSecondFactorIfAsked(page, "admin@dim.test", password);
}

async function computedFont(
  locator: ReturnType<Page["locator"]>,
): Promise<{ fontSize: number; fontWeight: number }> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el as Element);
    return { fontSize: Number.parseFloat(s.fontSize), fontWeight: Number(s.fontWeight) || 400 };
  });
}

test.describe("admin topbar — single line + chip < H1 weight (D1)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const width of WIDTHS) {
    test(`topbar stays on one line at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      // domcontentloaded, NOT the default 'load': the admin analytics pages pull
      // heavy client chunks (recharts/maplibre) whose 'load' can exceed 30s on a
      // full-seed box. The topbar + H1 are server-rendered, so they are present
      // and measurable at domcontentloaded (matches executive-smoke.spec.ts).
      await page.goto("/admin/programa", { waitUntil: "domcontentloaded" });

      const topbar = page.getByTestId("admin-topbar");
      await expect(topbar).toBeVisible();

      const box = await topbar.boundingBox();
      expect(box).not.toBeNull();
      // A single-line topbar is ~44px (py-[11px] + one text row). A wrapped
      // topbar jumps to ~70px+. 56px is a safe single-line ceiling.
      expect(
        box?.height ?? 999,
        `topbar wrapped at ${width}px (height ${box?.height})`,
      ).toBeLessThan(56);
    });
  }

  test("page H1 out-weighs the scope chip", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto("/admin/programa", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");

    const h1 = page.locator("h1").first();
    const chip = page.getByText("SUPERADMIN", { exact: true });
    await expect(h1).toBeVisible();
    await expect(chip).toBeVisible();

    const h1Font = await computedFont(h1);
    const chipFont = await computedFont(chip);

    expect(h1Font.fontSize).toBeGreaterThan(chipFont.fontSize);
    expect(h1Font.fontWeight).toBeGreaterThanOrEqual(chipFont.fontWeight);
  });
});
