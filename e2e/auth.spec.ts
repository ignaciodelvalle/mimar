import { expect, test } from "@playwright/test";

import { passwordForPage } from "./_credentials";
import { LEGACY_SIGN_IN_PATH, SIGN_IN_PATH } from "./_sign-in-route";

/**
 * Authentication e2e tests.
 *
 * Uses the OWNER account seeded by `pnpm db:bootstrap` → `pnpm seed:test`.
 * Credentials are the fixed test-data values from scripts/seed-test-users.ts:
 *   email:    owner@dim.test
 *   password: "Test1234!" locally; E2E_STAGING_PASSWORD from env against a
 *             remote target (see e2e/_credentials.ts).
 *
 * The suite uses Playwright's storageState to avoid re-logging in on every
 * test in downstream specs. The saved state file lives in e2e/.auth/ and is
 * git-ignored.
 */

const OWNER_EMAIL = "owner@dim.test";

test.describe("login flow", () => {
  test("owner can log in and lands on /inicio", async ({ page }) => {
    await page.goto(SIGN_IN_PATH);
    const password = passwordForPage(page.url(), OWNER_EMAIL);

    // Fill credentials.
    await page.getByLabel(/correo electrónico/i).fill(OWNER_EMAIL);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: /iniciar sesión/i }).click();

    // After successful login the app redirects to /inicio.
    await page.waitForURL(/\/inicio/, { timeout: 15_000 });
    expect(page.url()).toContain("/inicio");

    // No error visible.
    await expect(page.getByText(/application error/i)).not.toBeVisible();
    await expect(page.getByText(/correo o contraseña incorrectos/i)).not.toBeVisible();
  });
});

/**
 * La ruta vieja en inglés. `app/(auth)/login/page.tsx` promete en su propio
 * encabezado que el stub se queda PARA SIEMPRE porque la URL está impresa en
 * documentos, guardada en favoritos y pegada en mails ya enviados — y nada lo
 * verificaba. El resto de la suite ya no la visita (lo impide
 * `__tests__/e2e-sign-in-route.test.ts`), así que si no se prueba acá, no se
 * prueba en ningún lado.
 */
test.describe("la ruta vieja en inglés sigue funcionando", () => {
  test("redirige a /iniciar-sesion conservando el query string", async ({ page }) => {
    // `returnTo` es el que importa: es lo que devuelve al visitante adonde
    // estaba yendo cuando lo mandaron a autenticarse. Perderlo lo vara.
    await page.goto(`${LEGACY_SIGN_IN_PATH}?intent=adoptar&returnTo=%2Fadoptar`);

    const url = new URL(page.url());
    expect(url.pathname, "la ruta vieja aterriza en la canónica").toBe(SIGN_IN_PATH);
    expect(url.searchParams.get("intent")).toBe("adoptar");
    expect(url.searchParams.get("returnTo")).toBe("/adoptar");

    // Y aterriza en el formulario de verdad, no en un 404 con la URL correcta.
    await expect(page.getByRole("textbox", { name: "Contraseña" })).toBeVisible();
  });
});
