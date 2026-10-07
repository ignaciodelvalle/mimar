import { expect, test } from "@playwright/test";

import { LEGAL_VERSION } from "@dim/contract/reference";
import { legalVersionForEmail, setLegalVersionForEmail } from "./demo/_db-cleanup";
import { ACCOUNTS, loginAs } from "./demo/_helpers";

/**
 * The legal re-acceptance circuit, walked in a browser (2026-10-07; security
 * review of textos-legales-v14, finding 7). An owner whose recorded legal
 * version is older than the current one is sent to /aceptar-condiciones at
 * sign-in and from any owner page, can still reach /cuenta/privacidad, sees
 * what changed since THEIR version, and is let through once the three boxes
 * are ticked — with the acceptance recorded under the current version.
 *
 * The account is put on the old version in this spec's own setup and put back
 * on the current one at the end, whatever happens. That needs the LOCAL
 * database, so against a deployed origin the spec skips and says why (an
 * environmental condition, not a missing fixture).
 */

const EMAIL = ACCOUNTS.owner2;

test.describe.configure({ mode: "serial" });

test("an owner on an old legal version re-accepts before using the portal", async ({ page }) => {
  const stamped = await setLegalVersionForEmail(EMAIL, "2026-09-24");
  test.skip(!stamped, "needs the local database to put the account on an old legal version");
  try {
    await loginAs(page, EMAIL, { fresh: true });

    // The gate, from any owner page.
    await page.goto("/mis-mascotas");
    await expect(
      page.getByRole("heading", { name: "Actualizamos los términos y la política de privacidad" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/aceptar-condiciones");

    // What changed since 2026-09-24, and nothing older.
    await expect(page.getByText("Te pedimos que confirmes que tenés 18 años o más.")).toBeVisible();
    await expect(page.getByText(/nombra a cada proveedor/)).toHaveCount(0);

    // The way out stays open.
    await page.goto("/cuenta/privacidad");
    expect(new URL(page.url()).pathname).toBe("/cuenta/privacidad");

    // Accept.
    await page.goto("/aceptar-condiciones?returnTo=%2Fmis-mascotas");
    for (const name of ["tosAccepted", "transferAccepted", "adultDeclared"]) {
      await page.locator(`input[name="${name}"]`).check();
    }
    await page.getByRole("button", { name: "Aceptar y continuar" }).click();

    // The OUTCOME, not the post-action URL (e2e/README.md): the acceptance is
    // on record under the current version, and the portal opens.
    await expect.poll(() => legalVersionForEmail(EMAIL), { timeout: 15_000 }).toBe(LEGAL_VERSION);
    // A NEW TAB, not this one: the action's own full-page navigation to the
    // returnTo is still in flight here, and a goto on the same page races it
    // (net::ERR_ABORTED). Same browser context, so the same session.
    const portal = await page.context().newPage();
    await portal.goto("/mis-mascotas");
    expect(new URL(portal.url()).pathname).toBe("/mis-mascotas");
    await portal.close();
  } finally {
    await setLegalVersionForEmail(EMAIL, LEGAL_VERSION);
  }
});
