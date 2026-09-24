import { expect, test } from "@playwright/test";

import { ACCOUNTS, loginAs } from "./demo/_helpers";

// Per-portal <title>.
//
// All four authenticated portals returned the ROOT title verbatim — "miMAR —
// Mi Mascota Argentina" — because none of their layouts exported `metadata`, so
// every one inherited app/layout.tsx. A funcionario working with /gob, /admin
// and /org open at once could not tell the tabs apart (QA 2026-08-07). The
// public routes were already fine.
//
// This is a regression test rather than a visual check because the failure mode
// is invisible in the page itself: nothing on screen changes when four tabs
// share a title, and nobody notices until they are hunting for the right tab.

const PORTALS = [
  { path: "/gob", account: ACCOUNTS.govtLocal, name: "Gobierno" },
  { path: "/admin", account: ACCOUNTS.admin, name: "Admin" },
  { path: "/mis-mascotas", account: ACCOUNTS.owner, name: "Mis mascotas" },
] as const;

for (const portal of PORTALS) {
  test(`el portal ${portal.path} se identifica en el titulo de la pestana`, async ({ page }) => {
    await loginAs(page, portal.account);
    await page.goto(portal.path);

    const title = await page.title();
    // The portal name must be there, and the brand must survive beside it.
    expect(title, `titulo de ${portal.path}`).toContain(portal.name);
    expect(title, `titulo de ${portal.path}`).toContain("miMAR");
    // The regression: the bare root title, with no portal in it.
    expect(title).not.toBe("miMAR — Mi Mascota Argentina");
  });
}

test("dos portales abiertos a la vez no comparten titulo", async ({ browser }) => {
  // The complaint was comparative, so assert it comparatively: every title can
  // contain "miMAR" and still be identical to its neighbour.
  //
  // TWO CONTEXTS, not two navigations in one page. The first draft reused a
  // single `page` and called loginAs twice; the second call lands on an app
  // that is already signed in as the first account, so the login form never
  // renders and the fill times out. Two contexts is also the honest model of
  // "two portals open at once" — which is the situation being defended.
  const adminCtx = await browser.newContext();
  const gobCtx = await browser.newContext();
  try {
    const adminPage = await adminCtx.newPage();
    await loginAs(adminPage, ACCOUNTS.admin);
    await adminPage.goto("/admin");
    const adminTitle = await adminPage.title();

    const gobPage = await gobCtx.newPage();
    await loginAs(gobPage, ACCOUNTS.govtLocal);
    await gobPage.goto("/gob");
    const gobTitle = await gobPage.title();

    expect(gobTitle, `gob="${gobTitle}" vs admin="${adminTitle}"`).not.toBe(adminTitle);
  } finally {
    await adminCtx.close();
    await gobCtx.close();
  }
});
