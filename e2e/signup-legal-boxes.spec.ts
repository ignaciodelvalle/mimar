import { expect, test } from "@playwright/test";

import { SIGN_IN_PATH } from "./_sign-in-route";

/**
 * The three legal boxes at signup, in a real browser (2026-10-07; legal review
 * 2026-10-02 rows P9 and P10; PO decision D2 = b, conservative interim).
 *
 * jsdom proves each `<input>` carries `required`; only a browser proves that
 * `required` actually stops the submit (activation behaviour is not something
 * jsdom implements). So this spec fills everything EXCEPT one box, presses
 * "Continuar", and asserts the form never left step 1 — for each box in turn.
 *
 * NO ACCOUNT IS CREATED. Every walk is refused by the browser before a request
 * is sent, so nothing here spends the `auth_signup_ip` budget or leaves a user
 * behind on the shared DB.
 */

const BOXES = [
  { name: "tosAccepted", what: "the Terms and Privacy box" },
  { name: "transferAccepted", what: "the separate international-transfer box" },
  { name: "adultDeclared", what: "the 18+ box" },
] as const;

for (const missing of BOXES) {
  test(`/registro will not continue without ${missing.what}`, async ({ page }) => {
    await page.goto("/registro");
    await expect(page.getByText("Paso 1 de 2")).toBeVisible();

    await page.locator('input[name="email"]').fill("nadie@dim-test.local");
    await page.locator('input[name="password"]').fill("unaClaveLarga123");
    await page.locator('input[name="confirmPassword"]').fill("unaClaveLarga123");
    for (const box of BOXES) {
      if (box.name !== missing.name) await page.locator(`input[name="${box.name}"]`).check();
    }

    await page.getByRole("button", { name: "Continuar" }).click();

    // The browser refused: the unticked box reports a missing value, and the
    // page is still on step 1 (step 2 would read "Paso 2 de 2").
    const unticked = page.locator(`input[name="${missing.name}"]`);
    await expect(unticked).not.toBeChecked();
    expect(await unticked.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(
      true,
    );
    await expect(page.getByText("Paso 1 de 2")).toBeVisible();
    await expect(page.getByText("Paso 2 de 2")).toHaveCount(0);
  });
}

test("/registro shows the transfer consent set apart, naming both countries", async ({ page }) => {
  await page.goto("/registro");
  const group = page.locator("fieldset", { hasText: "Transferencia internacional de tus datos" });
  await expect(group).toBeVisible();
  await expect(group).toContainText("Brasil");
  await expect(group).toContainText("Estados Unidos");
  await expect(group.locator('a[href="/privacidad#proveedores"]')).toBeVisible();
});

test("/aceptar-condiciones sends a signed-out visitor to sign in", async ({ page }) => {
  await page.goto("/aceptar-condiciones");
  await expect(page).toHaveURL(new RegExp(`${SIGN_IN_PATH}`));
});
