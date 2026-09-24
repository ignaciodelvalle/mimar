import { expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

// The operator's "← Volver a mi app" on a public surface points at their OWN
// portal.
//
// It used to point at /mis-mascotas — resolveShellNav called it "their personal
// escape hatch" — but app/(app)/layout.tsx redirects govt to /gob and admin to
// /admin before that page renders. So the affordance advertised a destination
// the product refuses to serve: a funcionario on /adoptar clicked it, paid a
// redirect, and landed back on /gob (measured 2026-08-08).
//
// Same shape as the /gob rail bug found the same day: two decisions taken
// separately, disagreeing about whether a state is reachable. Asserted on the
// HREF as well as the landing URL, because a redirect hides the mismatch —
// you end up in the right place either way, and only the href tells you the
// product knew where it was sending you.

const CASES = [
  { account: ACCOUNTS.govtLocal, role: "funcionario", home: "/gob" },
  { account: ACCOUNTS.admin, role: "admin", home: "/admin" },
] as const;

for (const c of CASES) {
  test(`un ${c.role} en una superficie publica vuelve a ${c.home} sin rebote`, async ({ page }) => {
    await loginAs(page, c.account);
    await page.goto("/adoptar");

    const back = page.getByRole("link", { name: /volver a mi app/i }).first();
    await expect(back).toBeVisible();

    // The href itself must be honest — not a page that only redirects here.
    await expect(back, `el href debe apuntar a ${c.home}, no a /mis-mascotas`).toHaveAttribute(
      "href",
      c.home,
    );

    await back.click();
    await page.waitForURL(`**${c.home}`);
    expect(page.url()).toContain(c.home);
  });
}
