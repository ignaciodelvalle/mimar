import { expect, test } from "@playwright/test";

import { passwordForPage } from "./_credentials";
import { SIGN_IN_PATH } from "./_sign-in-route";

/**
 * Auth-bypass tests — the highest-value e2e guard.
 *
 * An OWNER (lowest-privilege authenticated role) must NOT be able to access:
 *   - /admin  → requires role=admin  + institutional account
 *   - /gob    → requires role=admin OR role=govt
 *
 * Both layouts call requireAdminOrRedirect / requireAdminOrGovtOrRedirect
 * which redirect non-privileged users to / and /mis-mascotas respectively.
 * This suite ensures those guards fire at the browser level, not just in
 * unit tests.
 */

const OWNER_EMAIL = "owner@dim.test";

test.describe("auth bypass — owner cannot access privileged dashboards", () => {
  test.beforeEach(async ({ page }) => {
    // Log in as owner once; subsequent navigations in the same test reuse the
    // session cookie set by the server.
    await page.goto(SIGN_IN_PATH);
    const password = passwordForPage(page.url(), OWNER_EMAIL);
    await page.getByLabel(/correo electrónico/i).fill(OWNER_EMAIL);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();
    await page.waitForURL(/\/inicio/, { timeout: 15_000 });
  });

  test("owner is redirected away from /admin", async ({ page }) => {
    await page.goto("/admin");

    // requireAdminOrRedirect sends non-admins to /.
    // Wait for the redirect to settle.
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"), { timeout: 10_000 });

    expect(page.url()).not.toContain("/admin");

    // Must NOT see the admin dashboard landmark (OpShell / admin navigation).
    await expect(page.getByText(/panel de administración/i)).not.toBeVisible();
    await expect(page.getByRole("navigation", { name: /admin/i })).not.toBeVisible();
  });

  test("owner is redirected away from /gob", async ({ page }) => {
    await page.goto("/gob");

    // requireAdminOrGovtOrRedirect sends owners to /mis-mascotas.
    await page.waitForURL((url) => !url.pathname.startsWith("/gob"), { timeout: 10_000 });

    expect(page.url()).not.toContain("/gob");

    // Must NOT see the gobierno dashboard content.
    await expect(page.getByText(/panel de gobierno/i)).not.toBeVisible();
  });
});
