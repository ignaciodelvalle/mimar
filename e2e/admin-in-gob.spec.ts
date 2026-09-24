import { expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

// An admin who chooses "Ir a Gobierno" gets the Gobierno portal.
//
// The /gob layout used to swap the ADMIN rail in for an admin viewer
// (red-team-admin-2 P2.1) — correct when an admin was REDIRECTED here from
// /admin/moderacion, wrong once that redirect was gone. What was left was a
// product that offers the hop in the portal switcher and then refuses it: the
// left sections never changed, and since every one of them points at /admin,
// each click bounced the admin straight home (PO report 2026-08-08).
//
// Asserted at the RAIL, not at the page body: the symptom was navigational, and
// nothing about the page content changes when the wrong rail renders.

test("un admin que va a Gobierno ve las secciones de Gobierno, no las de Admin", async ({
  page,
}) => {
  await loginAs(page, ACCOUNTS.admin);
  await page.goto("/gob");

  const rail = page.getByRole("navigation").first();
  await expect(rail).toBeVisible();

  // The regression: a rail full of /admin destinations while standing on /gob.
  // One is enough to prove the wrong preset rendered; the count makes the
  // failure message say how wrong.
  const adminLinks = rail.locator('a[href^="/admin"]');
  await expect(adminLinks, "el rail de /gob no debe ofrecer destinos de /admin").toHaveCount(0);

  // ...and it must actually carry gob destinations, so an empty rail cannot
  // pass this test by having no links at all.
  await expect(rail.locator('a[href^="/gob"]').first()).toBeVisible();
});

test("clickear una seccion del rail deja al admin dentro de Gobierno", async ({ page }) => {
  // The test above proves the right rail RENDERS. This one reproduces the
  // symptom as it was actually reported — "cada vez que toco me devuelve a
  // admin" — by clicking and looking at where you end up. A rail can carry the
  // right hrefs and still bounce you if a page-level guard rejects the role,
  // and that would read to the operator as exactly the same bug.
  await loginAs(page, ACCOUNTS.admin);
  await page.goto("/gob");

  const rail = page.getByRole("navigation").first();
  const target = rail.locator('a[href^="/gob/"]').first();
  const href = await target.getAttribute("href");
  await target.click();

  await page.waitForURL(`**${href}**`);
  expect(page.url(), `un click en ${href} no debe terminar en /admin`).toContain("/gob");
});

test("desde Gobierno, el admin conserva la vuelta a su portal", async ({ page }) => {
  // The half that makes the change above safe: honouring the hop is only
  // acceptable while the way back stays one click away (buildSwitcher pushes
  // "Volver a Admin" for any path under /gob).
  await loginAs(page, ACCOUNTS.admin);
  await page.goto("/gob");

  // "Portales" is the TRIGGER's accessible name — it comes from the visible
  // label. `aria-label="Cambiar de portal"` lives on the popover's list, not on
  // the button, so targeting that string finds nothing.
  await page.getByRole("button", { name: "Portales" }).click();
  await expect(page.getByRole("link", { name: /volver a admin/i })).toBeVisible();
});
